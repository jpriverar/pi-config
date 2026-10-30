import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeArtifact } from "./model.js";
import {
  fingerprintCheck,
  reconciliationOperationId,
} from "./reconciliation.js";
import {
  applyConditionObservationV2,
  prepareConditionObservationV2,
} from "./v2-reconciliation.js";
import {
  blockLifecycleV2,
  claimLifecycleV2,
  closeLifecycleV2,
  fingerprintConditionV2,
  nativeStatusV2,
  releaseLifecycleV2,
  resumeLifecycleV2,
} from "./v2-model.js";
import type { LifecycleMetadataV2 } from "./types.js";
import {
  check,
  issue,
  LATER,
  NOW,
  OWNER,
  resource,
  withCheck,
} from "./v2-test-fixtures.js";

function prState(overrides: Partial<LifecycleMetadataV2> = {}) {
  return withCheck({
    artifacts: [
      canonicalizeArtifact(
        {
          id: "pr",
          kind: "pull_request",
          role: "deliverable",
          title: "Delivery PR",
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

function pause(state: LifecycleMetadataV2, id = "block-a") {
  return blockLifecycleV2(state, {
    operationId: id,
    sessionId: OWNER.sessionId,
    now: NOW,
    reason: "Wait for the named condition",
    conditionFingerprint: fingerprintConditionV2(state, [])!,
  });
}

function prepare(
  state: LifecycleMetadataV2,
  id = "observe-a",
  manualOutcome?: "satisfied" | "action_required",
) {
  const current = issue(state, nativeStatusV2(state));
  const operationId = reconciliationOperationId({
    taskId: current.id,
    requestId: id,
    ...(manualOutcome === undefined
      ? {}
      : {
          manualOutcome,
          expectedCheckFingerprint: fingerprintCheck(current)!,
        }),
  });
  return prepareConditionObservationV2(
    current,
    operationId,
    "observer-session",
    manualOutcome,
  );
}

const requested = {
  outcome: "action_required" as const,
  observation: "changes_requested",
};
const merged = { outcome: "satisfied" as const, observation: "1/1 merged" };

test("requested changes end the pause but preserve the merge requirement and owner", () => {
  const original = pause(prState());
  const result = applyConditionObservationV2(
    original,
    prepare(original),
    requested,
    LATER,
  );
  assert.equal(result.outcome, "applied");
  assert.equal(result.transition, "ready");
  assert.equal(result.state.phase, "actionable");
  assert.equal(result.state.pause, null);
  assert.deepEqual(result.state.owner, OWNER);
  assert.deepEqual(result.state.condition, original.condition);
  assert.equal(result.state.activeCheck?.state, "action_required");
  assert.ok(result.state.activeCheck?.nextCheckAt);
  assert.throws(
    () =>
      closeLifecycleV2(result.state, {
        operationId: "premature-close",
        sessionId: OWNER.sessionId,
        now: LATER,
        disposition: {
          kind: "completed",
          reason: "Not merged",
          at: LATER,
          evidenceArtifactIds: [],
        },
      }),
    /completion condition/,
  );
  const resumed = resumeLifecycleV2(result.state, {
    operationId: "resume",
    sessionId: OWNER.sessionId,
    now: LATER,
    reason: "Address the requested changes",
  });
  const released = releaseLifecycleV2(resumed, {
    operationId: "release",
    sessionId: OWNER.sessionId,
    now: LATER,
    reason: "Hand off fixes",
  });
  assert.deepEqual(released.condition, original.condition);
  assert.equal(released.activeCheck?.state, "action_required");
});

for (const kind of ["time", "manual"] as const) {
  test(`${kind} continuation success is archived without a permanent requirement`, () => {
    const original = pause(
      withCheck({
        condition: { id: "response", kind: "check", purpose: "continuation" },
        activeCheck: check({
          kind,
          predicate: kind === "time" ? { at: NOW } : {},
        }),
      }),
    );
    const prepared = prepare(
      original,
      "continuation",
      kind === "manual" ? "satisfied" : undefined,
    );
    const result = applyConditionObservationV2(
      original,
      prepared,
      {
        outcome: "satisfied",
        observation:
          kind === "time" ? "time reached" : "manual input: satisfied",
      },
      LATER,
    );
    assert.equal(result.state.phase, "actionable");
    assert.equal(result.state.condition, null);
    assert.equal(result.state.activeCheck, null);
    assert.equal(result.state.checkHistory.at(-1)?.state, "satisfied");
    assert.deepEqual(result.state.owner, OWNER);
  });
}

test("a late result after resume records facts without closing active work", () => {
  const original = prState();
  original.activeCheck!.onSatisfied = "close";
  const blocked = pause(original);
  const prepared = prepare(blocked);
  const active = resumeLifecycleV2(blocked, {
    operationId: "resume",
    sessionId: OWNER.sessionId,
    now: LATER,
    reason: "Perform independent validation",
  });
  const result = applyConditionObservationV2(active, prepared, merged, LATER);
  assert.equal(result.state.phase, "active");
  assert.equal(result.state.disposition, null);
  assert.equal(result.state.activeCheck?.state, "satisfied");
  assert.deepEqual(result.state.owner, OWNER);
});

test("result A cannot clear pause B, including on a repeated aggregate observation", () => {
  const first = pause(prState());
  const preparedA = prepare(first);
  const active = resumeLifecycleV2(first, {
    operationId: "resume",
    sessionId: OWNER.sessionId,
    now: LATER,
    reason: "Complete independent work",
  });
  const second = pause(active, "block-b");
  const late = applyConditionObservationV2(second, preparedA, requested, LATER);
  assert.equal(late.state.phase, "waiting");
  assert.equal(late.state.pause?.id, "block-b");
  assert.equal(late.state.activeCheck?.state, "action_required");
  const repeated = applyConditionObservationV2(
    late.state,
    prepare(late.state, "fresh-poll"),
    requested,
    LATER,
  );
  assert.equal(repeated.state.phase, "waiting");
  assert.equal(repeated.state.pause?.id, "block-b");
});

test("known aggregate requested-changes is not a fresh review event after reblocking", () => {
  const original = prState();
  original.activeCheck!.state = "action_required";
  original.activeCheck!.lastObservation = "changes_requested";
  const blocked = pause(original);
  const result = applyConditionObservationV2(
    blocked,
    prepare(blocked),
    requested,
    LATER,
  );
  assert.equal(result.state.phase, "waiting");
  assert.equal(result.state.pause?.id, blocked.pause?.id);
  assert.equal(result.state.activeCheck?.lastCheckedAt, LATER);
});

test("a distinct actionable aggregate may resume the current pause without satisfying the gate", () => {
  const original = prState();
  original.activeCheck!.state = "action_required";
  original.activeCheck!.lastObservation = "changes_requested";
  const blocked = pause(original);
  const result = applyConditionObservationV2(
    blocked,
    prepare(blocked),
    {
      outcome: "action_required",
      observation: "merge_conflict",
    },
    LATER,
  );
  assert.equal(result.state.phase, "actionable");
  assert.equal(result.state.activeCheck?.state, "action_required");
  assert.equal(result.state.condition?.purpose, "completion");
});

test("late success cannot execute pause A's close intent against pause B", () => {
  const original = prState();
  original.activeCheck!.onSatisfied = "close";
  const first = pause(original);
  const preparedA = prepare(first);
  const active = resumeLifecycleV2(first, {
    operationId: "resume",
    sessionId: OWNER.sessionId,
    now: LATER,
    reason: "Do independent work",
  });
  const second = pause(active, "block-b");
  const result = applyConditionObservationV2(second, preparedA, merged, LATER);
  assert.equal(result.state.phase, "waiting");
  assert.equal(result.state.pause?.id, "block-b");
  assert.equal(result.state.disposition, null);
  assert.equal(result.state.activeCheck?.state, "satisfied");
});

test("a fulfilled current pause may close and retain responsibility", () => {
  const original = prState();
  original.activeCheck!.onSatisfied = "close";
  const blocked = pause(original);
  const result = applyConditionObservationV2(
    blocked,
    prepare(blocked),
    merged,
    LATER,
  );
  assert.equal(result.transition, "closed");
  assert.equal(result.state.phase, "done");
  assert.deepEqual(result.state.owner, OWNER);
  assert.equal(result.state.disposition?.kind, "completed");
});

test("success with retained worktrees is persisted as ready for explicit cleanup", () => {
  const original = prState({ resources: [resource()] });
  original.activeCheck!.onSatisfied = "close";
  const blocked = pause(original);
  const result = applyConditionObservationV2(
    blocked,
    prepare(blocked),
    merged,
    LATER,
  );
  assert.equal(result.transition, "cleanup_required");
  assert.equal(result.state.phase, "actionable");
  assert.equal(result.state.pause, null);
  assert.equal(result.state.activeCheck?.state, "satisfied");
  assert.equal(result.state.activeCheck?.nextCheckAt, null);
  assert.deepEqual(result.state.resources, original.resources);
  assert.deepEqual(result.state.owner, OWNER);
});

test("replacement criteria reject old results without changing any state", () => {
  const original = pause(prState());
  const prepared = prepare(original);
  const replacement = structuredClone(original);
  replacement.activeCheck!.predicate = { mode: "any" };
  replacement.pause!.conditionFingerprint = fingerprintConditionV2(
    replacement,
    [],
  )!;
  const result = applyConditionObservationV2(
    replacement,
    prepared,
    merged,
    LATER,
  );
  assert.equal(result.outcome, "stale");
  assert.deepEqual(result.state, replacement);
});

test("a changed check snapshot prevents an older poll from overwriting newer facts", () => {
  const original = pause(prState());
  const prepared = prepare(original);
  const updated = structuredClone(original);
  updated.activeCheck!.lastCheckedAt = LATER;
  updated.activeCheck!.lastObservation = "newer observation";
  const result = applyConditionObservationV2(
    updated,
    prepared,
    requested,
    LATER,
  );
  assert.equal(result.outcome, "stale");
  assert.deepEqual(result.state, updated);
});

for (const nextSession of [OWNER.sessionId, "session-b"]) {
  test(`ownership changes fence pause transitions for ${nextSession}`, () => {
    const original = pause(prState());
    const prepared = prepare(original);
    const released = releaseLifecycleV2(original, {
      operationId: "release",
      sessionId: OWNER.sessionId,
      now: NOW,
      reason: "Hand off",
    });
    const claimed = claimLifecycleV2(released, {
      operationId: "claim-next",
      sessionId: nextSession,
      now: NOW,
    });
    const result = applyConditionObservationV2(
      claimed,
      prepared,
      requested,
      LATER,
    );
    assert.equal(result.state.owner?.sessionId, nextSession);
    assert.equal(result.state.phase, "waiting");
    assert.equal(result.state.activeCheck?.state, "action_required");
  });
}

test("activity timestamps do not invalidate the ownership episode", () => {
  const original = pause(prState());
  const prepared = prepare(original);
  const activeOwner = {
    ...original,
    owner: { ...OWNER, lastActivityAt: LATER },
  };
  const result = applyConditionObservationV2(
    activeOwner,
    prepared,
    requested,
    LATER,
  );
  assert.equal(result.state.phase, "actionable");
  assert.equal(result.state.owner?.lastActivityAt, LATER);
});

test("manual success requires the explicitly bound matching outcome", () => {
  const original = pause(withCheck());
  assert.throws(
    () =>
      applyConditionObservationV2(
        original,
        prepare(original),
        {
          outcome: "satisfied",
          observation: "manual input: satisfied",
        },
        LATER,
      ),
    /explicit manual outcome/,
  );
  assert.throws(
    () =>
      applyConditionObservationV2(
        original,
        prepare(original, "manual", "satisfied"),
        {
          outcome: "action_required",
          observation: "manual input: action_required",
        },
        LATER,
      ),
    /does not match/,
  );
});

test("pending/error observations preserve the pause and use configured backoff", () => {
  const original = pause(prState());
  const pending = applyConditionObservationV2(
    original,
    prepare(original),
    {
      outcome: "pending",
      observation: "0/1 merged",
    },
    LATER,
    { pollIntervalMs: 60_000, maxBackoffMs: 240_000 },
  );
  assert.equal(
    pending.state.activeCheck?.nextCheckAt,
    "2026-10-28T11:01:00.000Z",
  );
  assert.equal(pending.state.lastProgressAt, original.lastProgressAt);
  const first = applyConditionObservationV2(
    pending.state,
    prepare(pending.state, "error-1"),
    {
      outcome: "error",
      observation: "gh exited with code 1",
    },
    LATER,
    { pollIntervalMs: 60_000, maxBackoffMs: 240_000 },
  );
  const second = applyConditionObservationV2(
    first.state,
    prepare(first.state, "error-2"),
    {
      outcome: "error",
      observation: "gh exited with code 1",
    },
    LATER,
    { pollIntervalMs: 60_000, maxBackoffMs: 240_000 },
  );
  assert.equal(second.state.activeCheck?.errorCount, 2);
  assert.equal(
    second.state.activeCheck?.nextCheckAt,
    "2026-10-28T11:02:00.000Z",
  );
  assert.equal(second.state.pause?.id, original.pause?.id);
});

test("an applied request is idempotent without another history entry", () => {
  const original = pause(prState());
  const prepared = prepare(original);
  const result = applyConditionObservationV2(
    original,
    prepared,
    requested,
    LATER,
  );
  const repeated = applyConditionObservationV2(
    result.state,
    prepared,
    requested,
    LATER,
  );
  assert.equal(repeated.outcome, "already_applied");
  assert.deepEqual(repeated.state, result.state);
  assert.equal(original.activeCheck?.state, "pending");
});

test("a fresh explicit manual response is not treated as a repeated PR aggregate", () => {
  const original = pause(
    withCheck({
      activeCheck: check({
        state: "action_required",
        lastObservation: "manual input: action_required",
      }),
    }),
  );
  const result = applyConditionObservationV2(
    original,
    prepare(original, "new-human-response", "action_required"),
    {
      outcome: "action_required",
      observation: "manual input: action_required",
    },
    LATER,
  );
  assert.equal(result.state.phase, "actionable");
  assert.equal(result.state.condition?.purpose, "completion");
  assert.equal(result.state.activeCheck?.state, "action_required");
});

test("settling persisted success uses current intent without inventing another observation", () => {
  const original = prState();
  original.activeCheck!.onSatisfied = "close";
  const blocked = pause(original);
  blocked.activeCheck = {
    ...blocked.activeCheck!,
    state: "satisfied",
    lastCheckedAt: NOW,
    lastObservation: "1/1 merged",
    nextCheckAt: null,
  };
  const result = applyConditionObservationV2(
    blocked,
    prepare(blocked, "settle-current-pause"),
    merged,
    LATER,
    { cached: true },
  );
  assert.equal(result.state.phase, "done");
  assert.equal(result.state.checkHistory.at(-1)?.lastCheckedAt, NOW);
  assert.equal(result.state.disposition?.at, LATER);
});

test("persisted manual success may settle without inventing new manual input", () => {
  const original = pause(withCheck());
  original.activeCheck = {
    ...original.activeCheck!,
    state: "satisfied",
    lastCheckedAt: NOW,
    lastObservation: "manual input: satisfied",
  };
  const result = applyConditionObservationV2(
    original,
    prepare(original, "settle-manual"),
    {
      outcome: "satisfied",
      observation: "manual input: satisfied",
    },
    LATER,
    { cached: true },
  );
  assert.equal(result.state.phase, "actionable");
  assert.equal(result.state.activeCheck?.lastCheckedAt, NOW);
});

for (const actionable of ["changes_requested", "merge_conflict"]) {
  test(`an observed pending state permits renewed ${actionable} to end the same pause`, () => {
    const original = prState();
    original.activeCheck!.state = "action_required";
    original.activeCheck!.lastObservation = actionable;
    const blocked = pause(original);
    const pending = applyConditionObservationV2(
      blocked,
      prepare(blocked, "pending"),
      { outcome: "pending", observation: "0/1 merged" },
      LATER,
    ).state;
    assert.equal(pending.phase, "waiting");
    const result = applyConditionObservationV2(
      pending,
      prepare(pending, "renewed"),
      { outcome: "action_required", observation: actionable },
      LATER,
    );
    assert.equal(result.state.phase, "actionable");
    assert.equal(result.state.pause, null);
    assert.equal(result.state.condition?.purpose, "completion");
    assert.equal(result.state.activeCheck?.state, "action_required");
  });
}

test("an observation error does not make the same known actionable aggregate fresh", () => {
  const original = prState();
  original.activeCheck!.state = "action_required";
  original.activeCheck!.lastObservation = "changes_requested";
  const blocked = pause(original);
  const failed = applyConditionObservationV2(
    blocked,
    prepare(blocked, "error"),
    { outcome: "error", observation: "GitHub unavailable" },
    LATER,
  ).state;
  const result = applyConditionObservationV2(
    failed,
    prepare(failed, "retry"),
    requested,
    LATER,
  );
  assert.equal(result.state.phase, "waiting");
  assert.equal(result.state.pause?.id, blocked.pause?.id);
});

for (const newOwner of [null, OWNER.sessionId, "session-b"]) {
  test(`an ownership-only fence leaves the same pause eligible for the next current poll (${newOwner})`, () => {
    const original = pause(prState());
    const prepared = prepare(original, "old-owner");
    const released = releaseLifecycleV2(original, {
      operationId: "release",
      sessionId: OWNER.sessionId,
      now: NOW,
      reason: "Handoff",
    });
    const current =
      newOwner === null
        ? released
        : claimLifecycleV2(released, {
            operationId: "claim-new",
            sessionId: newOwner,
            now: NOW,
          });
    const late = applyConditionObservationV2(
      current,
      prepared,
      requested,
      LATER,
    ).state;
    assert.equal(late.phase, "waiting");
    assert.equal(late.pause?.id, original.pause?.id);
    const result = applyConditionObservationV2(
      late,
      prepare(late, "current-owner"),
      requested,
      LATER,
    );
    assert.equal(result.state.phase, "actionable");
    assert.equal(result.state.pause, null);
    assert.equal(result.state.owner?.sessionId ?? null, newOwner);
    assert.equal(result.state.condition?.purpose, "completion");
  });
}

test("a pending fact from the previous owner separates repeated signals within the same pause", () => {
  const initial = prState();
  initial.activeCheck!.state = "action_required";
  initial.activeCheck!.lastObservation = "changes_requested";
  const blocked = pause(initial);
  const prepared = prepare(blocked, "old-owner-pending");
  const released = releaseLifecycleV2(blocked, {
    operationId: "release",
    sessionId: OWNER.sessionId,
    now: NOW,
    reason: "Handoff",
  });
  const reclaimed = claimLifecycleV2(released, {
    operationId: "claim-b",
    sessionId: "session-b",
    now: NOW,
  });
  const pending = applyConditionObservationV2(
    reclaimed,
    prepared,
    { outcome: "pending", observation: "0/1 merged" },
    LATER,
  ).state;
  assert.equal(pending.phase, "waiting");
  assert.equal(pending.pause?.id, blocked.pause?.id);
  const fresh = applyConditionObservationV2(
    pending,
    prepare(pending, "new-owner-requested"),
    requested,
    LATER,
  ).state;
  assert.equal(fresh.phase, "actionable");
  assert.equal(fresh.owner?.sessionId, "session-b");
  assert.equal(fresh.condition?.purpose, "completion");
});
