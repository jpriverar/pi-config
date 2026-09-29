import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBeadsDir } from "../beads.js";
import { loadDaemonConfig } from "./config.js";
import { readPrivateJson } from "./files.js";
import { readDaemonHealth, type DaemonHealth } from "./health.js";
import { ReconciliationClientError, requestReconciliation } from "./client.js";
import { safeVersion } from "./runtime-build.js";
import type { ReconcileRequest } from "../task-lifecycle/reconciliation.js";

export const reconcilerSetupGuidance =
  "Use /task-reconciler status; install and start require explicit approval. No local reconciliation fallback is available.";
export function piReconcilerConfigPath(): string {
  return (
    process.env.PI_TASK_RECONCILER_CONFIG ??
    join(homedir(), ".pi/task-reconciler/config.json")
  );
}
async function configuration(store: string) {
  const canonical = await realpath(store);
  let path = piReconcilerConfigPath();
  if (process.env.PI_TASK_RECONCILER_CONFIG === undefined) {
    const key = createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, 16);
    const root = join(homedir(), ".pi/task-reconciler/services", key);
    try {
      const info = await lstat(root);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700
      )
        throw new Error("unowned installation");
      const saved = (await readPrivateJson(
        join(root, "service.json"),
      )) as Record<string, unknown>;
      if (
        saved.version !== 1 ||
        saved.managedBy !== "pi-config:task-reconciler" ||
        saved.uid !== process.getuid?.() ||
        saved.store !== canonical ||
        !safeVersion(saved.currentDeployment)
      )
        throw new Error("invalid installation");
      path = join(root, "runtimes", saved.currentDeployment, "daemon.json");
      await readPrivateJson(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const config = await loadDaemonConfig(path, {
    allowMissingExecutables: true,
  });
  if (config.store !== canonical)
    throw new Error("daemon store does not match Pi store");
  return config;
}
export async function requestPiReconciliation(
  request: ReconcileRequest,
  signal?: AbortSignal,
  store = resolveBeadsDir(),
) {
  let config;
  try {
    config = await configuration(store);
  } catch {
    throw new ReconciliationClientError(
      "unavailable",
      `Reconciliation daemon configuration unavailable. ${reconcilerSetupGuidance}`,
    );
  }
  return requestReconciliation(config, request, signal);
}
const pendingHealth = new Map<string, Promise<DaemonHealth>>();
export async function readPiDaemonHealth(
  store = resolveBeadsDir(),
): Promise<DaemonHealth> {
  let pending = pendingHealth.get(store);
  if (!pending) {
    pending = configuration(store)
      .then(readDaemonHealth)
      .catch(
        (): DaemonHealth => ({
          state: "unavailable",
          reason: "setup_required",
        }),
      );
    pendingHealth.set(store, pending);
    void pending.finally(() => pendingHealth.delete(store));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<DaemonHealth>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({ state: "unavailable", reason: "health_read_timeout" }),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
