import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorktreeLifecycleFixture } from "./fixtures/worktree-lifecycle.js";
import { check } from "../lib/task-lifecycle/v2-test-fixtures.js";
import type { LifecycleMetadataV2 } from "../lib/task-lifecycle/types.js";

const pause = {
  reason: "Await explicit verification",
  condition: {
    kind: "check",
    purpose: "completion",
    check: check({ kind: "manual", nextCheckAt: null }),
  },
} as const;

test("native v2 allocation persists its reservation before Git and finalizes across a pause", async (t) => {
  const h = await createWorktreeLifecycleFixture(t, false, 2);
  await h.service.releaseWorktree(
    h.task.id,
    h.acquired.claimId,
    h.owner,
    "clean-first",
  );
  const allocate = h.runtime.pool.acquire.bind(h.runtime.pool);
  h.runtime.pool.acquire = async (request, owner, identity) => {
    const before = (await h.store.show(h.task.id)).lifecycle!;
    const pending = before.resources.filter(
      (r) => r.cleanupState === "acquiring",
    );
    assert.equal(pending.length, 1);
    assert.deepEqual(identity, {
      claimId: pending[0].claimId,
      pathId: pending[0].pathId,
    });
    await h.service.block(h.task.id, pause, h.owner, "pause-during-allocation");
    await assert.rejects(
      h.service.release(h.task.id, "Switch tasks", h.owner, "release-pending"),
      /resource|worktree/,
    );
    return allocate(request, owner, identity);
  };
  const result = await h.acquire("jpriverar/second");
  assert.ok(result.acquired);
  const saved = (await h.store.show(h.task.id))
    .lifecycle as LifecycleMetadataV2;
  assert.equal(saved.phase, "waiting");
  assert.equal(saved.owner?.sessionId, h.owner.sessionId);
  assert.equal(
    saved.resources.find((r) => r.claimId === result.acquired.claimId)
      ?.cleanupState,
    "active",
  );
});

test("native v2 allocation uncertainty keeps a recoverable reservation rather than permitting task release", async (t) => {
  const h = await createWorktreeLifecycleFixture(t, false, 2);
  await h.service.releaseWorktree(
    h.task.id,
    h.acquired.claimId,
    h.owner,
    "clean-first",
  );
  const allocate = h.runtime.pool.acquire.bind(h.runtime.pool);
  h.runtime.pool.acquire = async (...args) => {
    await allocate(...args);
    throw new Error("allocation acknowledgement lost");
  };
  await assert.rejects(h.acquire("jpriverar/second"), /acknowledgement lost/);
  const before = (await h.store.show(h.task.id)).lifecycle!;
  assert.equal(
    before.resources.filter((r) => r.cleanupState === "acquiring").length,
    1,
  );
  await assert.rejects(
    h.service.release(h.task.id, "Switch tasks", h.owner, "release-unknown"),
    /resource|worktree/,
  );
  await h.service.block(h.task.id, pause, h.owner, "block-unknown");
  await h.service.reconcileTask(h.task.id, h.owner);
  const after = (await h.store.show(h.task.id))
    .lifecycle as LifecycleMetadataV2;
  assert.equal(after.phase, "waiting");
  assert.equal(after.owner?.sessionId, h.owner.sessionId);
  assert.equal(
    after.resources.filter((r) => r.cleanupState === "active").length,
    1,
  );
});

test("native v2 acquisition enforces execution independently of the frontend hook", async (t) => {
  const h = await createWorktreeLifecycleFixture(t, false, 2);
  await h.service.block(h.task.id, pause, h.owner, "block");
  const writes = h.store.writes;
  const invoke = (context = h.context) =>
    h.tools
      .get("worktree_acquire")
      .execute(
        "direct",
        { repository: "repo", branch: "jpriverar/forbidden" },
        undefined,
        undefined,
        context,
      );
  await assert.rejects(invoke(), /In-progress/);
  await assert.rejects(
    invoke({
      ...h.context,
      sessionManager: {
        ...h.context.sessionManager,
        getSessionId: () => "fork",
      },
    }),
    /In-progress/,
  );
  assert.equal(h.store.writes, writes);
  assert.equal((await h.runtime.pool.list("repo")).repositories[0].used, 1);
});
