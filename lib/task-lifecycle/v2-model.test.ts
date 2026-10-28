import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionableLifecycle, decodeLifecycle } from "./model.js";
import {
  blockLifecycleV2,
  claimLifecycleV2,
  closeLifecycleV2,
  decodeLifecycleAny,
  decodeLifecycleV2,
  deferLifecycleV2,
  fingerprintConditionV2,
  releaseLifecycleV2,
  reopenLifecycleV2,
  resumeLifecycleV2,
  validateLifecycleV2,
} from "./v2-model.js";
import type { LifecycleMetadataV2, NativeDependency } from "./types.js";
import {
  check,
  issue,
  LATER,
  NOW,
  OWNER,
  resource,
  state,
  withCheck,
} from "./v2-test-fixtures.js";

const actor = (operationId: string, now = NOW) => ({
  operationId,
  sessionId: OWNER.sessionId,
  now,
});
const pendingDependency: NativeDependency = {
  id: "jp-blocker",
  status: "open",
  dependencyType: "blocks",
};
function paused(
  overrides: Partial<LifecycleMetadataV2> = {},
): LifecycleMetadataV2 {
  const current = withCheck(overrides);
  return {
    ...current,
    phase: "waiting",
    pause: {
      id: "pause-1",
      conditionFingerprint: fingerprintConditionV2(current, [])!,
      blockedAt: NOW,
      observationFingerprint: null,
    },
  };
}

for (const owner of [null, OWNER]) {
  for (const phase of ["actionable", "waiting", "deferred", "done"] as const) {
    test(
      "accepts " + phase + (owner ? " with" : " without") + " an owner",
      () => {
        const current =
          phase === "waiting"
            ? paused({ owner })
            : state({
                phase,
                owner,
                disposition:
                  phase === "done"
                    ? {
                        kind: "completed",
                        reason: "Delivered",
                        at: NOW,
                        evidenceArtifactIds: [],
                      }
                    : null,
              });
        const status =
          phase === "waiting"
            ? "blocked"
            : phase === "done"
              ? "closed"
              : phase === "deferred"
                ? "deferred"
                : "open";
        assert.doesNotThrow(() =>
          validateLifecycleV2(current, issue(current, status)),
        );
        assert.deepEqual(decodeLifecycleV2(current), {
          ok: true,
          value: current,
        });
      },
    );
  }
}

test("rejects active work without an owner", () => {
  const current = state({ phase: "active" });
  assert.throws(
    () => validateLifecycleV2(current, issue(current, "in_progress")),
    /owner/,
  );
});

test("rejects a blocked record without a matching pause", () => {
  for (const pause of [
    null,
    { ...paused().pause!, conditionFingerprint: "0".repeat(64) },
  ]) {
    const current = paused({ pause });
    current.pause = pause;
    assert.throws(
      () => validateLifecycleV2(current, issue(current, "blocked")),
      /pause|fingerprint/,
    );
  }
});

test("pending requirements coexist with active work and retained resources", () => {
  const current = withCheck({ resources: [resource()] });
  assert.doesNotThrow(() =>
    validateLifecycleV2(current, issue(current, "in_progress")),
  );
  const blocked = paused({ resources: [resource()] });
  assert.doesNotThrow(() =>
    validateLifecycleV2(blocked, issue(blocked, "blocked")),
  );
});

test("unowned and terminal tasks cannot retain worktrees", () => {
  for (const current of [
    paused({ owner: null, resources: [resource()] }),
    state({ phase: "deferred", owner: OWNER, resources: [resource()] }),
    state({
      phase: "done",
      owner: OWNER,
      resources: [resource()],
      disposition: {
        kind: "completed",
        reason: "Done",
        at: NOW,
        evidenceArtifactIds: [],
      },
    }),
  ]) {
    const status =
      current.phase === "done"
        ? "closed"
        : current.phase === "deferred"
          ? "deferred"
          : "blocked";
    assert.throws(
      () => validateLifecycleV2(current, issue(current, status)),
      /worktree|resource/,
    );
  }
});

