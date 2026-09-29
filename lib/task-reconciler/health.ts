import type { LockOwner } from "../task-lifecycle/types.js";
import type { DaemonConfig } from "./config.js";
import type { QueueSnapshot } from "./queue.js";
import {
  localPidState,
  readPrivateJson,
  resolveRuntimePaths,
  RuntimeBoundaryError,
  verifyPrivateSocket,
} from "./files.js";
import {
  identifier,
  integer,
  oneOf,
  protocolVersion,
  ProtocolError,
  record,
  text,
  timestamp,
} from "./schema.js";

export type DaemonHealth =
  | { state: "unavailable" | "incompatible"; reason: string }
  | {
      state: "available" | "stale";
      protocolVersion: 1;
      runtimeVersion: string;
      pid: number;
      startedAt: string;
      heartbeatAt: string;
      queue: QueueSnapshot;
    };
export type AvailableDaemonHealth = Extract<
  DaemonHealth,
  { protocolVersion: 1 }
>;
export interface DaemonIdentity {
  version: 1;
  store: string;
  instanceId: string;
  owner: LockOwner;
  runtimeVersion: string;
}

export function parseIdentity(value: unknown, store: string): DaemonIdentity {
  const v = record(value, [
    "version",
    "store",
    "instanceId",
    "owner",
    "runtimeVersion",
  ]);
  protocolVersion(v.version);
  if (v.store !== store)
    throw new RuntimeBoundaryError(
      "store_mismatch",
      "daemon store identity mismatch",
    );
  const o = record(v.owner, ["pid", "sessionId", "host", "started"]);
  return {
    version: 1,
    store,
    instanceId: text(v.instanceId, 128),
    runtimeVersion: text(v.runtimeVersion, 128),
    owner: {
      pid: integer(o.pid, 1),
      sessionId: text(o.sessionId),
      host: text(o.host),
      started: integer(o.started),
    },
  };
}
export function parseDaemonHealth(value: unknown): DaemonHealth {
  if (
    value !== null &&
    typeof value === "object" &&
    "state" in value &&
    (value.state === "unavailable" || value.state === "incompatible")
  ) {
    const v = record(value, ["state", "reason"]);
    return {
      state: oneOf(v.state, ["unavailable", "incompatible"]),
      reason: text(v.reason),
    };
  }
  const v = record(value, [
    "state",
    "protocolVersion",
    "runtimeVersion",
    "pid",
    "startedAt",
    "heartbeatAt",
    "queue",
  ]);
  protocolVersion(v.protocolVersion);
  const q = record(v.queue, [
    "lastScanAttemptAt",
    "lastScanSuccessAt",
    "queued",
    "localRunning",
    "externalRunning",
    "diagnostics",
  ]);
  if (!Array.isArray(q.diagnostics) || q.diagnostics.length > 20)
    throw new ProtocolError("invalid_request", "invalid diagnostic count");
  const diagnostics = q.diagnostics.map((item) => {
    const d = record(
      item,
      ["taskId", "code", "count", "lastSeenAt"],
      ["taskId"],
    );
    const code = text(d.code, 64);
    if (!/^[a-z_]+$/.test(code))
      throw new ProtocolError("invalid_request", "invalid diagnostic code");
    return {
      ...(d.taskId === undefined ? {} : { taskId: identifier(d.taskId) }),
      code,
      count: integer(d.count, 1),
      lastSeenAt: timestamp(d.lastSeenAt),
    };
  });
  return {
    state: oneOf(v.state, ["available", "stale"]),
    protocolVersion: 1,
    runtimeVersion: text(v.runtimeVersion, 128),
    pid: integer(v.pid, 1),
    startedAt: timestamp(v.startedAt),
    heartbeatAt: timestamp(v.heartbeatAt),
    queue: {
      lastScanAttemptAt:
        q.lastScanAttemptAt === null ? null : timestamp(q.lastScanAttemptAt),
      lastScanSuccessAt:
        q.lastScanSuccessAt === null ? null : timestamp(q.lastScanSuccessAt),
      queued: integer(q.queued),
      localRunning: integer(q.localRunning),
      externalRunning: integer(q.externalRunning),
      diagnostics,
    },
  };
}
export async function readDaemonHealth(
  config: DaemonConfig,
): Promise<DaemonHealth> {
  try {
    const paths = await resolveRuntimePaths(config, false);
    await verifyPrivateSocket(paths.socket);
    const identity = parseIdentity(
      await readPrivateJson(paths.identity),
      paths.store,
    );
    const v = record(await readPrivateJson(paths.health), [
      "version",
      "store",
      "instanceId",
      "health",
    ]);
    protocolVersion(v.version);
    if (v.store !== paths.store || v.instanceId !== identity.instanceId)
      throw new RuntimeBoundaryError(
        "identity_mismatch",
        "daemon health identity mismatch",
      );
    const health = parseDaemonHealth(v.health);
    if (!("protocolVersion" in health)) return health;
    if (
      health.pid !== identity.owner.pid ||
      health.runtimeVersion !== identity.runtimeVersion ||
      localPidState(health.pid) !== "live"
    )
      return {
        state: "unavailable",
        reason: "daemon process identity unavailable",
      };
    const age = Date.now() - Date.parse(health.heartbeatAt);
    return {
      ...health,
      state:
        age > config.limits.heartbeatStaleMs || age < -1000
          ? "stale"
          : "available",
    };
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "incompatible")
      return {
        state: "incompatible",
        reason: "daemon protocol is incompatible",
      };
    return {
      state: "unavailable",
      reason:
        error instanceof RuntimeBoundaryError
          ? `daemon unavailable (${error.code})`
          : "daemon health unavailable",
    };
  }
}
