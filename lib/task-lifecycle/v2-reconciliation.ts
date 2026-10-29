import { isDeepStrictEqual } from "node:util";
import { nextCheckBackoffMs, type CheckObservation } from "./checks.js";
import { assertTimestamp } from "./model.js";
import { ownerOf } from "./ownership.js";
import {
  fingerprintCheck,
  reconciliationAlreadyApplied,
  type PreparedCheckV2,
  type ReconcileResult,
} from "./reconciliation.js";
import {
  closeLifecycleV2,
  fingerprintConditionV2,
  fingerprintObservationV2,
} from "./v2-model.js";
import type { LifecycleIssueV2, LifecycleMetadataV2 } from "./types.js";

export interface ConditionObservationResultV2 {
  state: LifecycleMetadataV2;
  outcome: ReconcileResult["outcome"];
  transition: "none" | "facts" | "ready" | "closed" | "cleanup_required";
}

export interface ObservationPolicy {
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  cached?: boolean;
}

export function prepareConditionObservationV2(
  issue: LifecycleIssueV2,
  operationId: string,
  actorSessionId: string,
  manualOutcome?: "satisfied" | "action_required",
): PreparedCheckV2 {
  const state = issue.lifecycle;
  if (state.condition?.kind !== "check" || state.activeCheck === null)
    throw new Error(`task ${issue.id} does not retain a check`);
  const owner = ownerOf(state);
  return {
    lifecycleVersion: 2,
    taskId: issue.id,
    operationId,
    actorSessionId,
    fingerprint: fingerprintCheck(issue)!,
    conditionFingerprint: fingerprintConditionV2(state, issue.dependencies)!,
    pause: structuredClone(state.pause),
    owner:
      owner === null
        ? null
        : { sessionId: owner.sessionId, claimedAt: owner.claimedAt },
    ownershipOperationId: lastClaimOperationId(state),
    check: structuredClone(state.activeCheck),
    artifacts: structuredClone(state.artifacts),
    ...(manualOutcome === undefined ? {} : { manualOutcome }),
  };
}