test("criterion fingerprints ignore observations but include fulfillment changes", () => {
  const current = withCheck();
  const fingerprint = fingerprintConditionV2(current, []);
  assert.equal(
    fingerprintConditionV2(
      {
        ...current,
        activeCheck: check({
          state: "error",
          lastCheckedAt: LATER,
          nextCheckAt: LATER,
          lastObservation: "temporary error",
          errorCount: 4,
        }),
      },
      [],
    ),
    fingerprint,
  );
  assert.notEqual(
    fingerprintConditionV2(
      { ...current, activeCheck: check({ predicate: { answer: "yes" } }) },
      [],
    ),
    fingerprint,
  );
  assert.notEqual(
    fingerprintConditionV2(
      {
        ...current,
        condition: { ...current.condition!, purpose: "continuation" },
      },
      [],
    ),
    fingerprint,
  );
});

test("native condition fingerprints ignore dependency status, not identity", () => {
  const current = state({
    condition: { id: "deps", kind: "dependency", purpose: "completion" },
  });
  const fingerprint = fingerprintConditionV2(current, [pendingDependency]);
  assert.equal(
    fingerprintConditionV2(current, [
      { ...pendingDependency, status: "closed" },
    ]),
    fingerprint,
  );
  assert.notEqual(
    fingerprintConditionV2(current, [{ ...pendingDependency, id: "jp-other" }]),
    fingerprint,
  );
});

test("a runnable claim starts work without a second start operation", () => {
  const next = claimLifecycleV2(state(), actor("claim"));
  assert.equal(next.phase, "active");
  assert.deepEqual(next.owner, OWNER);
  assert.equal(next.transitionHistory.at(-1)?.type, "claim");
});

test("claiming blocked work and repeating its claim never resumes it", () => {
  const current = paused({ owner: null });
  const next = claimLifecycleV2(current, actor("claim", LATER));
  assert.equal(next.phase, "waiting");
  assert.deepEqual(next.pause, current.pause);
  assert.equal(next.stateEnteredAt, NOW);
  assert.deepEqual(claimLifecycleV2(next, actor("repeat", LATER)), next);
  assert.throws(
    () => claimLifecycleV2(next, { ...actor("steal"), sessionId: "other" }),
    /owned/,
  );
});

test("block retains ownership and worktrees while binding a new pause", () => {
  const current = withCheck({ resources: [resource()] });
  const next = blockLifecycleV2(current, {
    ...actor("block", LATER),
    conditionFingerprint: fingerprintConditionV2(current, [])!,
    reason: "Waiting for the decision",
  });
  assert.equal(next.phase, "waiting");
  assert.deepEqual(next.owner, OWNER);
  assert.deepEqual(next.resources, current.resources);
  assert.equal(next.pause?.id, "block");
  assert.equal(next.pause?.blockedAt, LATER);
  assert.deepEqual(
    blockLifecycleV2(next, {
      ...actor("block", LATER),
      conditionFingerprint: fingerprintConditionV2(next, [])!,
      reason: "Waiting for the decision",
    }),
    next,
  );
});

test("block rejects a stale condition and missing ownership", () => {
  const current = withCheck();
  assert.throws(
    () =>
      blockLifecycleV2(current, {
        ...actor("block"),
        conditionFingerprint: "0".repeat(64),
        reason: "Wait",
      }),
    /condition/,
  );
  assert.throws(
    () =>
      blockLifecycleV2(
        { ...current, owner: null },
        {
          ...actor("block"),
          conditionFingerprint: fingerprintConditionV2(current, [])!,
          reason: "Wait",
        },
      ),
    /owner/,
  );
});

test("resume ends only the pause and requires a reason for independent work", () => {
  const current = paused();
  assert.throws(
    () => resumeLifecycleV2(current, { ...actor("resume"), reason: "" }),
    /reason/,
  );
  const next = resumeLifecycleV2(current, {
    ...actor("resume", LATER),
    reason: "Run independent staging validation",
  });
  assert.equal(next.phase, "active");
  assert.equal(next.pause, null);
  assert.deepEqual(next.owner, current.owner);
  assert.deepEqual(next.condition, current.condition);
  assert.deepEqual(next.activeCheck, current.activeCheck);
});

test("release exposes corrective work without dropping a merge requirement", () => {
  const current = withCheck({
    activeCheck: check({ state: "action_required" }),
  });
  const next = releaseLifecycleV2(current, {
    ...actor("release"),
    reason: "Hand off corrections",
  });
  assert.equal(next.owner, null);
  assert.equal(next.phase, "actionable");
  assert.deepEqual(next.condition, current.condition);
  assert.deepEqual(next.activeCheck, current.activeCheck);
});

test("release preserves an explicit blocked pause", () => {
  const current = paused();
  const next = releaseLifecycleV2(current, {
    ...actor("release"),
    reason: "Hand off",
  });
  assert.equal(next.owner, null);
  assert.equal(next.phase, "waiting");
  assert.deepEqual(next.pause, current.pause);
});

