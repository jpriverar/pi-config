import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";

import { formatClaimReason } from "../extensions/worktree-pool/claim.js";
import {
  replaceLeaseRecord,
  type LeaseRecord,
} from "../extensions/worktree-pool/lease-records.js";
import { loadWorktreePoolRuntimeForClaims } from "../extensions/worktree-pool/runtime.js";
import { canonicalizeArtifact } from "../lib/task-lifecycle/model.js";
import { WorktreeRepairService } from "../lib/task-lifecycle/worktree-repair.js";
import { createWorktreeLifecycleFixture } from "./fixtures/worktree-lifecycle.js";

async function historicalFixture(t: TestContext) {
  const h = await createWorktreeLifecycleFixture(t, true);
  await h.mustGit(h.acquired.path, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
  ]);
  await h.service.prepareWorktreeRelease(
    h.task.id,
    h.acquired.claimId,
    h.owner,
    "historical-release",
  );
  const recordPath = join(
    h.root,
    "pool",
    ".leases",
    `${basename(h.acquired.path).slice("worktree-".length)}.json`,
  );
  const record: LeaseRecord = JSON.parse(await fs.readFile(recordPath, "utf8"));
  await replaceLeaseRecord(join(h.root, "pool"), record.claimId, {
    ...record,
    state: "removing",
  });
  await h.mustGit(h.repo, ["worktree", "unlock", h.acquired.path]);
  const newer = await h.runtime.pool.acquire(
    { repository: "repo", branch: "jpriverar/validation", startPoint: "main" },
    h.owner,
  );
  const claimIds = [h.acquired.claimId, newer.claimId];
  const actor = { ...h.owner, sessionId: "repair-operator-session" };
  const repair = new WorktreeRepairService({
    store: h.store,
    loadPool: async () => h.runtime.pool,
    now: () => h.owner.started,
  });
  return { ...h, newer, claimIds, actor, repair, recordPath };
}

test("repair preview binds both historical claims without mutating task, lease or native lock", async (t) => {
  const h = await historicalFixture(t);
  const before = await h.store.show(h.task.id);
  const lease = await fs.readFile(h.recordPath, "utf8");
  const locks = await h.mustGit(h.repo, ["worktree", "list", "--porcelain"]);
  const writes = h.store.writes;
  const plan = await h.repair.preview(h.task.id, h.claimIds);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.originalSessionId, h.owner.sessionId);
  assert.deepEqual(plan.claims.map((c) => c.action).sort(), [
    "associate",
    "cancel_release",
  ]);
  assert.equal(
    (await h.repair.preview(h.task.id, [...h.claimIds].reverse())).fingerprint,
    plan.fingerprint,
  );
  assert.deepEqual(await h.store.show(h.task.id), before);
  assert.equal(h.store.writes, writes);
  assert.equal(await fs.readFile(h.recordPath, "utf8"), lease);
  assert.equal(
    await h.mustGit(h.repo, ["worktree", "list", "--porcelain"]),
    locks,
  );
});

test("production claim discovery repairs a repository with no configuration override", async (t) => {
  const h = await historicalFixture(t);
  const config = JSON.parse(
    await fs.readFile(h.runtimeDependencies.configPath, "utf8"),
  );
  assert.deepEqual(config.repositories, []);
  const repair = new WorktreeRepairService({
    store: h.store,
    loadPool: async (claimIds) =>
      (await loadWorktreePoolRuntimeForClaims(claimIds, h.runtimeDependencies))
        .pool,
    now: () => h.owner.started,
  });
  const plan = await repair.preview(h.task.id, h.claimIds);
  assert.equal(plan.repository, "repo");
  await repair.apply(h.task.id, h.claimIds, plan.fingerprint, h.actor);
  assert.ok(
    (await h.store.show(h.task.id)).lifecycle!.resources.every(
      (r) => r.cleanupState === "active",
    ),
  );
});

