import { createConnection, type Socket } from "node:net";
import { loadLifecycleConfig } from "../task-lifecycle/config.js";
import { PROTOCOL_VERSION } from "./schema.js";
import type { ReconcileRequest } from "../task-lifecycle/reconciliation.js";
import type { DaemonConfig } from "./config.js";
import { resolveRuntimePaths } from "./files.js";
import { readDaemonHealth } from "./health.js";
import {
  encodeFrame,
  FrameReader,
  parseReconcileRequest,
  parseResponse,
  type ReconcileReply,
} from "./protocol.js";

export class ReconciliationClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class ReconciliationUnknownResultError extends ReconciliationClientError {
  readonly request: Readonly<ReconcileRequest>;
  constructor(request: ReconcileRequest, reason: string) {
    super(
      "unknown_result",
      `reconciliation result unknown (${reason}); retry the same request ID and check binding`,
    );
    this.request = Object.freeze(structuredClone(request));
  }
}

export async function requestReconciliation(
  config: DaemonConfig,
  input: ReconcileRequest,
  signal?: AbortSignal,
  expectedLifecycleVersion?: 1 | 2,
): Promise<ReconcileReply> {
  const request = parseReconcileRequest(input);
  const lifecycleVersion =
    expectedLifecycleVersion ??
    loadLifecycleConfig(config.lifecycleConfigPath).lifecycleWriteVersion ??
    1;
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let socket: Socket | undefined;
    const finish = (error?: Error, reply?: ReconcileReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      socket?.destroy();
      if (error) reject(error);
      else resolve(reply!);
    };
    const unknown = (reason: string) =>
      finish(new ReconciliationUnknownResultError(request, reason));
    const onAbort = () => unknown("client_disconnected");
    const deadline = setTimeout(
      () => unknown("request_timeout"),
      config.limits.requestTimeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void (async () => {
      const health = await readDaemonHealth(config);
      if (settled) return;
      if (health.state !== "available") {
        finish(
          new ReconciliationClientError(
            health.state,
            health.state === "incompatible"
              ? "daemon protocol is incompatible"
              : "reconciliation daemon unavailable; inspect task-reconciler status",
          ),
        );
        return;
      }
      if (
        !health.supportedLifecycleVersions.includes(lifecycleVersion) ||
        health.lifecycleWriteVersion !== lifecycleVersion
      ) {
        finish(
          new ReconciliationClientError(
            "incompatible",
            `daemon cannot write lifecycle version ${lifecycleVersion}`,
          ),
        );
        return;
      }
      const paths = await resolveRuntimePaths(config, false);
      if (settled) return;
      const frame = encodeFrame({
        version: PROTOCOL_VERSION,
        lifecycleVersion,
        kind: "reconcile",
        store: paths.store,
        request,
      });
      const reader = new FrameReader();
      socket = createConnection(paths.socket);
      socket.on("connect", () => {
        if (settled) {
          socket?.destroy();
          return;
        }
        sent = true;
        socket!.write(frame);
      });
      socket.on("data", (chunk: Buffer) => {
        try {
          const value = reader.push(chunk);
          if (value === undefined) return;
          const response = parseResponse(value);
          if (!response.ok) {
            if (response.outcomeUnknown) unknown(response.code);
            else
              finish(
                new ReconciliationClientError(
                  response.code,
                  `reconciliation rejected (${response.code})`,
                ),
              );
            return;
          }
          if (
            response.kind !== "reconcile" ||
            response.reply.requestId !== request.requestId ||
            response.reply.task.id !== request.taskId
          ) {
            unknown("mismatched_response");
            return;
          }
          finish(undefined, response.reply);
        } catch {
          unknown("invalid_response");
        }
      });
      socket.on("error", () => {
        if (sent) unknown("transport_error");
        else
          finish(
            new ReconciliationClientError(
              "unavailable",
              "reconciliation daemon unavailable",
            ),
          );
      });
      socket.on("close", () => {
        if (!settled) unknown("connection_closed");
      });
    })().catch(() => {
      if (sent) unknown("transport_error");
      else
        finish(
          new ReconciliationClientError(
            "unavailable",
            "reconciliation daemon unavailable",
          ),
        );
    });
  });
}
