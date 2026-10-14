import type {
  LifecycleIssue,
  LifecycleMetadataV1,
  LockOwner,
} from "../task-lifecycle/types.js";

export const LOG_TAG = "\n\n[pi-task-log:v1]";
export const SITES: Readonly<Record<string, { api: string; app: string }>> = {
  "datadoghq.com": {
    api: "https://api.datadoghq.com",
    app: "https://app.datadoghq.com",
  },
  "datadoghq.eu": {
    api: "https://api.datadoghq.eu",
    app: "https://app.datadoghq.eu",
  },
  "us3.datadoghq.com": {
    api: "https://api.us3.datadoghq.com",
    app: "https://us3.datadoghq.com",
  },
  "us5.datadoghq.com": {
    api: "https://api.us5.datadoghq.com",
    app: "https://us5.datadoghq.com",
  },
  "ap1.datadoghq.com": {
    api: "https://api.ap1.datadoghq.com",
    app: "https://ap1.datadoghq.com",
  },
  "ap2.datadoghq.com": {
    api: "https://api.ap2.datadoghq.com",
    app: "https://ap2.datadoghq.com",
  },
  "uk1.datadoghq.com": {
    api: "https://api.uk1.datadoghq.com",
    app: "https://uk1.datadoghq.com",
  },
};
export const STATUS_KEYS = [
  "actionable",
  "active",
  "waiting",
  "deferred",
  "completed",
  "cancelled",
  "superseded",
] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];
export interface WorkManagementTarget {
  site: string;
  orgUuid: string;
  projectId: string;
  typeId: string;
  assigneeId?: string;
  workstreamAttributeKey?: string;
  statuses: Record<StatusKey, string> & { waitingOnPullRequest?: string };
}
export interface WorkManagementConfig {
  version: 1;
  ddAuthPath: string;
  curlPath: string;
  defaultTarget?: WorkManagementTarget;
  workstreams: Record<string, WorkManagementTarget | null>;
}
export type WorkManagementOperation =
  | { kind: "create" }
  | { kind: "status"; statusName: string }
  | { kind: "comment"; commentId: string };
