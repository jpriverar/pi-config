import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeArtifact } from "./model.js";
import { selectDueCandidates } from "./reconciliation.js";
import { fixture, session } from "./v2-service-test-fixtures.js";
import {
  blockLifecycleV2,
  fingerprintConditionV2,
  nativeStatusV2,
} from "./v2-model.js";
import type { LifecycleMetadataV2, NativeDependency } from "./types.js";
import {
  check,
  issue,
  NOW,
  OWNER,
  resource,
  state,
  withCheck,
} from "./v2-test-fixtures.js";

const V2 = { serviceVersion: 2, storeVersion: 2 } as const;
function paused(
  current: LifecycleMetadataV2,
  dependencies: NativeDependency[] = [],
) {
  return blockLifecycleV2(
    current,
    {
      operationId: "block-a",
      sessionId: OWNER.sessionId,
      now: NOW,
      reason: "Wait for the condition",
      conditionFingerprint: fingerprintConditionV2(current, dependencies)!,
    },
    dependencies,
  );
}
function mergeGate(overrides: Partial<LifecycleMetadataV2> = {}) {
  return withCheck({
    artifacts: [
      canonicalizeArtifact(
        {
          id: "pr",
          kind: "pull_request",
          role: "deliverable",
          title: "PR",
          uri: "https://github.com/DataDog/example/pull/123",
        },
        NOW,
      ),
    ],
    activeCheck: check({
      kind: "github_pull_request",
      targetArtifactIds: ["pr"],
      predicate: { mode: "all" },
      nextCheckAt: NOW,
    }),
    ...overrides,
  });
}

test("service persists manual success for cleanup and never polls it again", async (t) => {
  const original = withCheck({
    resources: [resource()],
    activeCheck: check({ onSatisfied: "close" }),
  });
  let observations = 0;
  const f = await fixture(t, [{ id: "jp-1", lifecycle: paused(original) }], {
    ...V2,
    checkAdapters: {
      async observe(_check, _artifacts, input) {
        observations++;
        assert.equal(input?.manualOutcome, "satisfied");
        return { outcome: "satisfied", observation: "manual input: satisfied" };
      },
    },
  });
  const saved = await f.sut.reconcileTask("jp-1", session("daemon"), {
    manualOutcome: "satisfied",
  });
  assert.equal(saved.lifecycle?.phase, "actionable");
  assert.equal(saved.lifecycle?.activeCheck?.state, "satisfied");
  assert.equal(saved.lifecycle?.activeCheck?.nextCheckAt, null);
  assert.deepEqual(saved.lifecycle?.resources, original.resources);
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  await f.sut.reconcileTask("jp-1", session("daemon"));
  assert.equal(observations, 1);
});

test("service fences a newer pause then settles cached success under its current intent", async (t) => {
  const original = mergeGate();
  original.activeCheck!.onSatisfied = "close";
  const f = await fixture(t, [{ id: "jp-1", lifecycle: paused(original) }]);
  const prepared = await f.sut.prepareReconciliation(
    { taskId: "jp-1", requestId: "poll-a" },
    session("daemon"),
  );
  assert.equal(prepared.kind, "observe");
  if (prepared.kind !== "observe") throw new Error("expected observation");
  assert.equal(prepared.prepared.lifecycleVersion, 2);
  await f.sut.resume("jp-1", "Perform independent work", session(), "resume");
  await f.sut.block(
    "jp-1",
    { reason: "Independent work is finished" },
    session(),
    "block-b",
  );
  f.records.get("jp-1")!.metadata.next_step =
    "Preserve this until actual completion";
  const late = await f.sut.applyReconciliation(
    prepared.prepared,
    { outcome: "satisfied", observation: "1/1 merged" },
    session("daemon"),
  );
  assert.equal(late.issue.lifecycle?.phase, "waiting");
  assert.equal(
    (late.issue.lifecycle as LifecycleMetadataV2).pause?.id,
    "block-b",
  );
  assert.equal(late.issue.lifecycle?.activeCheck?.state, "satisfied");
  assert.equal(
    late.issue.metadata.next_step,
    "Preserve this until actual completion",
  );
  const settled = await f.sut.prepareReconciliation(
    { taskId: "jp-1", requestId: "settle-b" },
    session("daemon"),
  );
  assert.equal(settled.kind, "complete");
  const saved = await f.store.show("jp-1");
  assert.equal(saved.lifecycle?.phase, "done");
  assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(saved.metadata.next_step, null);
});

