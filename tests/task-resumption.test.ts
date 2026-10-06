import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createTaskLifecycleExtension } from "../extensions/task-lifecycle/index.js";
import { createWorktreePoolExtension } from "../extensions/worktree-pool/index.js";
import { loadWorktreePoolRuntime } from "../extensions/worktree-pool/runtime.js";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";
import { TaskLifecycleService } from "../lib/task-lifecycle/service.js";
import type { LifecycleIssue } from "../lib/task-lifecycle/types.js";
import { fixturePolicy } from "../lib/task-reconciler/test-fixtures.js";
import { createWorktreeLifecycleFixture as fixture } from "./fixtures/worktree-lifecycle.js";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const obstacle of ["initialized-submodule", "dirty-work"] as const) {
  test(
    `normal acquisition preserves ${obstacle} after legacy cleanup reservations`,
    { timeout: 120_000 },
    async (t) => {
      const h = await fixture(t, obstacle === "initialized-submodule");
      if (obstacle === "initialized-submodule") {
        await h.mustGit(h.acquired.path, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "update",
          "--init",
        ]);
      } else {
        await fs.writeFile(
          join(h.acquired.path, "local.txt"),
          "uncommitted work\n",
        );
      }
      const second = (await h.acquire("jpriverar/second")).acquired!;
      const store = lockedStore(
        h,
        await h.store.show(h.task.id),
        () => {},
        () => {},
      );
      const before = await h.runtime.pool.list("repo");
      const submoduleBefore = await h.mustGit(h.acquired.path, [
        "submodule",
        "status",
      ]);
      const original = (await store.show(h.task.id)).lifecycle!.execution!;
      const now = Date.parse(original.expiresAt) + 1_000;
      const resumed = new TaskLifecycleService({
        store,
        pool: h.runtime.pool,
        ...fixturePolicy,
        now: () => now,
        uuid: randomUUID,
      });
      const daemon = { ...h.owner, sessionId: "fixture-reconciler" };
      await resumed.prepareWorktreeRelease(
        h.task.id,
        h.acquired.claimId,
        h.owner,
        `execution-interrupted:${original.sessionId}:${original.expiresAt}:release:${h.acquired.claimId}`,
      );
      const observed = await resumed.reconcileTask(h.task.id, daemon);
      assert.deepEqual(observed.lifecycle!.execution, original);
      const pending = (await store.show(h.task.id)).lifecycle!.resources;
      assert.deepEqual(
        pending.map((resource) => resource.cleanupState),
        ["active", "active"],
      );

      const claimed = await resumed.claim(h.task.id, h.owner, "resume");
      assert.equal(claimed.lifecycle!.execution!.sessionId, h.owner.sessionId);
      assert.equal(claimed.lifecycle!.execution!.claimedAt, original.claimedAt);
      assert.ok(Date.parse(claimed.lifecycle!.execution!.expiresAt) > now);
      assert.deepEqual(claimed.lifecycle!.resources, pending);
      const acquired = await resumed.acquireWorktree(
        {
          taskId: h.task.id,
          repository: "repo",
          branch: "jpriverar/resumed",
          startPoint: "main",
        },
        h.owner,
        "normal-acquire",
      );

      assert.deepEqual(
        acquired.lifecycle!.resources.map((resource) => resource.cleanupState),
        ["active", "active", "active"],
      );
      const after = await h.runtime.pool.list("repo");
      for (const claim of [h.acquired, second]) {
        assert.deepEqual(
          after.repositories[0].worktrees.find(
            (row) => row.claimId === claim.claimId,
          ),
          before.repositories[0].worktrees.find(
            (row) => row.claimId === claim.claimId,
          ),
        );
        assert.equal(
          await h.mustGit(claim.path, ["rev-parse", "HEAD"]),
          claim.head,
        );
      }
      assert.equal(
        await h.mustGit(h.acquired.path, ["submodule", "status"]),
        submoduleBefore,
      );
      if (obstacle === "dirty-work")
        assert.equal(
          await fs.readFile(join(h.acquired.path, "local.txt"), "utf8"),
          "uncommitted work\n",
        );
      const reconciled = await resumed.prepareReconciliation(
        { taskId: h.task.id, requestId: "ordinary-reconcile" },
        daemon,
      );
      assert.equal(reconciled.kind, "complete");
    },
  );
}

function lockedStore(
  h: Awaited<ReturnType<typeof fixture>>,
  initial: LifecycleIssue,
  onPending: () => void,
  onWait: () => void,
) {
  let raw = {
    id: initial.id,
    title: initial.title,
    status: initial.status,
    metadata: initial.metadata,
    dependencies: [],
  };
  return createLifecycleStore(
    async (_command, args) => {
      if (args[0] === "update") {
        raw = {
          ...raw,
          status: args[args.indexOf("-s") + 1] as typeof raw.status,
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
        };
        if (
          (
            raw.metadata.piLifecycle as LifecycleIssue["lifecycle"]
          )?.resources.some(
            (resource) => resource.cleanupState === "release_pending",
          )
        )
          onPending();
      }
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(args[0] === "ready" ? [] : [raw]),
      };
    },
    {
      store: join(h.root, "beads"),
      lockDependencies: {
        ...h.runtimeDependencies.operationLock!,
        sleep: async (milliseconds) => {
          onWait();
          await delay(milliseconds);
        },
      },
    },
  );
}

