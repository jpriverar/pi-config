import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { hostname } from "node:os";
import { withFileOperationLock } from "../file-operation-lock.js";
import { ReconciliationRequestError } from "../task-lifecycle/reconciliation.js";
import type { LockOwner } from "../task-lifecycle/types.js";
import type { DaemonConfig } from "./config.js";
import {
  localPidState,
  readPrivateJson,
  resolveRuntimePaths,
  RuntimeBoundaryError,
  verifyPrivateSocket,
  writePrivateJson,
  type RuntimePaths,
} from "./files.js";
import {
  parseDaemonHealth,
  parseIdentity,
  type AvailableDaemonHealth,
  type DaemonIdentity,
} from "./health.js";
import {
  encodeFrame,
  FrameReader,
  parseRequest,
  type ProtocolResponse,
} from "./protocol.js";
import { ReconciliationQueueError, type Reconciler } from "./queue.js";
import { ProtocolError, record } from "./schema.js";

declare const __TASK_RECONCILER_VERSION__: string;
export const RUNTIME_VERSION =
  typeof __TASK_RECONCILER_VERSION__ === "string"
    ? __TASK_RECONCILER_VERSION__
    : "source-unbuilt";
const MAX_CLIENTS = 100;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function previousOwner(paths: RuntimePaths): Promise<void> {
  if (!(await exists(paths.identity))) {
    if ((await exists(paths.socket)) || (await exists(paths.health)))
      throw new RuntimeBoundaryError(
        "unowned_endpoint",
        "daemon endpoints have no verified owner",
      );
    return;
  }
  const previous = parseIdentity(
    await readPrivateJson(paths.identity),
    paths.store,
  );
  if (
    previous.owner.host !== hostname() ||
    localPidState(previous.owner.pid) !== "dead"
  )
    throw new RuntimeBoundaryError(
      "owner_unavailable",
      "daemon owner is live or ambiguous",
    );
  if (await exists(paths.socket)) {
    await verifyPrivateSocket(paths.socket);
    await unlink(paths.socket);
  }
  if (await exists(paths.health)) {
    const saved = record(await readPrivateJson(paths.health), [
      "version",
      "store",
      "instanceId",
      "health",
    ]);
    if (saved.store !== paths.store || saved.instanceId !== previous.instanceId)
      throw new RuntimeBoundaryError(
        "unowned_health",
        "daemon health has an unverified owner",
      );
    await unlink(paths.health);
  }
}
async function removeOwnedFiles(
  paths: RuntimePaths,
  identity: DaemonIdentity,
): Promise<void> {
  let current: DaemonIdentity;
  try {
    current = parseIdentity(await readPrivateJson(paths.identity), paths.store);
  } catch {
    return;
  }
  if (current.instanceId !== identity.instanceId) return;
  try {
    const saved = record(await readPrivateJson(paths.health), [
      "version",
      "store",
      "instanceId",
      "health",
    ]);
    if (saved.store === paths.store && saved.instanceId === identity.instanceId)
      await unlink(paths.health);
  } catch {
    /* Unverifiable files are preserved rather than deleted. */
  }
  await unlink(paths.identity);
}