for (const phase of ["active", "waiting"] as const) {
  test(`native dependency completion preserves ownership in ${phase}`, async (t) => {
    const initialDependencies: NativeDependency[] = [
      { id: "jp-blocker", status: "open", dependencyType: "blocks" },
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
    const current =
      phase === "waiting" ? paused(original, initialDependencies) : original;
    const f = await fixture(t, [
      {
        id: "jp-1",
        lifecycle: current,
        dependencies: [{ ...initialDependencies[0], status: "closed" }],
      },
      {
        id: "jp-blocker",
        lifecycle: state({
          phase: "done",
          disposition: {
            kind: "completed",
            reason: "Fixture complete",
            at: NOW,
            evidenceArtifactIds: [],
          },
        }),
      },
    ]);
    const result = await f.sut.prepareReconciliation(
      { taskId: "jp-1", requestId: "dependency-done" },
      session("daemon"),
    );
    assert.equal(result.kind, "complete");
    const saved = await f.store.show("jp-1");
    assert.equal(
      saved.lifecycle?.phase,
      phase === "active" ? "active" : "actionable",
    );
    assert.deepEqual((saved.lifecycle as LifecycleMetadataV2).owner, OWNER);
    assert.equal((saved.lifecycle as LifecycleMetadataV2).condition, null);
  });
}

test("v2 scheduling includes owned Ready checks and pending resources but not repeated satisfied polling", () => {
  const active = mergeGate();
  const ready = mergeGate({ phase: "actionable" });
  const late = paused(mergeGate());
  late.activeCheck = {
    ...late.activeCheck!,
    state: "satisfied",
    lastObservation: "1/1 merged",
    lastCheckedAt: NOW,
    nextCheckAt: null,
  };
  const satisfiedReady = mergeGate({
    phase: "actionable",
    activeCheck: { ...late.activeCheck! },
  });
  const manualResources = paused(
    withCheck({
      resources: [
        resource({ cleanupState: "acquiring", path: null, acquiredAt: null }),
      ],
    }),
  );
  const issues = [active, ready, late, satisfiedReady, manualResources].map(
    (current, index) => ({
      ...issue(current, nativeStatusV2(current)),
      id: "jp-" + index,
    }),
  );
  const due = selectDueCandidates(issues, new Map(), Date.parse(NOW), 2);
  assert.deepEqual(due.map((candidate) => candidate.taskId).sort(), [
    "jp-0",
    "jp-1",
    "jp-2",
    "jp-4",
  ]);
  assert.deepEqual(
    due.find((candidate) => candidate.taskId === "jp-4")?.reasons,
    ["resource"],
  );
  assert.deepEqual(
    selectDueCandidates(issues, new Map(), Date.parse(NOW), 1),
    [],
  );
});

test("cached success without an observation timestamp cannot change task status", async (t) => {
  const original = paused(withCheck());
  original.activeCheck!.state = "satisfied";
  original.activeCheck!.lastObservation =
    "Recorded result without an observation time";
  assert.equal(original.activeCheck!.lastCheckedAt, null);
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }]);
  const before = f.snapshot("jp-1");
  await assert.rejects(
    f.sut.prepareReconciliation(
      { taskId: "jp-1", requestId: "unproven-cache" },
      session("daemon"),
    ),
    /persisted.*observation/,
  );
  assert.deepEqual(f.snapshot("jp-1"), before);
  assert.deepEqual(f.writes, []);
});

test("v2 direct reconciliation respects its observation budget", async (t) => {
  let observations = 0;
  const original = paused(
    withCheck({
      activeCheck: check({
        kind: "time",
        predicate: { at: NOW },
        nextCheckAt: NOW,
      }),
    }),
  );
  const f = await fixture(t, [{ id: "jp-1", lifecycle: original }], {
    ...V2,
    checkAdapters: {
      async observe() {
        observations++;
        return { outcome: "satisfied", observation: "Time reached" };
      },
    },
  });
  const skipped = await f.sut.reconcileDue(session("daemon"), {
    taskLimit: 1,
    checkLimit: 0,
  });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].lifecycle?.phase, "waiting");
  assert.equal(observations, 0);
  const checked = await f.sut.reconcileDue(session("daemon"), {
    taskLimit: 1,
    checkLimit: 1,
  });
  assert.equal(checked[0].lifecycle?.phase, "actionable");
  assert.deepEqual((checked[0].lifecycle as LifecycleMetadataV2).owner, OWNER);
  assert.equal(observations, 1);
});

for (const predicate of [
  { mode: "approved" },
  { mode: "all", approval: "required" },
  { mode: "all", freshReview: true },
  { mode: "all", ci: "passed" },
]) {
  test(`unsupported automated PR predicate requires manual evaluation: ${JSON.stringify(predicate)}`, async () => {
    const { validateLifecycleV2 } = await import("./v2-model.js");
    const current = mergeGate();
    current.activeCheck!.predicate = predicate;
    assert.throws(
      () =>
        validateLifecycleV2(current, issue(current, nativeStatusV2(current))),
      /unsupported.*manual/,
    );
  });
}

test("time checks cannot silently carry additional automation criteria", async () => {
  const { validateLifecycleV2 } = await import("./v2-model.js");
  const current = withCheck({
    activeCheck: check({ kind: "time", predicate: { at: NOW, ci: "passed" } }),
  });
  assert.throws(
    () => validateLifecycleV2(current, issue(current, nativeStatusV2(current))),
    /unsupported.*manual/,
  );
});

test("manual checks retain structured criteria that have no automatic adapter", async () => {
  const { validateLifecycleV2 } = await import("./v2-model.js");
  const current = withCheck({
    activeCheck: check({
      predicate: { approval: "required", freshReview: true, ci: "passed" },
    }),
  });
  assert.doesNotThrow(() =>
    validateLifecycleV2(current, issue(current, nativeStatusV2(current))),
  );
});