test("claim discovery refuses missing, duplicate, and ambiguous lease identities", async (t) => {
  const h = await historicalFixture(t);
  await assert.rejects(
    loadWorktreePoolRuntimeForClaims(
      ["00000000-0000-4000-8000-000000000000"],
      h.runtimeDependencies,
    ),
    /missing|ambiguous/,
  );
  await assert.rejects(
    loadWorktreePoolRuntimeForClaims(
      [h.newer.claimId, h.newer.claimId],
      h.runtimeDependencies,
    ),
    /distinct/,
  );
  await fs.writeFile(
    join(h.runtime.root, ".leases", "malformed.json"),
    "untrusted private record",
  );
  await assert.rejects(
    loadWorktreePoolRuntimeForClaims(h.claimIds, h.runtimeDependencies),
    /inventory is ambiguous/,
  );
});

test("association retains the actual ID and history of an existing branch artifact", async (t) => {
  const h = await historicalFixture(t);
  const artifact = canonicalizeArtifact(
    {
      id: "existing-branch-artifact",
      kind: "branch",
      uri: "git://repo/refs/heads/jpriverar/validation",
      title: "Previously attached branch",
      role: "supporting",
    },
    new Date(h.owner.started).toISOString(),
  );
  h.store.issues.get(h.task.id)!.lifecycle!.artifacts.push(artifact);
  const plan = await h.repair.preview(h.task.id, h.claimIds);
  await h.repair.apply(h.task.id, h.claimIds, plan.fingerprint, h.actor);
  const state = (await h.store.show(h.task.id)).lifecycle!;
  const resource = state.resources.find((r) => r.claimId === h.newer.claimId)!;
  assert.equal(resource.branchArtifactId, artifact.id);
  assert.deepEqual(
    state.artifacts.filter((a) => a.uri === artifact.uri),
    [artifact],
  );
});

test("confirmed repair preserves both checkouts and original owner while auditing the real actor", async (t) => {
  const h = await historicalFixture(t);
  const before = await h.store.show(h.task.id);
  const files = [
    join(h.acquired.path, "README.md"),
    join(h.acquired.path, "nested", "README.md"),
    join(h.newer.path, "README.md"),
  ];
  const contents = await Promise.all(
    files.map((path) => fs.readFile(path, "utf8")),
  );
  const heads = await Promise.all(
    [h.acquired.path, h.newer.path].map((path) =>
      h.mustGit(path, ["rev-parse", "HEAD"]),
    ),
  );
  const plan = await h.repair.preview(h.task.id, h.claimIds);
  let persistedUnderPoolLock = false;
  h.store.onWrite = () => {
    persistedUnderPoolLock = existsSync(
      join(h.repo, ".git", "pi-worktree-pool", "operation.lock", "held"),
    );
  };
  const result = await h.repair.apply(
    h.task.id,
    h.claimIds,
    plan.fingerprint,
    h.actor,
  );
  assert.equal(persistedUnderPoolLock, true);
  assert.equal(result.taskId, h.task.id);
  const after = await h.store.show(h.task.id);
  assert.deepEqual(after.lifecycle!.execution, before.lifecycle!.execution);
  assert.deepEqual(after.lifecycle!.waiting, before.lifecycle!.waiting);
  assert.equal(after.lifecycle!.resources.length, 2);
  assert.ok(
    after.lifecycle!.resources.every((r) => r.cleanupState === "active"),
  );
  assert.deepEqual(
    after.lifecycle!.transitionHistory.slice(
      0,
      before.lifecycle!.transitionHistory.length,
    ),
    before.lifecycle!.transitionHistory,
  );
  const event = after.lifecycle!.transitionHistory.at(-1)!;
  assert.equal(event.type, "operator_worktree_repair");
  assert.equal(event.sessionId, h.actor.sessionId);
  assert.ok(event.reason!.includes(h.owner.sessionId));
  assert.ok(
    after.lifecycle!.artifacts.some(
      (a) => a.uri === "git://repo/refs/heads/jpriverar/validation",
    ),
  );
  const listing = (await h.runtime.pool.list("repo")).repositories[0].worktrees;
  assert.equal(listing.length, 2);
  assert.ok(
    listing.every((w) => w.evidence.nativeClaimMatches && w.state === "active"),
  );
  const native = await h.mustGit(h.repo, ["worktree", "list", "--porcelain"]);
  assert.ok(
    native.includes(
      `claim=${h.acquired.claimId} pid=${h.owner.pid} session=${h.owner.sessionId}`,
    ),
  );
  assert.deepEqual(
    await Promise.all(files.map((path) => fs.readFile(path, "utf8"))),
    contents,
  );
  assert.deepEqual(
    await Promise.all(
      [h.acquired.path, h.newer.path].map((path) =>
        h.mustGit(path, ["rev-parse", "HEAD"]),
      ),
    ),
    heads,
  );
  const fresh = await h.repair.preview(h.task.id, h.claimIds);
  assert.ok(fresh.claims.every((c) => c.action === "none"));
  const writes = h.store.writes;
  await h.repair.apply(h.task.id, h.claimIds, fresh.fingerprint, h.actor);
  assert.equal(h.store.writes, writes);
});