test("release respects native dependencies instead of making blocked work actionable", () => {
  const current = state({
    phase: "active",
    owner: OWNER,
    condition: { id: "deps", kind: "dependency", purpose: "completion" },
  });
  const next = releaseLifecycleV2(
    current,
    { ...actor("release"), reason: "Hand off" },
    [pendingDependency],
  );
  assert.equal(next.owner, null);
  assert.equal(next.phase, "waiting");
  assert.ok(next.pause);
  assert.deepEqual(next.condition, current.condition);
});

for (const cleanupState of [
  "active",
  "acquiring",
  "release_pending",
  "needs_attention",
] as const) {
  test("release rejects worktree state " + cleanupState, () => {
    const current = withCheck({ resources: [resource({ cleanupState })] });
    assert.throws(
      () =>
        releaseLifecycleV2(current, {
          ...actor("release"),
          reason: "Hand off",
        }),
      /worktree|resource/,
    );
  });
}

test("old claim and release retries cannot change a later ownership episode", () => {
  const first = claimLifecycleV2(state(), actor("claim-first"));
  const released = releaseLifecycleV2(first, {
    ...actor("release-first"),
    reason: "Hand off",
  });
  assert.throws(
    () => claimLifecycleV2(released, actor("claim-first")),
    /operation|claim/,
  );
  const later = claimLifecycleV2(released, actor("claim-later", LATER));
  const retry = releaseLifecycleV2(later, {
    ...actor("release-first"),
    reason: "Hand off",
  });
  assert.deepEqual(retry, later);
  assert.deepEqual(
    releaseLifecycleV2(released, {
      ...actor("release-first"),
      reason: "Hand off",
    }),
    released,
  );
});

test("close cannot treat action-required as fulfilled completion", () => {
  const current = withCheck({
    activeCheck: check({ state: "action_required" }),
  });
  assert.throws(
    () =>
      closeLifecycleV2(current, {
        ...actor("close"),
        disposition: {
          kind: "completed",
          reason: "Delivered",
          at: NOW,
          evidenceArtifactIds: [],
        },
      }),
    /requirement|condition/,
  );
});

test("completed work keeps its owner until release without execution authority", () => {
  const current = withCheck({ activeCheck: check({ state: "satisfied" }) });
  const done = closeLifecycleV2(current, {
    ...actor("close"),
    disposition: {
      kind: "completed",
      reason: "Delivered",
      at: NOW,
      evidenceArtifactIds: [],
    },
  });
  assert.equal(done.phase, "done");
  assert.deepEqual(done.owner, OWNER);
  assert.equal(done.condition, null);
  assert.equal(done.activeCheck, null);
  assert.equal(done.checkHistory.length, 1);
  assert.throws(
    () => resumeLifecycleV2(done, { ...actor("resume"), reason: "More work" }),
    /reopen|phase/,
  );
  assert.equal(
    releaseLifecycleV2(done, { ...actor("release"), reason: "Done" }).phase,
    "done",
  );
});

test("deferral parks rather than abandons an unmet completion requirement", () => {
  const current = withCheck();
  const parked = deferLifecycleV2(current, {
    ...actor("defer"),
    reason: "Park this work",
  });
  assert.equal(parked.phase, "deferred");
  assert.deepEqual(parked.owner, OWNER);
  assert.deepEqual(parked.condition, current.condition);
  assert.deepEqual(parked.activeCheck, current.activeCheck);
  const reopened = reopenLifecycleV2(parked, {
    ...actor("reopen"),
    reason: "Continue",
  });
  assert.equal(reopened.phase, "actionable");
  assert.deepEqual(reopened.owner, OWNER);
  assert.deepEqual(reopened.condition, current.condition);
});

test("new decoding is opt-in and cannot silently coerce future versions", () => {
  const legacy = createActionableLifecycle(NOW);
  assert.deepEqual(decodeLifecycleAny(legacy), { ok: true, value: legacy });
  assert.equal(decodeLifecycle(state()).ok, false);
  assert.equal(decodeLifecycleAny({ ...state(), version: 99 }).ok, false);
  assert.equal(decodeLifecycleV2({ ...state(), unexpected: true }).ok, false);
  assert.equal(
    decodeLifecycleV2({ ...state(), owner: { ...OWNER, unexpected: true } }).ok,
    false,
  );
});
