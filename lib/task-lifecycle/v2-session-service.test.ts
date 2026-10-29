import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, session } from "./v2-service-test-fixtures.js";
import { NOW, OWNER, state, withCheck } from "./v2-test-fixtures.js";
import { blockLifecycleV2, fingerprintConditionV2 } from "./v2-model.js";
import type { ArtifactInput, LifecycleMetadataV2 } from "./types.js";

const V2 = { serviceVersion: 2, storeVersion: 2 } as const;
const document: ArtifactInput = {
  id: "doc",
  kind: "document",
  role: "deliverable",
  title: "Report",
  uri: "https://example.com/report",
};
const current = withCheck();
const paused = blockLifecycleV2(current, {
  operationId: "block",
  sessionId: OWNER.sessionId,
  now: NOW,
  reason: "Wait",
  conditionFingerprint: fingerprintConditionV2(current, [])!,
});
const done = state({
  phase: "done",
  owner: OWNER,
  disposition: {
    kind: "completed",
    reason: "Delivered",
    at: NOW,
    evidenceArtifactIds: [],
  },
});
const phases = [
  state({ phase: "active", owner: OWNER }),
  state({ phase: "actionable", owner: OWNER }),
  paused,
  state({ phase: "deferred", owner: OWNER }),
  done,
];

test("owned v2 work can update its mission and next action without rewriting ownership", async (t) => {
  const original = phases[0];
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const saved = await f.sut.updateTask(
    "jp-1",
    {
      addLabels: [],
      removeLabels: [],
      description: "Agreed updated mission",
      nextStep: "Verify the candidate",
    },
    session(),
  );
  assert.equal(saved.description, "Agreed updated mission");
  assert.equal(saved.metadata.next_step, "Verify the candidate");
  assert.deepEqual(saved.lifecycle, original);
});

test("owned in-progress v2 work records progress in the existing native journal", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: phases[0] }]);
  await f.sut.log("jp-1", "Verified the exact candidate", session());
  assert.deepEqual(f.comments, [
    { taskId: "jp-1", message: "Verified the exact candidate" },
  ]);
});

test("v2 artifact writes preserve schema, ownership and idempotence", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: phases[0] }]);
  await f.sut.attachArtifact("jp-1", document, session(), "attach");
  const saved = await f.sut.attachArtifact(
    "jp-1",
    document,
    session(),
    "attach",
  );
  assert.equal(saved.lifecycle?.version, 2);
  assert.equal(saved.lifecycle?.artifacts.length, 1);
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(f.writes.length, 1);
});

test("automatic artifact batches require the current in-progress owner", async (t) => {
  const f = await fixture(t, [{ id: "jp-1", lifecycle: phases[0] }]);
  const saved = await f.sut.recordObservedArtifacts(
    "jp-1",
    [document],
    session(),
    "observe",
  );
  assert.equal(saved.lifecycle?.artifacts.length, 1);
  await assert.rejects(
    f.sut.recordObservedArtifacts(
      "jp-1",
      [{ ...document, id: "other" }],
      session("foreign"),
      "foreign",
    ),
    /owned|owner/,
  );
});

for (const lifecycle of phases.slice(1)) {
  test(`retained ${lifecycle.phase} ownership cannot authorize productive content or artifact writes`, async (t) => {
    const f = await fixture(t, [{ id: "jp-1", lifecycle }]);
    await assert.rejects(
      f.sut.updateTask(
        "jp-1",
        { addLabels: [], removeLabels: [], description: "Wrong phase" },
        session(),
      ),
      /active|in.progress/,
    );
    await assert.rejects(
      f.sut.log("jp-1", "Wrong phase", session()),
      /active|in.progress/,
    );
    await assert.rejects(
      f.sut.attachArtifact("jp-1", document, session(), "attach"),
      /active|in.progress/,
    );
    await assert.rejects(
      f.sut.recordObservedArtifacts("jp-1", [document], session(), "observe"),
      /active|in.progress/,
    );
    assert.deepEqual(f.writes, []);
  });
}

for (const lifecycle of phases) {
  test(`session activity in ${lifecycle.phase} neither resumes work nor releases its owner`, async (t) => {
    let now = Date.parse(NOW) + 600_000;
    const f = await fixture(t, [{ id: "jp-1", lifecycle }], {
      ...V2,
      now: () => now,
    });
    const changed = await f.sut.refreshSessionActivity(session());
    assert.equal(changed.length, 1);
    const saved = changed[0].lifecycle as LifecycleMetadataV2;
    assert.equal(saved.phase, lifecycle.phase);
    assert.deepEqual(saved.owner, {
      ...OWNER,
      lastActivityAt: new Date(now).toISOString(),
    });
    assert.equal(saved.lastProgressAt, lifecycle.lastProgressAt);
    assert.equal(saved.stateEnteredAt, lifecycle.stateEnteredAt);
    assert.deepEqual(saved.condition, lifecycle.condition);
    assert.deepEqual(saved.pause, lifecycle.pause);
    now += 1000;
    assert.deepEqual(await f.sut.refreshSessionActivity(session()), []);
  });
}

test("a cross-phase ownership collision cannot look like one valid active association", async (t) => {
  const f = await fixture(t, [
    { id: "jp-active", lifecycle: phases[0] },
    { id: "jp-done", lifecycle: done },
  ]);
  await assert.rejects(
    f.sut.activeTasksForSession(OWNER.sessionId),
    /multiple.*owned|multiple.*tasks/i,
  );
});
