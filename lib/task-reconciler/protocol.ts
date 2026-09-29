import { isAbsolute } from "node:path";
import type {
  ReconcileRequest,
  ReconcileResult,
} from "../task-lifecycle/reconciliation.js";
import type {
  LifecyclePhase,
  LifecycleStatus,
} from "../task-lifecycle/types.js";
import { MAX_PRIVATE_BYTES } from "./files.js";
import { parseDaemonHealth, type DaemonHealth } from "./health.js";
import {
  identifier,
  oneOf,
  protocolVersion,
  ProtocolError,
  record,
  text,
} from "./schema.js";

export const MAX_FRAME_BYTES = MAX_PRIVATE_BYTES;
export const ERROR_CODES = [
  "invalid_frame",
  "invalid_request",
  "incompatible",
  "wrong_store",
  "request_conflict",
  "manual_check_required",
  "check_changed",
  "queue_full",
  "not_running",
  "busy",
  "execution_failed",
  "stopped",
  "internal_error",
] as const;
export type ReplyErrorCode = (typeof ERROR_CODES)[number];
export interface ReconcileReply {
  requestId: string;
  outcome: ReconcileResult["outcome"];
  task: { id: string; status: LifecycleStatus; phase: LifecyclePhase | null };
}
export type ProtocolRequest =
  | { version: 1; store: string; kind: "status" }
  | { version: 1; store: string; kind: "reconcile"; request: ReconcileRequest };
export type ProtocolResponse =
  | { version: 1; ok: false; code: ReplyErrorCode; outcomeUnknown: boolean }
  | { version: 1; ok: true; kind: "status"; health: DaemonHealth }
  | { version: 1; ok: true; kind: "reconcile"; reply: ReconcileReply };

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length === 0 || body.length + 4 > MAX_FRAME_BYTES)
    throw new ProtocolError("invalid_frame", "JSON frame exceeds size limit");
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return frame;
}
export class FrameReader {
  private readonly header = Buffer.alloc(4);
  private headerSize = 0;
  private body?: Buffer;
  private bodySize = 0;
  private done = false;
  push(chunk: Buffer): unknown | undefined {
    if (this.done) {
      if (chunk.length > 0)
        throw new ProtocolError(
          "invalid_frame",
          "multiple frames are not allowed",
        );
      return undefined;
    }
    let offset = 0;
    if (this.headerSize < 4) {
      const size = Math.min(4 - this.headerSize, chunk.length);
      chunk.copy(this.header, this.headerSize, 0, size);
      this.headerSize += size;
      offset += size;
      if (this.headerSize < 4) return undefined;
      const length = this.header.readUInt32BE();
      if (length === 0)
        throw new ProtocolError("invalid_frame", "invalid frame length");
      if (length + 4 > MAX_FRAME_BYTES)
        throw new ProtocolError("invalid_frame", "frame exceeds size limit");
      this.body = Buffer.alloc(length);
    }
    const body = this.body!;
    const size = Math.min(body.length - this.bodySize, chunk.length - offset);
    chunk.copy(body, this.bodySize, offset, offset + size);
    this.bodySize += size;
    offset += size;
    if (offset !== chunk.length)
      throw new ProtocolError(
        "invalid_frame",
        "multiple frames are not allowed",
      );
    if (this.bodySize !== body.length) return undefined;
    this.done = true;
    this.body = undefined;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new ProtocolError("invalid_frame", "invalid JSON frame encoding");
    }
  }
}
export function parseReconcileRequest(value: unknown): ReconcileRequest {
  const v = record(
    value,
    ["requestId", "taskId", "manualOutcome", "expectedCheckFingerprint"],
    ["manualOutcome", "expectedCheckFingerprint"],
  );
  const request: ReconcileRequest = {
    requestId: text(v.requestId),
    taskId: identifier(v.taskId),
  };
  if (v.manualOutcome !== undefined)
    request.manualOutcome = oneOf(v.manualOutcome, [
      "satisfied",
      "action_required",
    ]);
  if (v.expectedCheckFingerprint !== undefined) {
    const fingerprint = text(v.expectedCheckFingerprint, 64);
    if (!/^[0-9a-f]{64}$/.test(fingerprint))
      throw new ProtocolError("invalid_request", "invalid check fingerprint");
    request.expectedCheckFingerprint = fingerprint;
  }
  if (
    request.manualOutcome !== undefined &&
    request.expectedCheckFingerprint === undefined
  )
    throw new ProtocolError(
      "invalid_request",
      "manual outcome requires a check fingerprint",
    );
  return request;
}
export function parseRequest(value: unknown): ProtocolRequest {
  const v = record(value, ["version", "kind", "store", "request"], ["request"]);
  protocolVersion(v.version);
  const store = text(v.store, 4096);
  if (!isAbsolute(store))
    throw new ProtocolError("invalid_request", "store must be absolute");
  const kind = oneOf(v.kind, ["status", "reconcile"]);
  if (kind === "status") {
    if (Object.hasOwn(v, "request"))
      throw new ProtocolError(
        "invalid_request",
        "status cannot contain a task request",
      );
    return { version: 1, kind, store };
  }
  return { version: 1, kind, store, request: parseReconcileRequest(v.request) };
}
export function parseResponse(value: unknown): ProtocolResponse {
  const v = record(
    value,
    ["version", "ok", "code", "outcomeUnknown", "kind", "health", "reply"],
    ["code", "outcomeUnknown", "kind", "health", "reply"],
  );
  protocolVersion(v.version);
  if (v.ok === false) {
    record(v, ["version", "ok", "code", "outcomeUnknown"]);
    if (typeof v.outcomeUnknown !== "boolean")
      throw new ProtocolError("invalid_request", "invalid outcome uncertainty");
    return {
      version: 1,
      ok: false,
      code: oneOf(v.code, ERROR_CODES),
      outcomeUnknown: v.outcomeUnknown,
    };
  }
  if (v.ok !== true)
    throw new ProtocolError("invalid_request", "invalid response status");
  const kind = oneOf(v.kind, ["status", "reconcile"]);
  if (kind === "status") {
    record(v, ["version", "ok", "kind", "health"]);
    return { version: 1, ok: true, kind, health: parseDaemonHealth(v.health) };
  }
  record(v, ["version", "ok", "kind", "reply"]);
  const reply = record(v.reply, ["requestId", "outcome", "task"]);
  const task = record(reply.task, ["id", "status", "phase"]);
  return {
    version: 1,
    ok: true,
    kind,
    reply: {
      requestId: text(reply.requestId),
      outcome: oneOf(reply.outcome, [
        "applied",
        "unchanged",
        "already_applied",
        "stale",
      ]),
      task: {
        id: identifier(task.id),
        status: oneOf(task.status, [
          "open",
          "in_progress",
          "blocked",
          "closed",
        ]),
        phase:
          task.phase === null
            ? null
            : oneOf(task.phase, [
                "actionable",
                "active",
                "waiting",
                "deferred",
                "done",
              ]),
      },
    },
  };
}
