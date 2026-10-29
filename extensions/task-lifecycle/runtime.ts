import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createBeadsClient,
  resolveBeadsDir,
  withBeadsEnvironment,
} from "../../lib/beads.js";
import { createCatalogStore } from "../../lib/work-catalog/store.js";
import { loadWorkManagementConfig } from "../../lib/work-management/config.js";
import { loadLifecycleConfig } from "../../lib/task-lifecycle/config.js";
import { createLifecycleStore } from "../../lib/task-lifecycle/beads-store.js";
import { createCheckAdapterRegistry } from "../../lib/task-lifecycle/checks.js";
import {
  TaskLifecycleService,
  type TaskLifecyclePoolPort,
} from "../../lib/task-lifecycle/service.js";
import type { LockOwner } from "../../lib/task-lifecycle/types.js";
import type { ClaimObservationTransaction } from "../worktree-pool/pool.js";
import { loadWorktreePoolRuntime } from "../worktree-pool/runtime.js";

export function loadTaskLifecyclePolicy() {
  return loadLifecycleConfig(
    fileURLToPath(new URL("./config.json", import.meta.url)),
  );
}

export function createTaskLifecycleRuntime(
  exec: Parameters<typeof withBeadsEnvironment>[0],
  config = loadTaskLifecyclePolicy(),
) {
  const storePath = resolveBeadsDir();
  const execBeads = withBeadsEnvironment(exec);
  const beads = createBeadsClient(execBeads, { env: { BEADS_DIR: storePath } });
  const catalog = createCatalogStore(beads);
  const store = createLifecycleStore(execBeads, {
    store: storePath,
    readWorkManagementConfig: () => loadWorkManagementConfig(storePath),
    readCatalog: () => catalog.read(),
    lifecycleWriteVersion: config.lifecycleWriteVersion,
  });
  const pool = {
    async list(repository?: string) {
      const runtime = await loadWorktreePoolRuntime(
        repository === undefined ? [] : [repository],
        "identity",
      );
      return runtime.pool.list(repository);
    },
    async withClaimObservation<T>(
      repository: string,
      claimId: string,
      owner: LockOwner,
      operation: ClaimObservationTransaction<T>,
    ) {
      const runtime = await loadWorktreePoolRuntime([repository], "identity");
      return runtime.pool.withClaimObservation(
        repository,
        claimId,
        owner,
        operation,
      );
    },
    async acquire(
      request: Parameters<TaskLifecyclePoolPort["acquire"]>[0],
      owner: Parameters<TaskLifecyclePoolPort["acquire"]>[1],
      identity: Parameters<TaskLifecyclePoolPort["acquire"]>[2],
    ) {
      const runtime = await loadWorktreePoolRuntime(
        [request.repository],
        "acquire",
      );
      return runtime.pool.acquire(request, owner, identity);
    },
    async release(
      repository: string,
      claimId: string,
      owner: LockOwner,
      transaction: Parameters<TaskLifecyclePoolPort["release"]>[3],
    ) {
      const runtime = await loadWorktreePoolRuntime([repository], "identity");
      return runtime.pool.release(repository, claimId, owner, transaction);
    },
  };
  const checkAdapters = createCheckAdapterRegistry({
    execGh: async (args) => exec("gh", [...args]),
    now: Date.now,
    prPollIntervalMs: config.prPollIntervalMs,
  });
  const service = new TaskLifecycleService({
    store,
    now: Date.now,
    uuid: randomUUID,
    executionTimeoutMs: config.executionTimeoutMs,
    activityWriteIntervalMs: config.activityWriteIntervalMs,
    prPollIntervalMs: config.prPollIntervalMs,
    maxBackoffMs: config.maxBackoffMs,
    pool,
    checkAdapters,
    lifecycleWriteVersion: config.lifecycleWriteVersion,
  });
  return { config, storePath, beads, catalog, store, service };
}