test(
  "idle reconciliation does not acquire the pool lock or relinquish ownership",
  { timeout: 120_000 },
  async (t) => {
    const h = await fixture(t);
    const releasePool = signal();
    const poolHeld = signal();
    const initial = await h.store.show(h.task.id);
    const store = lockedStore(
      h,
      initial,
      () => {},
      () => {},
    );
    const service = new TaskLifecycleService({
      store,
      pool: h.runtime.pool,
      ...fixturePolicy,
      now: () =>
        Date.parse(initial.lifecycle!.execution!.expiresAt) +
        7 * 24 * 60 * 60_000,
      uuid: randomUUID,
    });
    const held = h.runtime.pool.withClaimObservation(
      "repo",
      h.acquired.claimId,
      h.owner,
      async () => {
        poolHeld.resolve();
        await releasePool.promise;
      },
    );
    await poolHeld.promise;
    const reconciliation = service.prepareReconciliation(
      { taskId: h.task.id, requestId: "idle" },
      { ...h.owner, sessionId: "daemon" },
    );
    try {
      const result = await Promise.race([
        reconciliation,
        delay(1000).then(() => {
          throw new Error("idle reconciliation waited on the pool");
        }),
      ]);
      assert.equal(result.kind, "complete");
      if (result.kind === "complete") assert.equal(result.outcome, "unchanged");
      assert.deepEqual(
        (await store.show(h.task.id)).lifecycle,
        initial.lifecycle,
      );
      assert.equal(
        await h.mustGit(h.acquired.path, ["rev-parse", "HEAD"]),
        h.acquired.head,
      );
    } finally {
      releasePool.resolve();
      await Promise.allSettled([held, reconciliation]);
    }
  },
);

test(
  "service-transaction release blocks claim renewal until deletion is persisted",
  { timeout: 120_000 },
  async (t) => {
    const h = await fixture(t);
    const removing = signal();
    const finishRemoval = signal();
    const waited = signal();
    const initial = await h.store.show(h.task.id);
    const store = lockedStore(h, initial, () => {}, waited.resolve);
    const runtime = await loadWorktreePoolRuntime(["repo"], "identity", {
      ...h.runtimeDependencies,
      runGit: async (cwd, args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removing.resolve();
          await finishRemoval.promise;
        }
        return h.runtimeDependencies.runGit!(cwd, args);
      },
    });
    const now = Date.parse(initial.lifecycle!.execution!.expiresAt) + 1_000;
    const service = new TaskLifecycleService({
      store,
      pool: runtime.pool,
      ...fixturePolicy,
      now: () => now,
      uuid: randomUUID,
    });
    const cleanup = service.releaseWorktree(
      h.task.id,
      h.acquired.claimId,
      h.owner,
      "explicit-release",
    );
    let claim: Promise<LifecycleIssue> | undefined;
    try {
      await Promise.race([
        removing.promise,
        cleanup.then(() => {
          throw new Error("cleanup finished without entering removal");
        }),
      ]);
      let returned = false;
      claim = service.claim(h.task.id, h.owner, "resume").then((issue) => {
        returned = true;
        return issue;
      });
      assert.equal(
        await Promise.race([
          waited.promise.then(() => "blocked"),
          claim.then(() => "returned"),
        ]),
        "blocked",
      );
      assert.equal(returned, false);
      finishRemoval.resolve();
      const [claimed] = await Promise.all([claim, cleanup]);
      assert.ok(Date.parse(claimed.lifecycle!.execution!.expiresAt) > now);
      assert.equal(claimed.lifecycle!.resources[0].cleanupState, "released");
      await assert.rejects(fs.stat(h.acquired.path), { code: "ENOENT" });
      assert.equal(
        await h.mustGit(h.repo, ["rev-parse", "refs/heads/jpriverar/first"]),
        h.acquired.head,
      );
      assert.equal((await store.show(h.task.id)).lifecycle!.phase, "active");
    } finally {
      finishRemoval.resolve();
      await Promise.allSettled([cleanup, ...(claim ? [claim] : [])]);
    }
  },
);

