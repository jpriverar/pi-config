import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskLifecycleService } from "./service.js";
import { createActionableLifecycle } from "./model.js";
import { blockLifecycleV2, fingerprintConditionV2 } from "./v2-model.js";
import type { LifecycleMetadataV2, NativeDependency } from "./types.js";
import {
  check,
  NOW,
  OWNER,
  resource,
  state,
  withCheck,
} from "./v2-test-fixtures.js";

import { fixture, session } from "./v2-service-test-fixtures.js";

function blocked(): LifecycleMetadataV2 {
  const current = withCheck();
  return blockLifecycleV2(current, {
    operationId: "initial-block",
    sessionId: OWNER.sessionId,
    now: NOW,
    reason: "Wait for the decision",
    conditionFingerprint: fingerprintConditionV2(current, [])!,
  });
}

test("v2 creation is explicit and the store reads its owner and phase", async (t) => {
  const f = await fixture(t, []);
  const created = await f.sut.create(
    { title: "New task", why: "Approved", needsJp: false },
    session(),
  );
  assert.equal(created.lifecycle?.version, 2);
  assert.equal(created.lifecycle?.phase, "actionable");
  assert.equal((created.lifecycle as LifecycleMetadataV2).owner, null);
  assert.equal(
    Object.hasOwn(created.metadata.piLifecycle as object, "execution"),
    false,
  );
});

test("v1 writer defaults cannot overwrite a readable v2 record", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: state() }], {
    storeVersion: 2,
  });
  const before = f.snapshot("jp-1");
  assert.equal((await f.store.show("jp-1")).lifecycle?.version, 2);
  await assert.rejects(
    f.sut.claim("jp-1", session(), "claim"),
    /write version/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("the native store independently rejects a v2 write in v1 mode", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: state() }], {
    serviceVersion: 2,
  });
  const before = f.snapshot("jp-1");
  assert.equal((await f.store.show("jp-1")).lifecycle?.version, 2);
  await assert.rejects(
    f.sut.claim("jp-1", session(), "claim"),
    /write version/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("two concurrent claims by one session acquire exactly one task", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state() },
    { id: "jp-2", lifecycle: state() },
  ]);
  const outcomes = await Promise.allSettled([
    f.sut.claim("jp-1", session(), "claim-1"),
    f.sut.claim("jp-2", session(), "claim-2"),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
  );
  assert.equal((await f.sut.ownedTasksForSession(OWNER.sessionId)).length, 1);
  assert.equal(f.writes.length, 1);
});

test("claiming blocked work preserves the pause and same-owner claim writes nothing", async (t) => {
  const original = { ...blocked(), owner: null };
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const claimed = await f.sut.claim("jp-1", session(), "claim");
  assert.equal(claimed.lifecycle?.phase, "waiting");
  assert.deepEqual(
    (claimed.lifecycle as LifecycleMetadataV2).pause,
    original.pause,
  );
  const before = f.snapshot("jp-1");
  const count = f.writes.length;
  await f.sut.claim("jp-1", session(), "repeat");
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.equal(f.writes.length, count);
});

test("owned done tasks prevent another claim until explicit release", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state({ phase: "active", owner: OWNER }) },
    { id: "jp-2", lifecycle: state() },
  ]);
  const done = await f.sut.close(
    "jp-1",
    { kind: "completed", reason: "Delivered", evidenceArtifactIds: [] },
    session(),
    "close",
  );
  assert.deepEqual((done.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(done.metadata.next_step, null);
  await assert.rejects(f.sut.claim("jp-2", session(), "second"), /owns|owned/);
  await f.sut.release("jp-1", "Finished this task", session(), "release");
  const claimed = await f.sut.claim("jp-2", session(), "second-after-release");
  assert.equal(claimed.lifecycle?.phase, "active");
});

