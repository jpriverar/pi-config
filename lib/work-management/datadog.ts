import { runBoundedCommand } from "../task-reconciler/commands.js";
import {
  caseUrl,
  decodeTarget,
  LOG_TAG,
  record,
  SITES,
  type NativeTaskComment,
  type RemoteItem,
  type WorkManagementOperation,
  type WorkManagementTarget,
} from "./model.js";

export interface DatadogOperationRequest {
  target: WorkManagementTarget;
  taskId: string;
  operation: WorkManagementOperation;
  initial?: { title: string; description: string; workstream?: string };
  remoteId?: string;
  comment?: NativeTaskComment;
}
export type DatadogOutcome =
  | { kind: "success"; remote?: RemoteItem }
  | { kind: "retryable"; code: string; retryAfterMs?: number }
  | { kind: "rejected"; code: string }
  | { kind: "unknown"; code: string };
export type DatadogPreparation =
  | { kind: "ready"; send(): Promise<DatadogOutcome> }
  | Extract<DatadogOutcome, { kind: "retryable" | "rejected" }>;
export interface DatadogRuntime {
  ddAuthPath: string;
  curlPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  run?: typeof runBoundedCommand;
}

export function syncReference(request: DatadogOperationRequest): string {
  const parts = [
    request.target.orgUuid,
    request.target.projectId,
    request.taskId,
    ...(request.operation.kind === "comment"
      ? ["comment", request.operation.commentId]
      : ["case"]),
  ];
  return `Pi sync: v1/${parts.map(encodeURIComponent).join("/")}`;
}

export function formatCaseDescription(
  request: DatadogOperationRequest,
): string {
  if (!request.initial) throw new Error("missing initial payload");
  return `${request.initial.description}\n\nLocal task: ${request.taskId}\n\n${syncReference(request)}`;
}

export function formatComment(request: DatadogOperationRequest): string {
  const comment = request.comment;
  if (
    request.operation.kind !== "comment" ||
    !comment ||
    comment.id !== request.operation.commentId ||
    comment.issueId !== request.taskId ||
    !comment.text.endsWith(LOG_TAG) ||
    !Number.isFinite(Date.parse(comment.createdAt))
  )
    throw new Error("invalid progress comment");
  return `${comment.text.slice(0, -LOG_TAG.length)}\n\n${comment.createdAt}\n\n${syncReference(request)}`;
}

function payload(request: DatadogOperationRequest): {
  path: string;
  body: unknown;
} {
  const { operation: op, target } = request;
  decodeTarget(target);
  if (op.kind === "create") {
    if (!request.initial?.title.trim())
      throw new Error("missing initial payload");
    return {
      path: "/api/v2/cases",
      body: {
        data: {
          type: "case",
          attributes: {
            title: request.initial.title,
            description: formatCaseDescription(request),
            type_id: target.typeId,
            priority: "NOT_DEFINED",
            status_name: target.statuses.actionable,
            ...(target.workstreamAttributeKey && request.initial.workstream
              ? {
                  custom_attributes: {
                    [target.workstreamAttributeKey]: {
                      type: "TEXT",
                      is_multi: false,
                      value: request.initial.workstream,
                    },
                  },
                }
              : {}),
          },
          relationships: {
            project: { data: { id: target.projectId, type: "project" } },
            ...(target.assigneeId
              ? { assignee: { data: { id: target.assigneeId, type: "user" } } }
              : {}),
          },
        },
      },
    };
  }
  if (!request.remoteId) throw new Error("missing remote ID");
  const path = `/api/v2/cases/${encodeURIComponent(request.remoteId)}`;
  if (op.kind === "status") {
    if (!Object.values(target.statuses).includes(op.statusName))
      throw new Error("unmapped status");
    return {
      path: `${path}/status`,
      body: {
        data: { type: "case", attributes: { status_name: op.statusName } },
      },
    };
  }
  return {
    path: `${path}/comment`,
    body: {
      data: {
        type: "case",
        attributes: {
          comment: formatComment(request),
        },
      },
    },
  };
}