test(
  "claim observation excludes pool deletion through its metadata callback",
  { timeout: 120_000 },
  async (t) => {
    const h = await fixture(t);
    const entered = signal();
    const finish = signal();
    const waited = signal();
    const runtime = await loadWorktreePoolRuntime(["repo"], "identity", {
      ...h.runtimeDependencies,
      operationLock: {
        ...h.runtimeDependencies.operationLock!,
        sleep: async (milliseconds) => {
          waited.resolve();
          await delay(milliseconds);
        },
      },
    });
    const observation = runtime.pool.withClaimObservation(
      "repo",
      h.acquired.claimId,
      h.owner,
      async (observe) => {
        const matches = await observe();
        assert.equal(matches.length, 1);
        assert.equal(matches[0].evidence.nativeClaimMatches, true);
        entered.resolve();
        await finish.promise;
        assert.equal((await observe())[0].head, h.acquired.head);
      },
    );
    await Promise.race([
      entered.promise,
      observation.then(() => {
        throw new Error("observation did not enter callback");
      }),
    ]);
    const release = runtime.pool.release("repo", h.acquired.claimId, h.owner);
    try {
      assert.equal(
        await Promise.race([
          waited.promise.then(() => "blocked"),
          release.then(() => "deleted"),
        ]),
        "blocked",
      );
      assert.equal(
        await h.mustGit(h.acquired.path, ["rev-parse", "HEAD"]),
        h.acquired.head,
      );
      finish.resolve();
      const [, result] = await Promise.all([observation, release]);
      assert.equal(result.released, true);
    } finally {
      finish.resolve();
      await Promise.allSettled([observation, release]);
    }
  },
);

test(
  "public pool release permits metadata renewal between preparation and finalization",
  { timeout: 120_000 },
  async (t) => {
    const h = await fixture(t);
    const removing = signal();
    const finishRemoval = signal();
    const waited = signal();
    const initial = await h.store.show(h.task.id);
    const store = lockedStore(h, initial, () => {}, waited.resolve);
    const runtime = await loadWorktreePoolRuntime(["repo"], "identity", {
      ...h.runtimeDependencies,
      runGit: async (cwd, args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removing.resolve();
          await finishRemoval.promise;
        }
        return h.runtimeDependencies.runGit!(cwd, args);
      },
    });
    const now = Date.parse(initial.lifecycle!.execution!.expiresAt) + 1000;
    const service = new TaskLifecycleService({
      store,
      pool: runtime.pool,
      ...fixturePolicy,
      now: () => now,
      uuid: randomUUID,
    });
    const handlers = new Map<
      string,
      Array<(event: any, context: any) => any>
    >();
    const tools = new Map<string, any>();
    const api = {
      on(name: string, handler: any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      registerEntryRenderer() {},
      appendEntry() {},
      sendMessage() {},
    };
    createTaskLifecycleExtension({
      service,
      now: () => h.owner.started,
      pid: h.owner.pid,
      hostname: h.owner.host,
      activityWriteIntervalMs: fixturePolicy.activityWriteIntervalMs,
      sessionReconcileLimit: fixturePolicy.sessionReconcileLimit,
      sessionPrCheckLimit: fixturePolicy.sessionPrCheckLimit,
    })(api as any);
    createWorktreePoolExtension({
      now: () => h.owner.started,
      pid: h.owner.pid,
      hostname: h.owner.host,
      loadRuntime: async () => runtime,
    })(api);
    const context = {
      cwd: h.repo,
      sessionManager: {
        getSessionId: () => h.owner.sessionId,
        getBranch: () => [],
        getEntries: () => [],
        getSessionName: () => undefined,
      },
      ui: { notify() {} },
    };
    const call = h.event("public-release", {
      action: "release",
      repository: "repo",
      claimId: h.acquired.claimId,
    });
    for (const handler of handlers.get("tool_call")!)
      assert.equal(await handler(call, context), undefined);
    assert.equal(
      (await store.show(h.task.id)).lifecycle!.resources[0].cleanupState,
      "release_pending",
    );
    const release = tools
      .get("worktree_pool")
      .execute(
        call.toolCallId,
        call.input,
        undefined,
        undefined,
        context,
      ) as Promise<any>;
    let claim: Promise<LifecycleIssue> | undefined;
    try {
      await Promise.race([
        removing.promise,
        release.then(() => {
          throw new Error("public release finished without entering removal");
        }),
      ]);
      claim = service.claim(h.task.id, h.owner, "renew-during-public-release");
      assert.equal(
        await Promise.race([
          claim.then(() => "renewed"),
          waited.promise.then(() => "blocked"),
        ]),
        "renewed",
      );
      const renewed = await claim;
      assert.equal(
        renewed.lifecycle!.resources[0].cleanupState,
        "release_pending",
      );
      assert.equal(renewed.lifecycle!.execution!.sessionId, h.owner.sessionId);
      await fs.access(h.acquired.path);
      finishRemoval.resolve();
      const result = await release;
      assert.equal(result.details.released, true);
      for (const handler of handlers.get("tool_result")!) {
        assert.equal(
          await handler({ ...call, ...result, isError: false }, context),
          undefined,
        );
      }
      const finalized = await store.show(h.task.id);
      assert.equal(finalized.lifecycle!.resources[0].cleanupState, "released");
      assert.equal(
        finalized.lifecycle!.execution!.sessionId,
        h.owner.sessionId,
      );
      await assert.rejects(fs.stat(h.acquired.path), { code: "ENOENT" });
    } finally {
      finishRemoval.resolve();
      await Promise.allSettled([release, ...(claim ? [claim] : [])]);
    }
  },
);
