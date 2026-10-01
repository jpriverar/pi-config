import type { ClaimObservationTransaction } from "../../extensions/worktree-pool/pool.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  loadWorktreePoolRuntime,
  poolGitArguments,
  type WorktreePoolRuntimeDependencies,
} from "../../extensions/worktree-pool/runtime.js";
import { createLifecycleStore } from "../task-lifecycle/beads-store.js";
import { loadLifecycleConfig } from "../task-lifecycle/config.js";
import {
  TaskLifecycleService,
  type TaskLifecyclePoolPort,
} from "../task-lifecycle/service.js";
import type { LockOwner } from "../task-lifecycle/types.js";
import { runBoundedCommand } from "./commands.js";
import { daemonEnvironment, type DaemonConfig } from "./config.js";
import { createDaemonCheckAdapters } from "./github.js";
import { createReconciler, type Reconciler } from "./queue.js";

export async function createDaemonRuntime(
  config: DaemonConfig,
  owner: LockOwner,
): Promise<Reconciler> {
  const shutdown = new AbortController();
  const policy = loadLifecycleConfig(config.lifecycleConfigPath);
  const env = daemonEnvironment(config);
  const commandOptions = {
    env,
    signal: shutdown.signal,
    timeoutMs: config.limits.commandTimeoutMs,
    maxOutputBytes: config.limits.maxOutputBytes,
  };
  const operationLock = {
    now: Date.now,
    sleep: async (ms: number) => {
      await sleep(ms, undefined, { signal: shutdown.signal });
    },
    isPidAlive: (pid: number): "live" | "dead" | "ambiguous" => {
      try {
        process.kill(pid, 0);
        return "live";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ESRCH"
          ? "dead"
          : code === "EPERM"
            ? "live"
            : "ambiguous";
      }
    },
    hostname: owner.host,
    timeoutMs: 5000,
  };
  const store = createLifecycleStore(
    async (command, args) => {
      if (command !== "bd") throw new Error("unsupported lifecycle command");
      return runBoundedCommand(config.executables.bd, args, commandOptions);
    },
    { store: config.store, lockDependencies: operationLock },
  );
  const poolDependencies: WorktreePoolRuntimeDependencies = {
    configPath: config.poolConfigPath,
    home: env.HOME ?? homedir(),
    realpath,
    operationLock,
    uuid: randomUUID,
    runGit: (cwd, args) =>
      runBoundedCommand(
        config.executables.git,
        poolGitArguments(cwd, args),
        commandOptions,
      ),
  };
  const pool: TaskLifecyclePoolPort = {
    async list(repository) {
      const runtime = await loadWorktreePoolRuntime(
        repository === undefined ? [] : [repository],
        "identity",
        poolDependencies,
      );
      return runtime.pool.list(repository);
    },
    async withClaimObservation<T>(
      repository: string,
      claimId: string,
      claimOwner: LockOwner,
      operation: ClaimObservationTransaction<T>,
    ) {
      const runtime = await loadWorktreePoolRuntime(
        [repository],
        "identity",
        poolDependencies,
      );
      return runtime.pool.withClaimObservation(
        repository,
        claimId,
        claimOwner,
        operation,
      );
    },
    async acquire() {
      throw new Error("reconciliation daemon cannot acquire worktrees");
    },
    async release(repository, claimId, claimOwner, transaction) {
      const runtime = await loadWorktreePoolRuntime(
        [repository],
        "identity",
        poolDependencies,
      );
      return runtime.pool.release(repository, claimId, claimOwner, transaction);
    },
  };
  const service = new TaskLifecycleService({
    store,
    pool,
    now: Date.now,
    uuid: randomUUID,
    executionTimeoutMs: policy.executionTimeoutMs,
    activityWriteIntervalMs: policy.activityWriteIntervalMs,
    prPollIntervalMs: policy.prPollIntervalMs,
    maxBackoffMs: policy.maxBackoffMs,
  });
  return createReconciler({
    store,
    service,
    adapters: createDaemonCheckAdapters(config),
    owner,
    config,
    now: Date.now,
    abortLocalCommands: () => shutdown.abort(),
  });
}