export async function prepareDatadogOperation(
  request: DatadogOperationRequest,
  runtime: DatadogRuntime,
  signal?: AbortSignal,
): Promise<DatadogPreparation> {
  let input: string;
  let url: string;
  try {
    const built = payload(request);
    input = JSON.stringify(built.body);
    url = SITES[request.target.site].api + built.path;
    if (
      Buffer.byteLength(input) > runtime.maxOutputBytes ||
      runtime.timeoutMs < 1000
    )
      throw new Error("invalid request budget");
  } catch {
    return { kind: "rejected", code: "invalid_request" };
  }
  const authenticated = await authenticate(request.target, runtime, signal);
  if (authenticated.kind !== "ready") return authenticated;
  return {
    kind: "ready",
    send: () =>
      sendDatadogOperation(request, authenticated.runtime, input, url, signal),
  };
}

async function authenticate(
  target: WorkManagementTarget,
  runtime: DatadogRuntime,
  signal?: AbortSignal,
): Promise<
  | { kind: "ready"; runtime: DatadogRuntime }
  | Extract<DatadogOutcome, { kind: "retryable" }>
> {
  try {
    if (signal?.aborted) return { kind: "retryable", code: "interrupted" };
    const result = await (runtime.run ?? runBoundedCommand)(
      runtime.ddAuthPath,
      ["--org-uuid", target.orgUuid, "--site", target.site, "--output"],
      {
        env: runtime.env,
        signal,
        timeoutMs: runtime.timeoutMs,
        maxOutputBytes: runtime.maxOutputBytes,
      },
    );
    if (result.code !== 0) throw new Error("authentication unavailable");
    const authEnv: NodeJS.ProcessEnv = {};
    for (const name of ["DD_API_KEY", "DD_APP_KEY"]) {
      const lines = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${name}=`));
      const value = lines[0]?.slice(name.length + 1);
      if (lines.length !== 1 || !value || /[\s\x00-\x1f\x7f]/.test(value))
        throw new Error("invalid credential output");
      authEnv[name] = value;
    }
    return {
      kind: "ready",
      runtime: { ...runtime, env: { ...runtime.env, ...authEnv } },
    };
  } catch {
    return {
      kind: "retryable",
      code: signal?.aborted ? "interrupted" : "authentication_required",
    };
  }
}

export type DatadogReadOutcome =
  | { kind: "success"; body: unknown }
  | Extract<DatadogOutcome, { kind: "retryable" | "rejected" }>;
export type DatadogReaderPreparation =
  | { kind: "ready"; get(path: string): Promise<DatadogReadOutcome> }
  | Extract<DatadogOutcome, { kind: "retryable" | "rejected" }>;

export async function prepareDatadogReader(
  target: WorkManagementTarget,
  runtime: DatadogRuntime,
  signal?: AbortSignal,
): Promise<DatadogReaderPreparation> {
  try {
    decodeTarget(target);
    if (!Number.isSafeInteger(runtime.timeoutMs) || runtime.timeoutMs < 1000)
      throw new Error("invalid observation budget");
  } catch {
    return { kind: "rejected", code: "invalid_request" };
  }
  const deadline = Date.now() + runtime.timeoutMs;
  const prepared = await authenticate(target, runtime, signal);
  if (prepared.kind !== "ready") return prepared;
  // The returned closure keeps credentials out of durable state and diagnostics.
  return {
    kind: "ready",
    async get(path) {
      if (
        /[\x00-\x20\x7f]/.test(path) ||
        !/^\/api\/v2\/cases(?:\/[A-Za-z0-9_-]+(?:\/timelines)?)?(?:\?[^#]*)?$/.test(
          path,
        )
      )
        return { kind: "rejected", code: "invalid_request" };
      if (signal?.aborted) return { kind: "retryable", code: "interrupted" };
      const remaining = deadline - Date.now();
      if (remaining < 1000)
        return { kind: "retryable", code: "observation_timeout" };
      const bounded = { ...prepared.runtime, timeoutMs: remaining };
      try {
        const result = await (bounded.run ?? runBoundedCommand)(
          bounded.curlPath,
          curlArguments(bounded, "GET", SITES[target.site].api + path),
          {
            env: bounded.env,
            signal,
            timeoutMs: remaining,
            maxOutputBytes: bounded.maxOutputBytes,
          },
        );
        if (result.code !== 0)
          return { kind: "retryable", code: "command_failed" };
        const match = /\n(\d{3})\n([^\r\n]*)\r?\n?$/.exec(result.stdout);
        if (!match) return { kind: "retryable", code: "invalid_response" };
        const status = Number(match[1]);
        if (status === 429) return rateLimited(match[2]);
        if (status >= 300 && status < 500 && status !== 408)
          return { kind: "rejected", code: `http_${status}` };
        if (status !== 200)
          return { kind: "retryable", code: `http_${status}` };
        try {
          return {
            kind: "success",
            body: JSON.parse(result.stdout.slice(0, match.index)),
          };
        } catch {
          return { kind: "retryable", code: "invalid_response" };
        }
      } catch {
        return {
          kind: "retryable",
          code: signal?.aborted ? "interrupted" : "read_failed",
        };
      }
    },
  };
}

function rateLimited(
  header: string,
): Extract<DatadogOutcome, { kind: "retryable" }> {
  const delay = /^\d+$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  return {
    kind: "retryable",
    code: "rate_limited",
    ...(Number.isFinite(delay) && delay >= 0 ? { retryAfterMs: delay } : {}),
  };
}

function curlArguments(
  runtime: DatadogRuntime,
  method: "GET" | "POST",
  url: string,
): string[] {
  return [
    "-q",
    "--silent",
    "--show-error",
    "--no-location",
    "--max-redirs",
    "0",
    "--retry",
    "0",
    "--proto",
    "=https",
    "--max-time",
    String(Math.max(0.5, (runtime.timeoutMs - 500) / 1000)),
    "--variable",
    "%DD_API_KEY",
    "--variable",
    "%DD_APP_KEY",
    "--expand-header",
    "DD-API-KEY: {{DD_API_KEY}}",
    "--expand-header",
    "DD-APPLICATION-KEY: {{DD_APP_KEY}}",
    "--header",
    "Content-Type: application/json",
    "--header",
    "Accept: application/json",
    "--request",
    method,
    ...(method === "POST" ? ["--data-binary", "@-"] : []),
    "--write-out",
    "\n%{http_code}\n%header{retry-after}",
    "--url",
    url,
  ];
}

async function sendDatadogOperation(
  request: DatadogOperationRequest,
  runtime: DatadogRuntime,
  input: string,
  url: string,
  signal?: AbortSignal,
): Promise<DatadogOutcome> {
  try {
    const result = await (runtime.run ?? runBoundedCommand)(
      runtime.curlPath,
      curlArguments(runtime, "POST", url),
      {
        env: runtime.env,
        input,
        signal,
        timeoutMs: runtime.timeoutMs,
        maxOutputBytes: runtime.maxOutputBytes,
      },
    );
    if (result.code !== 0) return { kind: "unknown", code: "command_failed" };
    const match = /\n(\d{3})\n([^\r\n]*)\r?\n?$/.exec(result.stdout);
    if (!match) return { kind: "unknown", code: "invalid_response" };
    const status = Number(match[1]);
    if (status === 429) return rateLimited(match[2]);
    if (status >= 300 && status < 500 && status !== 408)
      return { kind: "rejected", code: `http_${status}` };
    const expected = request.operation.kind === "create" ? 201 : 200;
    if (status !== expected) return { kind: "unknown", code: `http_${status}` };
    const body = record(JSON.parse(result.stdout.slice(0, match.index)));
    if (request.operation.kind !== "create") return { kind: "success" };
    const data = record(body.data);
    if (typeof data.id !== "string" || !data.id)
      throw new Error("missing identity");
    const attributes =
      data.attributes === undefined ? {} : record(data.attributes);
    return {
      kind: "success",
      remote: {
        id: data.id,
        ...(typeof attributes.key === "string" ? { key: attributes.key } : {}),
        url: caseUrl(request.target.site, data.id),
      },
    };
  } catch {
    return { kind: "unknown", code: "request_outcome_unknown" };
  }
}