for (const change of [
  "dirty",
  "foreign-lock",
  "task-owner",
  "new-head",
  "association",
] as const) {
  test(`repair rejects ${change} after preview without changing either claim`, async (t) => {
    const h = await historicalFixture(t);
    const plan = await h.repair.preview(h.task.id, h.claimIds);
    if (change === "dirty") {
      await h.mustGit(h.acquired.path, [
        "config",
        "submodule.nested.ignore",
        "all",
      ]);
      await fs.writeFile(
        join(h.acquired.path, "nested", "local.txt"),
        "preserve this\n",
      );
    }
    if (change === "foreign-lock")
      await h.mustGit(h.repo, [
        "worktree",
        "lock",
        "--reason",
        "foreign-owner",
        h.acquired.path,
      ]);
    if (change === "new-head")
      await h.mustGit(h.newer.path, [
        "commit",
        "--allow-empty",
        "-m",
        "concurrent work",
      ]);
    if (change === "task-owner")
      h.store.issues.get(h.task.id)!.lifecycle!.execution!.sessionId =
        "different-owner";
    if (change === "association") {
      const other = structuredClone(h.store.issues.get(h.task.id)!);
      other.id = "other-task";
      h.store.issues.set(other.id, other);
    }
    const before = await h.store.show(h.task.id);
    const lease = await fs.readFile(h.recordPath, "utf8");
    const native = await h.mustGit(h.repo, ["worktree", "list", "--porcelain"]);
    await assert.rejects(
      h.repair.apply(h.task.id, h.claimIds, plan.fingerprint, h.actor),
      /repair|changed|dirty|owner|associated|stale/i,
    );
    assert.deepEqual(await h.store.show(h.task.id), before);
    assert.equal(await fs.readFile(h.recordPath, "utf8"), lease);
    assert.equal(
      await h.mustGit(h.repo, ["worktree", "list", "--porcelain"]),
      native,
    );
  });
}

test("fresh preview recovers a pool-only partial repair without blindly retrying the old binding", async (t) => {
  const h = await historicalFixture(t);
  const plan = await h.repair.preview(h.task.id, h.claimIds);
  const mutate = h.store.mutate.bind(h.store);
  h.store.mutate = async (id, owner, operation) =>
    mutate(id, owner, async (current) => {
      await operation(current);
      throw new Error("private fixture persistence failure");
    });
  await assert.rejects(
    h.repair.apply(h.task.id, h.claimIds, plan.fingerprint, h.actor),
    /partially|uncertain/i,
  );
  assert.equal((await h.store.show(h.task.id)).lifecycle!.resources.length, 1);
  const pool = (await h.runtime.pool.list("repo")).repositories[0].worktrees;
  assert.ok(
    pool.every((w) => w.evidence.nativeClaimMatches && w.state === "active"),
  );
  h.store.mutate = mutate;
  await assert.rejects(
    h.repair.apply(h.task.id, h.claimIds, plan.fingerprint, h.actor),
    /stale|changed/i,
  );
  const fresh = await h.repair.preview(h.task.id, h.claimIds);
  assert.notEqual(fresh.fingerprint, plan.fingerprint);
  await h.repair.apply(h.task.id, h.claimIds, fresh.fingerprint, h.actor);
  assert.ok(
    (await h.store.show(h.task.id)).lifecycle!.resources.every(
      (r) => r.cleanupState === "active",
    ),
  );
});