test("blocking and resuming retain ownership, worktrees, and completion requirements", async (t) => {
  const original = withCheck({ resources: [resource()] });
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const paused = await f.sut.block(
    "jp-1",
    { reason: "No independent work remains" },
    session(),
    "block",
  );
  assert.equal(paused.lifecycle?.phase, "waiting");
  assert.deepEqual((paused.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.deepEqual(paused.lifecycle?.resources, original.resources);
  const resumed = await f.sut.resume(
    "jp-1",
    "Run the newly authorized validation",
    session(),
    "resume",
  );
  assert.equal(resumed.lifecycle?.phase, "active");
  assert.equal((resumed.lifecycle as LifecycleMetadataV2).pause, null);
  assert.deepEqual(
    (resumed.lifecycle as LifecycleMetadataV2).condition,
    original.condition,
  );
  assert.deepEqual(resumed.lifecycle?.activeCheck, original.activeCheck);
});

test("block atomically registers a new condition and its pause", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state({ phase: "active", owner: OWNER }) },
  ]);
  const saved = await f.sut.block(
    "jp-1",
    {
      reason: "Await the required decision",
      condition: { kind: "check", purpose: "completion", check: check() },
    },
    session(),
    "block",
  );
  assert.equal(saved.lifecycle?.phase, "waiting");
  const current = saved.lifecycle as LifecycleMetadataV2;
  assert.equal(current.condition?.purpose, "completion");
  assert.equal(
    current.pause?.conditionFingerprint,
    fingerprintConditionV2(current, []),
  );
  assert.deepEqual(f.writes, ["update:jp-1"]);
});

test("adding a condition does not automatically block in-progress work", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state({ phase: "active", owner: OWNER }) },
  ]);
  const saved = await f.sut.updateCondition(
    "jp-1",
    {
      kind: "check",
      purpose: "completion",
      check: check(),
      reason: "Required before delivery",
    },
    session(),
    "condition",
  );
  assert.equal(saved.lifecycle?.phase, "active");
  assert.equal((saved.lifecycle as LifecycleMetadataV2).pause, null);
  assert.equal(
    (saved.lifecycle as LifecycleMetadataV2).condition?.purpose,
    "completion",
  );
});

test("condition edits cannot fabricate observed success or silently erase a pause", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state({ phase: "active", owner: OWNER }) },
  ]);
  await assert.rejects(
    f.sut.updateCondition(
      "jp-1",
      {
        kind: "check",
        purpose: "completion",
        check: check({ state: "satisfied" }),
        reason: "Claim success",
      },
      session(),
      "forge",
    ),
    /pending|observation/,
  );
  assert.deepEqual(f.writes, []);
  await f.sut.block(
    "jp-1",
    {
      reason: "Await decision",
      condition: { kind: "check", purpose: "completion", check: check() },
    },
    session(),
    "block",
  );
  const before = f.snapshot("jp-1");
  await assert.rejects(
    f.sut.updateCondition(
      "jp-1",
      {
        kind: "clear",
        reason: "Change the decision",
      },
      session(),
      "clear",
    ),
    /pause|blocked|resume/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
});

test("non-owner condition updates cannot insert native blockers", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: withCheck() },
    { id: "jp-blocker", lifecycle: state() },
  ]);
  await assert.rejects(
    f.sut.updateCondition(
      "jp-1",
      {
        kind: "dependency",
        blockerIds: ["jp-blocker"],
        purpose: "completion",
        reason: "Depends on other work",
      },
      session("other"),
      "deps",
    ),
    /owned|owner/,
  );
  assert.deepEqual(f.writes, []);
});

test("release keeps an unmet completion requirement but exposes corrective work", async (t) => {
  const original = withCheck({
    activeCheck: check({
      state: "action_required",
      lastObservation: "changes_requested",
    }),
  });
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const saved = await f.sut.release(
    "jp-1",
    "Hand off the fixes",
    session(),
    "release",
  );
  assert.equal(saved.lifecycle?.phase, "actionable");
  assert.equal((saved.lifecycle as LifecycleMetadataV2).owner, null);
  assert.deepEqual(saved.lifecycle?.activeCheck, original.activeCheck);
  const claimed = await f.sut.claim("jp-1", session("next"), "claim-next");
  assert.equal(claimed.lifecycle?.phase, "active");
  await assert.rejects(
    f.sut.close(
      "jp-1",
      {
        kind: "completed",
        reason: "Not merged yet",
        evidenceArtifactIds: [],
      },
      session("next"),
      "close",
    ),
    /condition|requirement/,
  );
});

