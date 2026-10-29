import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AcquireResult,
  PoolWorktreeListing,
} from "../../extensions/worktree-pool/pool.js";
import type { TaskLifecyclePoolPort } from "./service.js";
import { fixture, session } from "./v2-service-test-fixtures.js";
import { blockLifecycleV2, fingerprintConditionV2 } from "./v2-model.js";
import type {
  LifecycleMetadataV2,
  PreparedWorktreeOperation,
} from "./types.js";
import { NOW, OWNER, resource, withCheck } from "./v2-test-fixtures.js";

const V2 = { serviceVersion: 2, storeVersion: 2 } as const;
function paused(resources = [resource()]) {
  const current = withCheck({ resources });
  return blockLifecycleV2(current, {
    operationId: "block",
    sessionId: OWNER.sessionId,
    now: NOW,
    reason: "Await the response",
    conditionFingerprint: fingerprintConditionV2(current, [])!,
  });
}

function poolFixture(clean = true) {
  const entries = new Map<string, PoolWorktreeListing>([
    [
      "claim-1",
      {
        claimId: "claim-1",
        path: "/tmp/worktree-path-1",
        state: "active",
        branch: "jpriverar/test",
        currentBranch: "refs/heads/jpriverar/test",
        head: "1".repeat(40),
        clean,
        branchProtectsHead: true,
        evidence: {
          pathExists: true,
          registered: true,
          nativeClaimMatches: true,
        },
      },
    ],
  ]);
  let releases = 0;
  const pool: TaskLifecyclePoolPort = {
    async list() {
      return {
        repositories: [
          {
            name: "repo",
            capacity: 3,
            used: entries.size,
            worktrees: [...entries.values()],
          },
        ],
      };
    },
    async withClaimObservation(_repo, claimId, _owner, operation) {
      return operation(async () =>
        entries.has(claimId) ? [entries.get(claimId)!] : [],
      );
    },
    async acquire() {
      throw new Error("unexpected physical allocation");
    },
    async release(_repo, claimId, _owner, transaction) {
      releases++;
      return transaction(async () => {
        const entry = entries.get(claimId)!;
        if (!entry.clean)
          return { path: entry.path, released: false, reason: "dirty" };
        entries.delete(claimId);
        return { path: entry.path, released: true };
      });
    },
  };
  return { pool, entries, releases: () => releases };
}

const context: Extract<PreparedWorktreeOperation, { mode: "acquire" }> = {
  version: 1,
  mode: "acquire",
  taskId: "jp-1",
  operationId: "acquire-1",
  claimId: "claim-1",
  pathId: "path-1",
  repository: "repo",
};
const acquired: AcquireResult = {
  claimId: "claim-1",
  path: "/tmp/worktree-path-1",
  branch: "jpriverar/test",
  reused: false,
  head: "1".repeat(40),
  startPoint: "main",
  startPointHead: "1".repeat(40),
  startPointFetched: false,
  relationship: "equal",
};

test("an acquisition may finalize after its owner blocks without resuming work", async (t) => {
  const original = paused([
    resource({ cleanupState: "acquiring", path: null, acquiredAt: null }),
  ]);
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const saved = await f.sut.finalizeWorktreeAcquire(
    context,
    acquired,
    session(),
  );
  assert.equal(saved.lifecycle?.phase, "waiting");
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
  assert.equal(saved.lifecycle?.resources[0].path, acquired.path);
  assert.equal(saved.lifecycle?.artifacts[0].kind, "branch");
});

test("new allocation still requires in-progress work", async (t) => {
  const p = poolFixture();
  const f = await fixture(t, [{ id: "jp-1", lifecycle: paused([]) }], {
    ...V2,
    pool: p.pool,
  });
  await assert.rejects(
    f.sut.prepareWorktreeAcquire(
      { taskId: "jp-1", repository: "repo", branch: "jpriverar/new" },
      session(),
      "new",
    ),
    /active|in.progress/,
  );
  assert.deepEqual(f.writes, []);
});

