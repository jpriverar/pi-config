import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createTaskLifecycleExtension } from "../extensions/task-lifecycle/index.js";
import {
  loadWorktreePoolRuntime,
  poolGitArguments,
} from "../extensions/worktree-pool/runtime.js";
import { TaskLifecycleService } from "../lib/task-lifecycle/service.js";
import { runBoundedCommand } from "../lib/task-reconciler/commands.js";
import { localPidState } from "../lib/task-reconciler/files.js";
import {
  fixturePolicy,
  MemoryLifecycleStore,
  waitingTask,
} from "../lib/task-reconciler/test-fixtures.js";

async function fixture(t: TestContext, submodule = false) {
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
  const runtime = await loadWorktreePoolRuntime(["repo"], "identity", {
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
  });
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

test("ordinary acquire rejects pending task resources before allocating", async (t) => {
  const h = await fixture(t);
  await h.service.prepareWorktreeRelease(
    h.task.id,
    h.acquired.claimId,
    h.owner,
    "pending-release",
  );
  const writes = h.store.writes;
  const second = await h.acquire("jpriverar/second");
  assert.equal(second.guard?.block, true);
  assert.match(second.guard.reason, /pending worktree association/);
  assert.ok(second.guard.reason.includes(h.acquired.claimId));
  assert.equal(second.acquired, undefined);
  assert.equal(h.store.writes, writes);
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
    1,
  );
});

for (const deinitialized of [false, true]) {
  test(`submodule release preserves ownership before refusal (deinitialized=${deinitialized})`, async (t) => {
    const h = await fixture(t, true);
    await h.mustGit(h.acquired.path, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
    ]);
    if (deinitialized)
      await h.mustGit(h.acquired.path, ["submodule", "deinit", "--all"]);
    assert.equal(
      await h.mustGit(h.acquired.path, ["status", "--porcelain=v1"]),
      "",
    );
    const release = h.event("release", {
      action: "release",
      repository: "repo",
      claimId: h.acquired.claimId,
    });
    assert.equal(await h.hook("tool_call", release), undefined);
    await assert.rejects(
      h.runtime.pool.release("repo", h.acquired.claimId, h.owner),
      /submodule.*unsupported/i,
    );
    await h.hook("tool_result", { ...release, isError: true });
    const listing = (await h.runtime.pool.list("repo")).repositories[0]
      .worktrees[0];
    assert.equal(listing.state, "active");
    assert.equal(listing.evidence.nativeClaimMatches, true);
    assert.equal(listing.clean, true);
    assert.equal(
      (await h.store.show(h.task.id)).lifecycle!.resources[0].cleanupState,
      "release_pending",
    );
    const next = await h.acquire("jpriverar/second");
    assert.equal(next.guard?.block, true);
    assert.equal(
      (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
      1,
    );
    await assert.rejects(
      h.service.prepareReconciliation(
        { taskId: h.task.id, requestId: "normal" },
        h.owner,
      ),
      /worktree release remains pending/,
    );
  });
}

test("preflight store failure blocks allocation without exposing private error text", async (t) => {
  const h = await fixture(t);
  h.store.failTask = h.task.id;
  const result = await h.acquire("jpriverar/second");
  assert.equal(result.guard?.block, true);
  assert.match(result.guard.reason, /unable to verify/);
  assert.doesNotMatch(result.guard.reason, /private fixture/);
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
    1,
  );
});

test("post-allocation revalidation still catches a pending-state race and explains the claim", async (t) => {
  const h = await fixture(t);
  const input = {
    action: "acquire",
    repository: "repo",
    branch: "jpriverar/race",
    startPoint: "main",
  };
  const call = h.event("race", input);
  assert.equal(await h.hook("tool_call", call), undefined);
  await h.service.prepareWorktreeRelease(
    h.task.id,
    h.acquired.claimId,
    h.owner,
    "concurrent-release",
  );
  const allocated = await h.runtime.pool.acquire(input, h.owner);
  const result = await h.hook("tool_result", {
    ...call,
    details: allocated,
    isError: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /pending worktree association/);
  assert.ok(result.content[0].text.includes(h.acquired.claimId));
  assert.ok(result.content[0].text.includes(allocated.claimId));
  assert.match(result.content[0].text, /allocated worktree was not removed/);
  assert.equal((await h.store.show(h.task.id)).lifecycle!.resources.length, 1);
});

test("uninitialized submodules do not block ordinary safe release", async (t) => {
  const h = await fixture(t, true);
  const release = h.event("release-uninitialized", {
    action: "release",
    repository: "repo",
    claimId: h.acquired.claimId,
  });
  assert.equal(await h.hook("tool_call", release), undefined);
  const result = await h.runtime.pool.release(
    "repo",
    h.acquired.claimId,
    h.owner,
  );
  assert.equal(result.released, true);
  assert.equal(
    await h.hook("tool_result", {
      ...release,
      details: result,
      isError: false,
    }),
    undefined,
  );
  assert.equal(
    (await h.store.show(h.task.id)).lifecycle!.resources[0].cleanupState,
    "released",
  );
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
    0,
  );
});

test("dirty submodule contents survive refused cleanup with ownership intact", async (t) => {
  const h = await fixture(t, true);
  await h.mustGit(h.acquired.path, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
  ]);
  const localFile = join(h.acquired.path, "nested", "local.txt");
  await fs.writeFile(localFile, "uncommitted work\n");
  assert.equal(
    (await h.runtime.pool.release("repo", h.acquired.claimId, h.owner))
      .released,
    false,
  );
  assert.equal(await fs.readFile(localFile, "utf8"), "uncommitted work\n");
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees[0].evidence
      .nativeClaimMatches,
    true,
  );
});
