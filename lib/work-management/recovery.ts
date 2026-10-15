import {
  formatCaseDescription,
  formatComment,
  prepareDatadogReader,
  syncReference,
  type DatadogOperationRequest,
  type DatadogReaderPreparation,
  type DatadogReadOutcome,
  type DatadogRuntime,
} from "./datadog.js";
import { caseUrl, decodeTarget, record, type RemoteItem } from "./model.js";

export type DatadogObservation =
  | { kind: "observed"; remote?: RemoteItem; statusName?: string }
  | { kind: "retryable"; code: string; retryAfterMs?: number }
  | { kind: "attention"; code: string };
type Failure = Exclude<DatadogObservation, { kind: "observed" }>;
type Reader = Extract<DatadogReaderPreparation, { kind: "ready" }>;
interface ObservedCase {
  remote: RemoteItem;
  statusName: string;
}
class BindingMismatch extends Error {}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("invalid remote text");
  return value;
}

function readCase(
  value: unknown,
  request: DatadogOperationRequest,
): ObservedCase {
  const row = record(value);
  const attributes = record(row.attributes);
  const project = record(record(record(row.relationships).project).data);
  const id = text(row.id);
  if (row.type !== "case") throw new Error("invalid case resource");
  if (
    (request.remoteId !== undefined && id !== request.remoteId) ||
    project.type !== "project" ||
    project.id !== request.target.projectId ||
    attributes.type_id !== request.target.typeId
  )
    throw new BindingMismatch();
  return {
    remote: {
      id,
      ...(typeof attributes.key === "string" ? { key: attributes.key } : {}),
      url: caseUrl(request.target.site, id),
    },
    statusName: text(attributes.status_name),
  };
}

function failure(
  result: Exclude<DatadogReadOutcome, { kind: "success" }>,
): Failure {
  return result.kind === "rejected"
    ? { kind: "attention", code: result.code }
    : result;
}

async function scan<T>(
  reader: Reader,
  path: (page: number) => string,
  firstPage: 0 | 1,
  match: (row: Record<string, unknown>) => T | null,
): Promise<{ kind: "complete"; matches: T[] } | Failure> {
  const matches: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < 20; offset++) {
    const page = firstPage + offset;
    const result = await reader.get(path(page));
    if (result.kind !== "success") return failure(result);
    const body = record(result.body);
    if (!Array.isArray(body.data)) throw new Error("invalid remote page");
    if (body.data.length > 50) throw new Error("oversized remote page");
    for (const item of body.data) {
      const row = record(item);
      const id = text(row.id);
      if (seen.has(id))
        return { kind: "retryable", code: "unstable_remote_pagination" };
      seen.add(id);
      const found = match(row);
      if (found !== null) matches.push(found);
    }
    if (body.data.length === 0) return { kind: "complete", matches };
    // Case search is one-based and supplies totals; timelines can omit metadata entirely.
    if (firstPage === 1 && body.meta !== undefined) {
      const pagination = record(record(body.meta).page);
      if (
        pagination.current !== page ||
        pagination.size !== body.data.length ||
        !Number.isSafeInteger(pagination.total) ||
        (pagination.total as number) < page
      )
        throw new Error("invalid case pagination");
      if (pagination.total === page) return { kind: "complete", matches };
    }
  }
  return { kind: "attention", code: "remote_scan_limit" };
}

function unique<T>(matches: T[]): T | Failure {
  return matches.length === 1
    ? matches[0]
    : {
        kind: "attention",
        code:
          matches.length === 0
            ? "remote_delivery_not_found"
            : "multiple_remote_matches",
      };
}

export async function observeDatadogOperation(
  request: DatadogOperationRequest,
  runtime: DatadogRuntime,
  signal?: AbortSignal,
): Promise<DatadogObservation> {
  let expected: string | undefined;
  try {
    decodeTarget(request.target);
    text(request.taskId);
    if (request.operation.kind === "create") {
      formatCaseDescription(request);
      expected = syncReference(request);
    } else {
      text(request.remoteId);
      if (request.operation.kind === "comment")
        expected = formatComment(request);
    }
  } catch {
    return { kind: "attention", code: "invalid_recovery_request" };
  }
  const reader = await prepareDatadogReader(request.target, runtime, signal);
  if (reader.kind !== "ready") return failure(reader);
  try {
    if (request.operation.kind === "create") {
      const result = await scan(
        reader,
        (page) => {
          const query = new URLSearchParams({
            filter: `project_id:${request.target.projectId}`,
            "page[size]": "50",
            "page[number]": String(page),
            "sort[field]": "created_at",
            "sort[asc]": "true",
          });
          return `/api/v2/cases?${query}`;
        },
        1,
        (row) => {
          const description = record(row.attributes).description;
          if (
            typeof description !== "string" ||
            !description.split(/\r?\n/).includes(expected!)
          )
            return null;
          return readCase(row, request);
        },
      );
      if (result.kind !== "complete") return result;
      const found = unique(result.matches);
      return "kind" in found
        ? found
        : {
            kind: "observed",
            remote: found.remote,
            statusName: found.statusName,
          };
    }
    const path = `/api/v2/cases/${encodeURIComponent(request.remoteId!)}`;
    const response = await reader.get(path);
    if (response.kind !== "success") return failure(response);
    const bound = readCase(record(response.body).data, request);
    if (request.operation.kind === "status")
      return { kind: "observed", statusName: bound.statusName };
    const result = await scan(
      reader,
      (page) => {
        const query = new URLSearchParams({
          "page[size]": "50",
          "page[number]": String(page),
          "sort[ascending]": "true",
        });
        return `${path}/timelines?${query}`;
      },
      0,
      (row) => {
        if (row.type !== "timeline_cell")
          throw new Error("invalid timeline resource");
        const attributes = record(row.attributes);
        if (text(attributes.type) !== "COMMENT") return null;
        const message = record(attributes.cell_content).message;
        if (typeof message !== "string")
          throw new Error("invalid comment content");
        return message === expected ? text(row.id) : null;
      },
    );
    if (result.kind !== "complete") return result;
    const found = unique(result.matches);
    return typeof found === "string" ? { kind: "observed" } : found;
  } catch (error) {
    return error instanceof BindingMismatch
      ? { kind: "attention", code: "remote_binding_mismatch" }
      : { kind: "retryable", code: "invalid_remote_response" };
  }
}