test("unsafe resource cleanup prevents release without losing ownership", async (t) => {
  const original = blocked();
  original.resources = [resource({ cleanupState: "release_pending" })];
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const before = f.snapshot("jp-1");
  await assert.rejects(
    f.sut.release("jp-1", "Switch tasks", session(), "release"),
    /resource|worktree/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("defer and reopen preserve responsibility and the pending requirement", async (t) => {
  const original = withCheck();
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  await f.sut.defer("jp-1", "Park the work", session(), "defer");
  await assert.rejects(
    f.sut.reopen("jp-1", "Take over", session("other"), "steal"),
    /owned|owner/,
  );
  const saved = await f.sut.reopen(
    "jp-1",
    "Continue the work",
    session(),
    "reopen",
  );
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.deepEqual(saved.lifecycle?.activeCheck, original.activeCheck);
  assert.equal(saved.lifecycle?.phase, "actionable");
});

test("re-registering a check preserves its condition identity and observed facts", async (t) => {
  const original = withCheck({
    activeCheck: check({
      state: "action_required",
      lastCheckedAt: NOW,
      lastObservation: "changes_requested",
    }),
  });
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const saved = await f.sut.updateCondition(
    "jp-1",
    {
      kind: "check",
      purpose: "completion",
      check: check(),
      reason: "Retain the existing gate",
    },
    session(),
    "retain",
  );
  assert.deepEqual(
    (saved.lifecycle as LifecycleMetadataV2).condition,
    original.condition,
  );
  assert.deepEqual(saved.lifecycle?.activeCheck, original.activeCheck);
});

test("an unmet completion requirement cannot be replaced by a continuation gate", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: withCheck() }]);
  const before = f.snapshot("jp-1");
  await assert.rejects(
    f.sut.updateCondition(
      "jp-1",
      {
        kind: "check",
        purpose: "continuation",
        check: check({ id: "another-check" }),
        reason: "Wait instead",
      },
      session(),
      "replace",
    ),
    /completion requirement/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("explicit condition abandonment requires a reason and retains its history", async (t) => {
  const original = withCheck();
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  await assert.rejects(
    f.sut.updateCondition(
      "jp-1",
      { kind: "clear", reason: "" },
      session(),
      "empty",
    ),
    /reason/,
  );
  assert.deepEqual(f.writes, []);
  const saved = await f.sut.updateCondition(
    "jp-1",
    {
      kind: "clear",
      reason: "Operator explicitly removed this completion requirement",
    },
    session(),
    "clear",
  );
  assert.equal(saved.lifecycle?.phase, "active");
  assert.equal((saved.lifecycle as LifecycleMetadataV2).condition, null);
  assert.equal(saved.lifecycle?.activeCheck, null);
  assert.deepEqual(saved.lifecycle?.checkHistory, [original.activeCheck]);
});

test("a continuation pause can be replaced atomically without a dangling reference", async (t) => {
  const original = blocked();
  original.condition!.purpose = "continuation";
  original.pause!.conditionFingerprint = fingerprintConditionV2(original, [])!;
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const saved = await f.sut.block(
    "jp-1",
    {
      reason: "Await the new explicit response",
      condition: {
        kind: "check",
        purpose: "continuation",
        check: check({ id: "replacement" }),
      },
    },
    session(),
    "replace-pause",
  );
  const current = saved.lifecycle as LifecycleMetadataV2;
  assert.equal(current.phase, "waiting");
  assert.equal(current.pause?.id, "replace-pause");
  assert.equal(
    current.pause?.conditionFingerprint,
    fingerprintConditionV2(current, []),
  );
  assert.deepEqual(current.owner, OWNER);
  assert.deepEqual(current.checkHistory, [original.activeCheck]);
});

test("native dependencies block dispatch after release but do not lose responsibility on claim", async (t) => {
  const original = state({
    phase: "active",
    owner: OWNER,
    condition: {
      id: "dependencies",
      kind: "dependency",
      purpose: "completion",
    },
  });
  const f = await fixture(t, [
    {
      id: "jp-1",
      lifecycle: original,
      dependencies: [{ id: "jp-2", status: "open", dependencyType: "blocks" }],
    },
    { id: "jp-2", lifecycle: state() },
  ]);
  const released = await f.sut.release(
    "jp-1",
    "Hand off dependency follow-up",
    session(),
    "release",
  );
  assert.equal(released.lifecycle?.phase, "waiting");
  assert.equal((released.lifecycle as LifecycleMetadataV2).owner, null);
  const claimed = await f.sut.claim("jp-1", session("next-owner"), "claim");
  assert.equal(claimed.lifecycle?.phase, "waiting");
  assert.equal(
    (claimed.lifecycle as LifecycleMetadataV2).owner?.sessionId,
    "next-owner",
  );
});

test("blocking can add a native dependency group under the same mutation lock", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state({ phase: "active", owner: OWNER }) },
    { id: "jp-2", lifecycle: state() },
  ]);
  const saved = await f.sut.block(
    "jp-1",
    {
      reason: "Wait for required work",
      condition: {
        kind: "dependency",
        purpose: "completion",
        blockerIds: ["jp-2"],
      },
    },
    session(),
    "block-deps",
  );
  const current = saved.lifecycle as LifecycleMetadataV2;
  assert.equal(current.phase, "waiting");
  assert.equal(current.condition?.kind, "dependency");
  assert.equal(
    current.pause?.conditionFingerprint,
    fingerprintConditionV2(current, saved.dependencies),
  );
  assert.deepEqual(saved.dependencies, [
    { id: "jp-2", status: "open", dependencyType: "blocks" },
  ]);
});