for (const phase of ["waiting", "actionable"] as const) {
  test(`explicit worktree release preserves owned ${phase} work`, async (t) => {
    const p = poolFixture();
    const original =
      phase === "waiting"
        ? paused([resource({ path: acquired.path })])
        : withCheck({ phase, resources: [resource({ path: acquired.path })] });
    const f = await fixture(t, [{ id: "jp-1", lifecycle: original }], {
      ...V2,
      pool: p.pool,
    });
    const saved = await f.sut.releaseWorktree(
      "jp-1",
      "claim-1",
      session(),
      "release-tree",
    );
    assert.equal(saved.lifecycle?.phase, phase);
    assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
    assert.equal(saved.lifecycle?.resources[0].cleanupState, "released");
    assert.equal(p.entries.size, 0);
    assert.equal(p.releases(), 1);
    assert.deepEqual(
      (saved.lifecycle as LifecycleMetadataV2).condition,
      original.condition,
    );
  });
}

test("dirty cleanup refusal leaves the blocked task owned with an unreleased resource", async (t) => {
  const p = poolFixture(false);
  const f = await fixture(
    t,
    [{ id: "jp-1", lifecycle: paused([resource({ path: acquired.path })]) }],
    { ...V2, pool: p.pool },
  );
  await assert.rejects(
    f.sut.releaseWorktree("jp-1", "claim-1", session(), "release-tree"),
    /refused|dirty/,
  );
  const current = await f.store.show("jp-1");
  assert.equal(current.lifecycle?.phase, "waiting");
  assert.deepEqual((current.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(current.lifecycle?.resources[0].cleanupState, "release_pending");
  assert.equal(p.entries.size, 1);
  await assert.rejects(
    f.sut.release("jp-1", "Switch", session(), "release-task"),
    /resource|worktree/,
  );
});

test("a finalizer cannot act for another owner or another resource operation", async (t) => {
  const original = paused([
    resource({ cleanupState: "acquiring", path: null, acquiredAt: null }),
  ]);
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  await assert.rejects(
    f.sut.finalizeWorktreeAcquire(context, acquired, session("other")),
    /owner|owned/,
  );
  await assert.rejects(
    f.sut.finalizeWorktreeAcquire(
      { ...context, operationId: "wrong" },
      acquired,
      session(),
    ),
    /operation/,
  );
  assert.deepEqual(f.writes, []);
});

test("manual waiting does not prevent pending acquisition reconciliation", async (t) => {
  const p = poolFixture();
  const original = paused([
    resource({ cleanupState: "acquiring", path: null, acquiredAt: null }),
  ]);
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }], {
    ...V2,
    pool: p.pool,
  });
  const result = await f.sut.prepareReconciliation(
    { taskId: "jp-1", requestId: "recover" },
    session("daemon"),
  );
  assert.equal(result.kind, "complete");
  const saved = await f.store.show("jp-1");
  assert.equal(saved.lifecycle?.phase, "waiting");
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
  assert.equal(saved.lifecycle?.activeCheck?.state, "pending");
  assert.equal(p.releases(), 0);
});

test("an in-progress reservation retains its v2 owner through later blocked finalization", async (t) => {
  const p = poolFixture();
  const f = await fixture(t, [{ id: "jp-1", lifecycle: withCheck() }], {
    ...V2,
    pool: p.pool,
  });
  const prepared = await f.sut.prepareWorktreeAcquire(
    { taskId: "jp-1", repository: "repo", branch: "jpriverar/new" },
    session(),
    "reserve",
  );
  const pending = await f.store.show("jp-1");
  assert.equal(pending.lifecycle?.version, 2);
  assert.equal(pending.lifecycle?.resources[0].cleanupState, "acquiring");
  await f.sut.block(
    "jp-1",
    { reason: "Await the response" },
    session(),
    "block-after-reserve",
  );
  const saved = await f.sut.finalizeWorktreeAcquire(
    prepared,
    {
      ...acquired,
      claimId: prepared.claimId,
      path: "/tmp/worktree-" + prepared.pathId,
      branch: "jpriverar/new",
    },
    session(),
  );
  assert.equal(saved.lifecycle?.phase, "waiting");
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
});

test("release finalization remains valid after the owner blocks", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: withCheck({ resources: [resource()] }) },
  ]);
  const prepared = await f.sut.prepareWorktreeRelease(
    "jp-1",
    "claim-1",
    session(),
    "release-tree",
  );
  await f.sut.block(
    "jp-1",
    { reason: "Await the response" },
    session(),
    "block-after-release-start",
  );
  const saved = await f.sut.finalizeWorktreeRelease(prepared, session());
  assert.equal(saved.lifecycle?.phase, "waiting");
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(saved.lifecycle?.resources[0].cleanupState, "released");
});