export interface RemoteItem {
  id: string;
  key?: string;
  url: string;
}
export interface WorkManagementState {
  version: 1;
  target: WorkManagementTarget;
  initial: { title: string; description: string; workstream?: string };
  remote: RemoteItem | null;
  lastSentStatus: string | null;
  deliveredCommentIds: string[];
  inFlight: WorkManagementOperation | null;
  failure: {
    kind: "retryable" | "attention";
    code: string;
    count: number;
    retryAt: number | null;
  } | null;
}
export interface NativeTaskComment {
  id: string;
  issueId: string;
  text: string;
  createdAt: string;
}
export interface WorkManagementStore {
  comments(taskId: string): Promise<NativeTaskComment[]>;
  mutateWorkManagement(
    taskId: string,
    owner: LockOwner,
    update: (issue: LifecycleIssue) => WorkManagementState | null,
  ): Promise<LifecycleIssue>;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected work management object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("invalid work management identifier");
  return value;
}
export function decodeTarget(value: unknown): WorkManagementTarget {
  const r = record(value);
  const site = text(r.site);
  if (!Object.hasOwn(SITES, site)) throw new Error("unsupported Datadog site");
  const uuid = (v: unknown) => {
    const s = text(v);
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s))
      throw new Error("invalid Datadog UUID");
    return s;
  };
  const rawStatuses = record(r.statuses);
  const statuses = Object.fromEntries(
    STATUS_KEYS.map((k) => [k, text(rawStatuses[k])]),
  ) as WorkManagementTarget["statuses"];
  if (Object.hasOwn(rawStatuses, "waitingOnPullRequest"))
    statuses.waitingOnPullRequest = text(rawStatuses.waitingOnPullRequest);
  return {
    site,
    orgUuid: uuid(r.orgUuid),
    projectId: uuid(r.projectId),
    typeId: uuid(r.typeId),
    ...(Object.hasOwn(r, "assigneeId")
      ? { assigneeId: uuid(r.assigneeId) }
      : {}),
    ...(Object.hasOwn(r, "workstreamAttributeKey")
      ? { workstreamAttributeKey: text(r.workstreamAttributeKey) }
      : {}),
    statuses,
  };
}
export function caseUrl(site: string, id: string): string {
  if (!Object.hasOwn(SITES, site)) throw new Error("unsupported Datadog site");
  return `${SITES[site].app}/cases/${encodeURIComponent(text(id))}`;
}
export function newWorkManagementState(
  target: WorkManagementTarget,
  title: string,
  description: string,
  workstream?: string,
): WorkManagementState {
  return {
    version: 1,
    target: decodeTarget(target),
    initial: {
      title,
      description,
      ...(workstream === undefined ? {} : { workstream: text(workstream) }),
    },
    remote: null,
    lastSentStatus: null,
    deliveredCommentIds: [],
    inFlight: null,
    failure: null,
  };
}
export function decodeWorkManagement(
  value: unknown,
): WorkManagementState | null {
  if (value === undefined) return null;
  const r = record(value);
  if (r.version !== 1) throw new Error("unsupported work management state");
  const target = decodeTarget(r.target);
  const initial = record(r.initial);
  if (
    typeof initial.title !== "string" ||
    !initial.title.trim() ||
    typeof initial.description !== "string"
  )
    throw new Error("invalid work management initial payload");
  let remote: RemoteItem | null = null;
  if (r.remote !== null) {
    const raw = record(r.remote);
    const id = text(raw.id);
    if (raw.url !== caseUrl(target.site, id))
      throw new Error("invalid work management link");
    remote = {
      id,
      url: raw.url,
      ...(raw.key === undefined ? {} : { key: text(raw.key) }),
    };
  }
  const lastSentStatus =
    r.lastSentStatus === null ? null : text(r.lastSentStatus);
  if (!Array.isArray(r.deliveredCommentIds))
    throw new Error("invalid delivered comment IDs");
  const deliveredCommentIds = r.deliveredCommentIds.map(text);
  if (new Set(deliveredCommentIds).size !== deliveredCommentIds.length)
    throw new Error("duplicate delivered comment IDs");
  let inFlight: WorkManagementOperation | null = null;
  if (r.inFlight !== null) {
    const op = record(r.inFlight);
    if (op.kind === "create") inFlight = { kind: "create" };
    else if (op.kind === "status")
      inFlight = { kind: "status", statusName: text(op.statusName) };
    else if (op.kind === "comment")
      inFlight = { kind: "comment", commentId: text(op.commentId) };
    else throw new Error("invalid work management operation");
  }
  let failure: WorkManagementState["failure"] = null;
  if (r.failure !== null) {
    const f = record(r.failure);
    if (
      (f.kind !== "attention" && f.kind !== "retryable") ||
      !Number.isSafeInteger(f.count) ||
      (f.count as number) < 1 ||
      (f.retryAt !== null &&
        (!Number.isFinite(f.retryAt) || (f.retryAt as number) < 0))
    )
      throw new Error("invalid work management failure");
    failure = {
      kind: f.kind,
      code: text(f.code),
      count: f.count as number,
      retryAt: f.retryAt as number | null,
    };
  }
  return {
    version: 1,
    target,
    initial: {
      title: initial.title,
      description: initial.description,
      ...(Object.hasOwn(initial, "workstream")
        ? { workstream: text(initial.workstream) }
        : {}),
    },
    remote,
    lastSentStatus,
    deliveredCommentIds,
    inFlight,
    failure,
  };
}

export function desiredWorkManagementStatus(
  target: WorkManagementTarget,
  lifecycle: LifecycleMetadataV1 | null,
): string | null {
  if (
    lifecycle?.phase === "waiting" &&
    lifecycle.waiting?.kind === "check" &&
    lifecycle.activeCheck?.kind === "github_pull_request"
  )
    return target.statuses.waitingOnPullRequest ?? target.statuses.waiting;
  const key =
    lifecycle?.phase === "done"
      ? lifecycle.disposition?.kind
      : lifecycle?.phase;
  return key ? target.statuses[key] : null;
}

export function summarizeWorkManagement(
  metadata: Record<string, unknown>,
  lifecycle: LifecycleMetadataV1 | null,
): {
  url?: string;
  text: string;
  auth?: { command: string; required: boolean };
} | null {
  try {
    const state = decodeWorkManagement(metadata.piWorkManagement);
    if (!state) return null;
    let text = "WM linked";
    if (state.failure?.kind === "attention") text = "WM attention";
    else if (state.failure?.code === "authentication_required")
      text = "WM login needed";
    else if (state.failure) text = "WM retry pending";
    else if (state.inFlight) text = `WM pending ${state.inFlight.kind}`;
    else if (!state.remote) text = "WM pending create";
    else {
      const desired = desiredWorkManagementStatus(state.target, lifecycle);
      if (!desired) text = "WM attention";
      else if (state.lastSentStatus !== desired) text = "WM pending status";
    }
    return {
      text,
      auth: {
        command: `dd-auth --org-uuid ${state.target.orgUuid} --site ${state.target.site} -- true`,
        required: state.failure?.code === "authentication_required",
      },
      ...(state.remote ? { url: state.remote.url } : {}),
    };
  } catch {
    return { text: "WM attention: invalid state" };
  }
}
