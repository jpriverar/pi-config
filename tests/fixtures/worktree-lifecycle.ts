import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createTaskLifecycleExtension } from "../../extensions/task-lifecycle/index.js";
import {
  loadWorktreePoolRuntime,
  poolGitArguments,
  type WorktreePoolRuntimeDependencies,
} from "../../extensions/worktree-pool/runtime.js";
import { TaskLifecycleService } from "../../lib/task-lifecycle/service.js";
import { runBoundedCommand } from "../../lib/task-reconciler/commands.js";
import { localPidState } from "../../lib/task-reconciler/files.js";
import {
  fixturePolicy,
  MemoryLifecycleStore,
  waitingTask,
} from "../../lib/task-reconciler/test-fixtures.js";

export async function createWorktreeLifecycleFixture(
  t: TestContext,
  submodule = false,
) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-worktree-guards-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repos = join(root, "repos");
  const repo = join(repos, "repo");
  const env = {
    HOME: root,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, args: string[]) =>
    runBoundedCommand("/usr/bin/git", poolGitArguments(cwd, args), { env });
  const mustGit = async (cwd: string, args: string[]) => {
    const result = await git(cwd, args);
    assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const init = async (path: string) => {
    await fs.mkdir(path, { recursive: true });
    await mustGit(path, ["init", "-b", "main"]);
    await mustGit(path, ["config", "user.name", "Lifecycle Fixture"]);
    await mustGit(path, ["config", "user.email", "fixture@example.invalid"]);
    await fs.writeFile(join(path, "README.md"), "fixture\n");
    await mustGit(path, ["add", "README.md"]);
    await mustGit(path, ["commit", "-m", "fixture"]);
  };
  await init(repo);
  if (submodule) {
    const child = join(root, "child");
    await init(child);
    await mustGit(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      child,
      "nested",
    ]);
    await mustGit(repo, ["commit", "-m", "fixture submodule"]);
  }
  const configPath = join(root, "pool.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 2,
      root: join(root, "pool"),
      repositoryRoot: repos,
      defaultCapacity: 3,
      exclude: [],
      repositories: [],
    }),
  );
  const runtimeDependencies: WorktreePoolRuntimeDependencies = {
    configPath,
    home: root,
    realpath: fs.realpath,
    runGit: git,
    uuid: randomUUID,
    operationLock: {
      hostname: hostname(),
      now: Date.now,
      sleep: delay,
      isPidAlive: localPidState,
      timeoutMs: 5000,
    },
  };
  const runtime = await loadWorktreePoolRuntime(
    ["repo"],
    "identity",
    runtimeDependencies,
  );
  const now = Date.now();
  const owner = {
    pid: process.pid,
    host: hostname(),
    started: now,
    sessionId: "fixture-owner",
  };
  const task = waitingTask("fixture-task");
  task.status = "in_progress";
  Object.assign(task.lifecycle!, {
    phase: "active",
    waiting: null,
    activeCheck: null,
    execution: {
      sessionId: owner.sessionId,
      claimedAt: new Date(now).toISOString(),
      lastActivityAt: new Date(now).toISOString(),
      expiresAt: new Date(now + fixturePolicy.executionTimeoutMs).toISOString(),
      resourceSnapshot: {
        observedAt: new Date(now).toISOString(),
        resourceIds: [],
      },
    },
  });
  const store = new MemoryLifecycleStore([task]);
  const service = new TaskLifecycleService({
    store,
    pool: runtime.pool,
    ...fixturePolicy,
    now: () => now,
    uuid: randomUUID,
  });
  const handlers = new Map<string, Array<(event: any, context: any) => any>>();
  createTaskLifecycleExtension({
    service,
    now: () => now,
    pid: process.pid,
    hostname: hostname(),
    activityWriteIntervalMs: fixturePolicy.activityWriteIntervalMs,
    sessionReconcileLimit: fixturePolicy.sessionReconcileLimit,
    sessionPrCheckLimit: fixturePolicy.sessionPrCheckLimit,
  })({
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {},
    sendMessage() {},
  } as any);
  const context = {
    cwd: repo,
    sessionManager: {
      getSessionId: () => owner.sessionId,
      getBranch: () => [],
      getEntries: () => [],
      getSessionName: () => undefined,
    },
    ui: { notify() {} },
  };
  const event = (id: string, input: Record<string, string>) => ({
    toolCallId: id,
    toolName: "worktree_pool",
    input,
  });
  const hook = async (name: string, input: any) => {
    const callbacks = handlers.get(name)!;
    assert.equal(callbacks.length, 1);
    return await callbacks[0](input, context);
  };
  const acquire = async (branch: string) => {
    const input = {
      action: "acquire",
      repository: "repo",
      branch,
      startPoint: "main",
    };
    const call = event(`acquire-${branch}`, input);
    const guard = await hook("tool_call", call);
    if (guard?.block) return { guard, acquired: undefined };
    const acquired = await runtime.pool.acquire(input, owner);
    assert.equal(
      await hook("tool_result", { ...call, details: acquired, isError: false }),
      undefined,
    );
    return { guard, acquired };
  };
  const acquired = (await acquire("jpriverar/first")).acquired!;
  return {
    runtime,
    runtimeDependencies,
    store,
    service,
    owner,
    task,
    repo,
    root,
    acquired,
    acquire,
    event,
    hook,
    mustGit,
  };
}