test("refusing to replace a completion requirement adds no native edges", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: withCheck() },
    { id: "jp-2", lifecycle: state() },
  ]);
  const before = f.snapshot("jp-1");
  await assert.rejects(
    f.sut.block(
      "jp-1",
      {
        reason: "Different prerequisite",
        condition: {
          kind: "dependency",
          purpose: "completion",
          blockerIds: ["jp-2"],
        },
      },
      session(),
      "replace",
    ),
    /completion requirement/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("release preserves explicit blocked and deferred phases", async (t) => {
  for (const phase of ["waiting", "deferred"] as const) {
    const current =
      phase === "waiting" ? blocked() : withCheck({ phase: "deferred" });
    const f = await fixture(t, [{ id: "jp-1", lifecycle: current }]);
    const saved = await f.sut.release(
      "jp-1",
      "Hand off responsibility",
      session(),
      "release",
    );
    assert.equal(saved.lifecycle?.phase, phase);
    assert.equal((saved.lifecycle as LifecycleMetadataV2).owner, null);
    assert.deepEqual(
      (saved.lifecycle as LifecycleMetadataV2).condition,
      current.condition,
    );
    assert.deepEqual(
      (saved.lifecycle as LifecycleMetadataV2).pause,
      current.pause,
    );
  }
});

test("owned ready work requires explicit resume and rejects a nonowner", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state({ owner: OWNER }) },
  ]);
  const claimed = await f.sut.claim("jp-1", session(), "claim");
  assert.equal(claimed.lifecycle?.phase, "actionable");
  await assert.rejects(
    f.sut.resume("jp-1", "Do work", session("other"), "other"),
    /owned|owner/,
  );
  const saved = await f.sut.resume(
    "jp-1",
    "Run the approved validation",
    session(),
    "resume",
  );
  assert.equal(saved.lifecycle?.phase, "active");
});

