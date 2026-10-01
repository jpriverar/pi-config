import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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
    `normal acquisition resumes after expired ${obstacle} cleanup`,
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
      await assert.rejects(
        resumed.reconcileExecutionTimeout(h.task.id, daemon),
        /still owns worktree/,
      );
      const pending = (await store.show(h.task.id)).lifecycle!.resources;
      assert.deepEqual(
        pending.map((resource) => resource.cleanupState),
        ["release_pending", "active"],
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
  "queued cleanup rechecks the renewed lease inside the real pool/store locks",
  { timeout: 120_000 },
  async (t) => {
    const h = await fixture(t);
    const pending = signal();
    const waited = signal();
    const releasePool = signal();
    const poolHeld = signal();
    const initial = await h.store.show(h.task.id);
    const store = lockedStore(h, initial, pending.resolve, waited.resolve);
    const now = Date.parse(initial.lifecycle!.execution!.expiresAt) + 1_000;
    const service = new TaskLifecycleService({
      store,
      pool: h.runtime.pool,
      ...fixturePolicy,
      now: () => now,
      uuid: randomUUID,
    });
    const held = h.runtime.pool.withClaimRepair(
      "repo",
      [h.acquired.claimId],
      h.owner,
      async () => {
        poolHeld.resolve();
        await releasePool.promise;
      },
    );
    await poolHeld.promise;
    const cleanup = service.reconcileExecutionTimeout(h.task.id, {
      ...h.owner,
      sessionId: "fixture-reconciler",
    });
    let claim: Promise<LifecycleIssue> | undefined;
    try {
      await Promise.race([
        pending.promise,
        cleanup.then(() => {
          throw new Error("cleanup finished without reserving release");
        }),
      ]);
      claim = service.claim(h.task.id, h.owner, "resume");
      const claimed = await claim;
      assert.ok(Date.parse(claimed.lifecycle!.execution!.expiresAt) > now);
      releasePool.resolve();
      await held;
      const observed = await cleanup;
      assert.equal(
        observed.lifecycle!.execution!.expiresAt,
        claimed.lifecycle!.execution!.expiresAt,
      );
      await service.preflightWorktreeAcquire(
        { taskId: h.task.id, repository: "repo", branch: "jpriverar/next" },
        h.owner,
      );
      assert.equal(
        (await store.show(h.task.id)).lifecycle!.resources[0].cleanupState,
        "active",
      );
      assert.equal(
        await h.mustGit(h.acquired.path, ["rev-parse", "HEAD"]),
        h.acquired.head,
      );
      assert.equal(
        (await h.runtime.pool.list("repo")).repositories[0].worktrees[0]
          .evidence.nativeClaimMatches,
        true,
      );
    } finally {
      releasePool.resolve();
      await Promise.allSettled([held, cleanup, ...(claim ? [claim] : [])]);
    }
  },
);

test(
  "claim cannot return renewed ownership during an already-running destructive release",
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
    const cleanup = service.reconcileExecutionTimeout(h.task.id, {
      ...h.owner,
      sessionId: "fixture-reconciler",
    });
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