test("repair refuses ambiguous active task ownership for the original session", async (t) => {
  const h = await historicalFixture(t);
  const other = structuredClone(h.store.issues.get(h.task.id)!);
  other.id = "other-active-task";
  other.lifecycle!.resources = [];
  h.store.issues.set(other.id, other);
  await assert.rejects(
    h.repair.preview(h.task.id, h.claimIds),
    /ambiguous|multiple.*active/i,
  );
});

test("a claim recorded on another task is not reassigned even when marked released there", async (t) => {
  const h = await historicalFixture(t);
  const other = structuredClone(h.store.issues.get(h.task.id)!);
  other.id = "historical-other-task";
  other.lifecycle!.execution!.sessionId = "other-owner";
  other.lifecycle!.resources[0].cleanupState = "released";
  other.lifecycle!.resources[0].releasedAt = new Date(
    h.owner.started,
  ).toISOString();
  h.store.issues.set(other.id, other);
  await assert.rejects(
    h.repair.preview(h.task.id, h.claimIds),
    /another task|associated/i,
  );
});

test("uncertain reply after committed repair requires inspection, not a duplicate repair", async (t) => {
  const h = await historicalFixture(t);
  const plan = await h.repair.preview(h.task.id, h.claimIds);
  h.store.onWrite = () => {
    throw new Error("private verification failure after commit");
  };
  await assert.rejects(
    h.repair.apply(h.task.id, h.claimIds, plan.fingerprint, h.actor),
    /partially|uncertain/i,
  );
  h.store.onWrite = undefined;
  const fresh = await h.repair.preview(h.task.id, h.claimIds);
  assert.ok(fresh.claims.every((c) => c.action === "none"));
  const writes = h.store.writes;
  await h.repair.apply(h.task.id, h.claimIds, fresh.fingerprint, h.actor);
  assert.equal(h.store.writes, writes);
  assert.equal(
    (await h.store.show(h.task.id)).lifecycle!.transitionHistory.filter(
      (event) => event.type === "operator_worktree_repair",
    ).length,
    1,
  );
});

test("preview recognizes native-lock restoration completed before journal activation", async (t) => {
  const h = await historicalFixture(t);
  const reason = formatClaimReason(h.acquired.claimId, h.owner);
  await h.mustGit(h.repo, [
    "worktree",
    "lock",
    "--reason",
    reason,
    h.acquired.path,
  ]);
  const plan = await h.repair.preview(h.task.id, h.claimIds);
  assert.equal(
    plan.claims.find((claim) => claim.claimId === h.acquired.claimId)!
      .nativeLock,
    "matching",
  );
  await h.repair.apply(h.task.id, h.claimIds, plan.fingerprint, h.actor);
  assert.ok(
    (await h.mustGit(h.repo, ["worktree", "list", "--porcelain"])).includes(
      `locked ${reason}`,
    ),
  );
  assert.ok(
    (await h.store.show(h.task.id)).lifecycle!.resources.every(
      (resource) => resource.cleanupState === "active",
    ),
  );
});

test("expired target ownership is not revived by repair", async (t) => {
  const h = await historicalFixture(t);
  h.store.issues.get(h.task.id)!.lifecycle!.execution!.expiresAt = new Date(
    h.owner.started - 1,
  ).toISOString();
  await assert.rejects(
    h.repair.preview(h.task.id, h.claimIds),
    /owner|expired/i,
  );
});