export function applyConditionObservationV2(
  state: LifecycleMetadataV2,
  prepared: PreparedCheckV2,
  observation: CheckObservation,
  now: string,
  policy: ObservationPolicy = {},
): ConditionObservationResultV2 {
  const current = { id: prepared.taskId, lifecycle: state };
  if (reconciliationAlreadyApplied(current, prepared.operationId))
    return { state, outcome: "already_applied", transition: "none" };
  if (
    prepared.lifecycleVersion !== 2 ||
    state.condition?.kind !== "check" ||
    state.activeCheck === null ||
    state.phase === "done" ||
    fingerprintConditionV2(state, []) !== prepared.conditionFingerprint ||
    fingerprintCheck(current) !== prepared.fingerprint
  )
    return { state, outcome: "stale", transition: "none" };
  assertTimestamp(now, "observation timestamp");
  if (
    !policy.cached &&
    state.activeCheck.kind === "manual" &&
    prepared.manualOutcome === undefined &&
    (observation.outcome === "satisfied" ||
      observation.outcome === "action_required")
  )
    throw new Error(
      `task ${prepared.taskId} check requires an explicit manual outcome`,
    );
  if (
    prepared.manualOutcome !== undefined &&
    (state.activeCheck.kind !== "manual" ||
      prepared.manualOutcome !== observation.outcome)
  )
    throw new Error(
      `task ${prepared.taskId} observation does not match the explicit manual outcome`,
    );
  if (
    policy.cached &&
    (state.activeCheck.state !== "satisfied" ||
      state.activeCheck.lastCheckedAt === null ||
      state.activeCheck.lastObservation === null ||
      observation.outcome !== "satisfied" ||
      state.activeCheck.lastObservation !== observation.observation)
  )
    throw new Error(
      `task ${prepared.taskId} cached settlement requires its persisted satisfied observation`,
    );

  const poll = policy.pollIntervalMs ?? 900_000;
  const errors =
    observation.outcome === "error" ? state.activeCheck.errorCount + 1 : 0;
  const nextCheckAt =
    state.activeCheck.kind === "manual" || observation.outcome === "satisfied"
      ? null
      : new Date(
          Date.parse(now) +
            (errors > 0
              ? nextCheckBackoffMs(
                  errors,
                  poll,
                  policy.maxBackoffMs ?? 21_600_000,
                )
              : poll),
        ).toISOString();
  const check = policy.cached
    ? state.activeCheck
    : {
        ...state.activeCheck,
        state: observation.outcome,
        lastCheckedAt: now,
        lastObservation: observation.observation,
        errorCount: errors,
        nextCheckAt,
      };
  let next: LifecycleMetadataV2 = { ...state, activeCheck: check };
  const owner = ownerOf(state);
  const sameOwner =
    isDeepStrictEqual(
      prepared.owner,
      owner === null
        ? null
        : { sessionId: owner.sessionId, claimedAt: owner.claimedAt },
    ) && prepared.ownershipOperationId === lastClaimOperationId(state);
  const matchingPause =
    state.phase === "waiting" &&
    state.pause !== null &&
    prepared.pause !== null &&
    state.pause.id === prepared.pause.id &&
    state.pause.conditionFingerprint === prepared.conditionFingerprint &&
    sameOwner;
  const observedFingerprint = fingerprintObservationV2(next);
  const newAction =
    observation.outcome === "action_required" &&
    (prepared.manualOutcome !== undefined ||
      observedFingerprint !== state.pause?.observationFingerprint);
  const canContinue = observation.outcome === "satisfied" || newAction;
  let transition: ConditionObservationResultV2["transition"] = "facts";

  if (matchingPause && canContinue) {
    if (observation.outcome === "satisfied" && check.onSatisfied === "close") {
      if (
        state.resources.every(
          (resource) => resource.cleanupState === "released",
        )
      ) {
        return {
          state: closeLifecycleV2(next, {
            operationId: prepared.operationId,
            sessionId: prepared.actorSessionId,
            now,
            disposition: {
              kind: "completed",
              reason: `check ${check.id} satisfied: ${observation.observation}`,
              at: now,
              evidenceArtifactIds: check.targetArtifactIds,
            },
          }),
          outcome: "applied",
          transition: "closed",
        };
      }
      transition = "cleanup_required";
    } else transition = "ready";
    next = {
      ...next,
      phase: "actionable",
      pause: null,
      stateEnteredAt: now,
      lastProgressAt: now,
    };
  } else if (
    state.pause !== null &&
    !matchingPause &&
    observation.outcome === "action_required"
  ) {
    // A late aggregate is now known; another poll must not wake a newer pause with it.
    next = {
      ...next,
      pause: { ...state.pause, observationFingerprint: observedFingerprint },
    };
  }

  if (
    next.phase !== "waiting" &&
    next.condition?.purpose === "continuation" &&
    (observation.outcome === "satisfied" ||
      observation.outcome === "action_required") &&
    transition !== "cleanup_required"
  ) {
    next = {
      ...next,
      condition: null,
      activeCheck: null,
      checkHistory: [...next.checkHistory, check],
    };
  }
  if (
    (observation.outcome === "satisfied" ||
      observation.outcome === "action_required") &&
    fingerprintObservationV2(state) !== observedFingerprint
  )
    next = { ...next, lastProgressAt: now };
  next = {
    ...next,
    transitionHistory: [
      ...next.transitionHistory,
      {
        operationId: prepared.operationId,
        type: `check_${observation.outcome}`,
        at: now,
        from: state.phase,
        to: next.phase,
        sessionId: prepared.actorSessionId,
        reason: observation.observation,
      },
    ],
  };
  return { state: next, outcome: "applied", transition };
}

function lastClaimOperationId(state: LifecycleMetadataV2): string | null {
  for (let index = state.transitionHistory.length - 1; index >= 0; index--)
    if (state.transitionHistory[index].type === "claim")
      return state.transitionHistory[index].operationId;
  return null;
}