test("cancellation can abandon a pending requirement but does not release its owner", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: withCheck() }]);
  const done = await f.sut.close(
    "jp-1",
    {
      kind: "cancelled",
      reason: "Operator cancelled this work",
      evidenceArtifactIds: [],
    },
    session(),
    "cancel",
  );
  assert.equal(done.lifecycle?.phase, "done");
  assert.deepEqual((done.lifecycle as LifecycleMetadataV2).owner, OWNER);
  await assert.rejects(
    f.sut.resume("jp-1", "Continue", session(), "resume"),
    /reopen/,
  );
  const reloaded = new TaskLifecycleService({
    store: f.store,
    now: () => Date.parse(NOW),
    uuid: () => "reload-op",
    executionTimeoutMs: 60_000,
    lifecycleWriteVersion: 2,
  });
  assert.deepEqual(
    (await reloaded.ownedTasksForSession(OWNER.sessionId)).map(
      (task) => task.id,
    ),
    ["jp-1"],
  );
  assert.deepEqual(await reloaded.ownedTasksForSession("forked-session"), []);
  const repeated = await reloaded.claim("jp-1", session(), "repeat");
  assert.equal(repeated.lifecycle?.phase, "done");
});

test("malformed closed records cannot silently hide another owned task", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: state() },
    { id: "jp-unknown", lifecycle: state(), status: "closed" },
  ]);
  f.records.get("jp-unknown")!.metadata.piLifecycle = {
    version: 99,
    owner: { sessionId: OWNER.sessionId },
  };
  await assert.rejects(
    f.sut.claim("jp-1", session(), "claim"),
    /ownership is unavailable/,
  );
  assert.deepEqual(f.writes, []);
});

test("clearing a native condition cannot waive unresolved dependency edges", async (t) => {
  const dependencies: NativeDependency[] = [
    { id: "jp-2", status: "open", dependencyType: "blocks" },
  ];
  const original = state({
    phase: "active",
    owner: OWNER,
    condition: {
      id: "dependencies",
      kind: "dependency",
      purpose: "completion",
    },
  });
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: original, dependencies },
    { id: "jp-2", lifecycle: state() },
  ]);
  const before = f.snapshot("jp-1");
  await assert.rejects(
    f.sut.updateCondition(
      "jp-1",
      {
        kind: "clear",
        reason: "Remove only the condition metadata",
      },
      session(),
      "clear-native",
    ),
    /unresolved native blockers/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("enabling v2 writes does not implicitly convert an existing v1 task", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: state() }]);
  f.records.get("jp-1")!.metadata.piLifecycle = createActionableLifecycle(NOW);
  const before = f.snapshot("jp-1");
  assert.equal((await f.store.show("jp-1")).lifecycle?.version, 1);
  await assert.rejects(
    f.sut.claim("jp-1", session(), "claim"),
    /reviewed conversion/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("ready metadata cannot override authoritative native dispatch readiness", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: state() }]);
  f.store.readyIds = async () => new Set();
  await assert.rejects(
    f.sut.claim("jp-1", session(), "claim"),
    /not natively ready/,
  );
  assert.deepEqual(f.writes, []);
  assert.equal((await f.store.show("jp-1")).lifecycle?.phase, "actionable");
});

test("a status conflict cannot reopen native closed work through block", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: withCheck(), status: "closed" },
  ]);
  const before = f.snapshot("jp-1");
  await assert.rejects(
    f.sut.block(
      "jp-1",
      {
        reason: "Wait for the check",
      },
      session(),
      "block",
    ),
    /native status/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("supersession records the new task without transferring responsibility", async (t) => {
  const f = await fixture(t, [
    { id: "jp-1", lifecycle: withCheck() },
    { id: "jp-2", lifecycle: state() },
  ]);
  const saved = await f.sut.close(
    "jp-1",
    {
      kind: "superseded",
      reason: "Operator chose the replacement task",
      evidenceArtifactIds: [],
      supersedingTaskId: "jp-2",
    },
    session(),
    "supersede",
  );
  assert.equal(saved.lifecycle?.phase, "done");
  assert.equal(saved.lifecycle?.disposition?.supersedingTaskId, "jp-2");
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  const replacement = await f.store.show("jp-2");
  assert.equal((replacement.lifecycle as LifecycleMetadataV2).owner, null);
});