export async function serveReconciler(
  config: DaemonConfig,
  reconciler: Reconciler,
  owner: LockOwner,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (owner.pid !== process.pid || owner.host !== hostname())
    throw new RuntimeBoundaryError(
      "invalid_owner",
      "daemon owner must match the current local process",
    );
  const paths = await resolveRuntimePaths(config, true);
  let entered = false;
  try {
    await withFileOperationLock(
      paths.lockRoot,
      owner,
      async () => {
        entered = true;
        await previousOwner(paths);
        const identity = parseIdentity(
          {
            version: 1,
            store: paths.store,
            instanceId: randomUUID(),
            owner,
            runtimeVersion: RUNTIME_VERSION,
          },
          paths.store,
        );
        const clients = new Set<Socket>();
        const admissions = new Set<Socket>();
        const handlers = new Set<Promise<void>>();
        let closing = false;
        let started = false;
        let ownsIdentity = false;
        let heartbeatTimer: NodeJS.Timeout | undefined;
        let heartbeatWrite: Promise<void> | undefined;
        let failure: Error | undefined;
        let wake!: () => void;
        const stopped = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const onAbort = () => {
          closing = true;
          wake();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        const health = (): AvailableDaemonHealth =>
          parseDaemonHealth({
            state: "available",
            protocolVersion: 1,
            runtimeVersion: RUNTIME_VERSION,
            pid: owner.pid,
            startedAt: new Date(owner.started).toISOString(),
            heartbeatAt: new Date().toISOString(),
            queue: reconciler.snapshot(),
          }) as AvailableDaemonHealth;
        const publish = () =>
          writePrivateJson(paths.health, {
            version: 1,
            store: paths.store,
            instanceId: identity.instanceId,
            health: health(),
          });
        function respond(socket: Socket, response: ProtocolResponse): void {
          if (socket.destroyed) return;
          try {
            socket.end(encodeFrame(response));
          } catch {
            socket.destroy();
          }
        }
        const server = createServer((socket) => {
          socket.on("error", () => socket.destroy());
          if (closing || admissions.size >= MAX_CLIENTS) {
            respond(socket, {
              version: 1,
              ok: false,
              code: closing ? "not_running" : "busy",
              outcomeUnknown: false,
            });
            socket.destroySoon();
            return;
          }
          clients.add(socket);
          admissions.add(socket);
          let dispatched = false;
          const reader = new FrameReader();
          const deadline = setTimeout(
            () => socket.destroy(),
            config.limits.requestTimeoutMs,
          );
          socket.on("close", () => {
            clearTimeout(deadline);
            clients.delete(socket);
            if (!dispatched) admissions.delete(socket);
          });
          socket.on("data", (chunk: Buffer) => {
            if (dispatched) {
              socket.destroy();
              return;
            }
            try {
              const value = reader.push(chunk);
              if (value === undefined) return;
              const message = parseRequest(value);
              if (message.store !== paths.store) {
                respond(socket, {
                  version: 1,
                  ok: false,
                  code: "wrong_store",
                  outcomeUnknown: false,
                });
                return;
              }
              dispatched = true;
              const work = (async () => {
                try {
                  if (message.kind === "status")
                    respond(socket, {
                      version: 1,
                      ok: true,
                      kind: "status",
                      health: health(),
                    });
                  else {
                    const result = await reconciler.reconcile(message.request);
                    if (result.issue.id !== message.request.taskId)
                      throw new Error("mismatched result identity");
                    respond(socket, {
                      version: 1,
                      ok: true,
                      kind: "reconcile",
                      reply: {
                        requestId: message.request.requestId,
                        outcome: result.outcome,
                        task: {
                          id: result.issue.id,
                          status: result.issue.status,
                          phase: result.issue.lifecycle?.phase ?? null,
                        },
                      },
                    });
                  }
                } catch (error) {
                  if (error instanceof ReconciliationRequestError)
                    respond(socket, {
                      version: 1,
                      ok: false,
                      code: error.code,
                      outcomeUnknown: false,
                    });
                  else if (error instanceof ReconciliationQueueError)
                    respond(socket, {
                      version: 1,
                      ok: false,
                      code: error.code,
                      outcomeUnknown: error.outcomeUnknown,
                    });
                  else
                    respond(socket, {
                      version: 1,
                      ok: false,
                      code: "execution_failed",
                      outcomeUnknown: true,
                    });
                } finally {
                  admissions.delete(socket);
                }
              })();
              handlers.add(work);
              void work.finally(() => handlers.delete(work));
            } catch (error) {
              respond(socket, {
                version: 1,
                ok: false,
                code:
                  error instanceof ProtocolError ? error.code : "invalid_frame",
                outcomeUnknown: false,
              });
              socket.destroySoon();
            }
          });
        });
        server.maxConnections = MAX_CLIENTS;
        server.on("error", () => {
          failure = new RuntimeBoundaryError(
            "server_failed",
            "daemon socket failed",
          );
          closing = true;
          wake();
        });
        try {
          if (closing) return;
          await writePrivateJson(paths.identity, identity);
          ownsIdentity = true;
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(paths.socket, () => {
              server.off("error", reject);
              resolve();
            });
          });
          await chmod(paths.socket, 0o600);
          if (closing) return;
          started = true;
          reconciler.start();
          await publish();
          heartbeatTimer = setInterval(() => {
            if (heartbeatWrite || closing) return;
            heartbeatWrite = publish()
              .catch(() => {
                failure = new RuntimeBoundaryError(
                  "health_failed",
                  "daemon health publication failed",
                );
                closing = true;
                wake();
              })
              .finally(() => {
                heartbeatWrite = undefined;
              });
          }, config.limits.heartbeatIntervalMs);
          await stopped;
          if (failure) throw failure;
        } finally {
          closing = true;
          clearInterval(heartbeatTimer);
          signal.removeEventListener("abort", onAbort);
          try {
            if (started) await reconciler.stop();
          } finally {
            await heartbeatWrite;
            for (const socket of clients) socket.destroy();
            await Promise.allSettled([...handlers]);
            if (server.listening)
              await new Promise<void>((resolve) =>
                server.close(() => resolve()),
              );
            if (ownsIdentity) await removeOwnedFiles(paths, identity);
          }
        }
      },
      {
        now: Date.now,
        sleep: async () => {
          throw new Error("daemon singleton must not wait");
        },
        isPidAlive: localPidState,
        hostname: hostname(),
        timeoutMs: 0,
      },
    );
  } catch (error) {
    if (!entered)
      throw new RuntimeBoundaryError(
        "owner_unavailable",
        "daemon singleton owner is live or ambiguous",
      );
    throw error;
  }
}
