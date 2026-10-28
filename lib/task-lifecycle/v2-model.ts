import { createHash } from "node:crypto";
import {
  assertExactKeys,
  assertRecord,
  assertText,
  assertTimestamp,
  decodeLifecycle,
  requireInvariant,
  validateCommonLifecycleFields,
  validateCommonLifecycleReferences,
} from "./model.js";
import { ownerOf } from "./ownership.js";
import type {
  BlockInput,
  CloseInputV2,
  LifecycleIssueV2,
  LifecycleMetadata,
  LifecycleMetadataV2,
  LifecyclePhase,
  LifecycleStatus,
  LifecycleV2Input,
  NativeDependency,
  ReleaseInput,
  ResumeInput,
} from "./types.js";

type Decoded<T> = { ok: true; value: T } | { ok: false; warning: string };
type Dependencies = readonly NativeDependency[];

export function decodeLifecycleAny(value: unknown): Decoded<LifecycleMetadata> {
  return value !== null &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 2
    ? decodeLifecycleV2(value)
    : decodeLifecycle(value);
}

export function decodeLifecycleV2(
  value: unknown,
): Decoded<LifecycleMetadataV2> {
  try {
    const row = assertRecord(value, "piLifecycle v2");
    requireInvariant(row.version === 2, "unsupported piLifecycle version");
    assertExactKeys(
      row,
      [
        "version",
        "phase",
        "owner",
        "condition",
        "pause",
        "stateEnteredAt",
        "lastProgressAt",
        "artifacts",
        "activeCheck",
        "checkHistory",
        "transitionHistory",
        "resources",
        "disposition",
      ],
      "piLifecycle v2",
    );
    validateCommonLifecycleFields(row);
    if (row.owner !== null) {
      const owner = assertRecord(row.owner, "owner");
      assertExactKeys(
        owner,
        ["sessionId", "claimedAt", "lastActivityAt"],
        "owner",
      );
      assertText(owner.sessionId, "owner.sessionId");
      assertTimestamp(owner.claimedAt, "owner.claimedAt");
      assertTimestamp(owner.lastActivityAt, "owner.lastActivityAt");
    }
    if (row.condition !== null) {
      const condition = assertRecord(row.condition, "condition");
      assertExactKeys(condition, ["id", "kind", "purpose"], "condition");
      assertText(condition.id, "condition.id");
      requireInvariant(
        condition.kind === "check" || condition.kind === "dependency",
        "invalid condition kind",
      );
      requireInvariant(
        condition.purpose === "completion" ||
          condition.purpose === "continuation",
        "invalid condition purpose",
      );
    }
    if (row.pause !== null) {
      const pause = assertRecord(row.pause, "pause");
      assertExactKeys(
        pause,
        ["id", "conditionFingerprint", "blockedAt", "observationFingerprint"],
        "pause",
      );
      assertText(pause.id, "pause.id");
      assertFingerprint(
        pause.conditionFingerprint,
        "pause.conditionFingerprint",
      );
      assertTimestamp(pause.blockedAt, "pause.blockedAt");
      if (pause.observationFingerprint !== null)
        assertFingerprint(
          pause.observationFingerprint,
          "pause.observationFingerprint",
        );
    }
    return { ok: true, value: row as unknown as LifecycleMetadataV2 };
  } catch (error) {
    return {
      ok: false,
      warning:
        "invalid piLifecycle v2: " +
        (error instanceof Error ? error.message : "invalid record"),
    };
  }
}

export function nativeStatusV2(state: LifecycleMetadataV2): LifecycleStatus {
  if (state.phase === "active") return "in_progress";
  if (state.phase === "done") return "closed";
  if (state.phase === "deferred") return "deferred";
  return state.phase === "waiting" && state.condition?.kind === "check"
    ? "blocked"
    : "open";
}

export function validateLifecycleV2(
  state: LifecycleMetadataV2,
  issue: LifecycleIssueV2,
): void {
  const decoded = decodeLifecycleV2(state);
  requireInvariant(decoded.ok, decoded.ok ? "" : decoded.warning);
  const owner = ownerOf(state);
  requireInvariant(
    issue.status === nativeStatusV2(state),
    "work phase conflicts with native status",
  );
  validateCommonLifecycleReferences(state);
  if (owner === null || state.phase === "done" || state.phase === "deferred")
    requireReleasedResources(state);
  const blockers = unresolvedDependencies(issue.dependencies);
  if (state.phase === "done") {
    requireInvariant(state.disposition !== null, "done requires a disposition");
    requireInvariant(
      state.condition === null && state.activeCheck === null,
      "done must not retain a condition",
    );
  } else {
    requireInvariant(
      state.disposition === null,
      "only done may have a disposition",
    );
    if (state.condition === null) {
      requireInvariant(
        state.activeCheck === null,
        "check payload requires a condition",
      );
      requireInvariant(
        blockers.length === 0,
        "native blockers require a dependency condition",
      );
    } else if (state.condition.kind === "dependency") {
      requireInvariant(
        state.activeCheck === null,
        "dependency condition cannot have a check payload",
      );
    } else {
      requireInvariant(
        state.activeCheck !== null,
        "check condition requires a check payload",
      );
      requireInvariant(
        blockers.length === 0,
        "one check cannot coexist with native blockers",
      );
      if (state.activeCheck.kind === "time")
        assertTimestamp(
          state.activeCheck.predicate.at,
          "time check predicate.at",
        );
      if (
        state.activeCheck.kind === "manual" &&
        state.activeCheck.predicate.reviewAt !== undefined
      )
        assertTimestamp(
          state.activeCheck.predicate.reviewAt,
          "manual check predicate.reviewAt",
        );
    }
  }
  if (state.phase === "waiting") {
    requireInvariant(
      state.condition !== null && state.pause !== null,
      "blocked task requires a condition and pause",
    );
    requireInvariant(
      state.pause.conditionFingerprint ===
        fingerprintConditionV2(state, issue.dependencies),
      "pause condition fingerprint no longer matches",
    );
  } else {
    requireInvariant(
      state.pause === null,
      "only blocked work may retain a pause",
    );
  }
}

export function fingerprintConditionV2(
  state: LifecycleMetadataV2,
  dependencies: Dependencies,
): string | null {
  if (state.condition === null) return null;
  const check = state.activeCheck;
  const artifacts = new Map(
    state.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  return digest({
    condition: state.condition,
    criterion:
      state.condition.kind === "dependency"
        ? dependencies
            .filter((dep) => dep.dependencyType === "blocks")
            .map((dep) => dep.id)
            .sort()
        : check === null
          ? null
          : {
              id: check.id,
              kind: check.kind,
              predicate: check.predicate,
              targets: [...check.targetArtifactIds].sort().map((id) => {
                const artifact = artifacts.get(id);
                return artifact
                  ? {
                      id,
                      kind: artifact.kind,
                      uri: artifact.uri,
                      supersededAt: artifact.supersededAt,
                    }
                  : { id, missing: true };
              }),
            },
  });
}

export function fingerprintObservationV2(
  state: LifecycleMetadataV2,
): string | null {
  const check = state.activeCheck;
  return check === null || check.lastObservation === null
    ? null
    : digest({ state: check.state, observation: check.lastObservation });
}

export function conditionFulfilledV2(
  state: LifecycleMetadataV2,
  dependencies: Dependencies,
): boolean {
  if (state.condition === null) return true;
  return state.condition.kind === "dependency"
    ? unresolvedDependencies(dependencies).length === 0
    : state.activeCheck?.state === "satisfied";
}

export function claimLifecycleV2(
  state: LifecycleMetadataV2,
  input: LifecycleV2Input,
): LifecycleMetadataV2 {
  validateInput(input);
  if (state.owner !== null) {
    requireInvariant(
      state.owner.sessionId === input.sessionId,
      "task is owned by another session",
    );
    return state;
  }
  requireInvariant(
    !applied(state, input, "claim"),
    "claim operation was already used for released ownership",
  );
  requireInvariant(
    state.phase === "actionable" || state.phase === "waiting",
    "claim requires runnable or blocked work; reopen terminal work first",
  );
  requireReleasedResources(state);
  return transition(
    {
      ...state,
      owner: {
        sessionId: input.sessionId,
        claimedAt: input.now,
        lastActivityAt: input.now,
      },
    },
    input,
    "claim",
    state.phase === "waiting" ? "waiting" : "active",
  );
}

export function blockLifecycleV2(
  state: LifecycleMetadataV2,
  input: BlockInput,
  dependencies: Dependencies = [],
): LifecycleMetadataV2 {
  requireOwner(state, input);
  if (applied(state, input, "block")) return state;
  requireInvariant(
    ["active", "actionable", "waiting"].includes(state.phase),
    "block requires nonterminal work",
  );
  assertText(input.reason, "block reason");
  const fingerprint = fingerprintConditionV2(state, dependencies);
  requireInvariant(
    fingerprint !== null && fingerprint === input.conditionFingerprint,
    "blocking condition changed or is missing",
  );
  requireInvariant(
    !conditionFulfilledV2(state, dependencies),
    "blocking condition is already fulfilled",
  );
  return transition(
    {
      ...state,
      pause: {
        id: input.operationId,
        conditionFingerprint: fingerprint,
        blockedAt: input.now,
        observationFingerprint: fingerprintObservationV2(state),
      },
    },
    input,
    "block",
    "waiting",
    input.reason,
  );
}

export function resumeLifecycleV2(
  state: LifecycleMetadataV2,
  input: ResumeInput,
): LifecycleMetadataV2 {
  requireOwner(state, input);
  if (applied(state, input, "resume")) return state;
  requireInvariant(
    state.phase === "waiting" || state.phase === "actionable",
    "resume requires blocked or ready phase; reopen terminal work first",
  );
  assertText(input.reason, "resume reason");
  return transition(
    { ...state, pause: null },
    input,
    "resume",
    "active",
    input.reason,
  );
}

export function releaseLifecycleV2(
  state: LifecycleMetadataV2,
  input: ReleaseInput,
  dependencies: Dependencies = [],
): LifecycleMetadataV2 {
  validateInput(input);
  if (state.owner !== null)
    requireInvariant(
      state.owner.sessionId === input.sessionId,
      "task is owned by another session",
    );
  if (applied(state, input, "release")) return state;
  requireOwner(state, input);
  assertText(input.reason, "release reason");
  requireReleasedResources(state);
  let next = { ...state, owner: null };
  let phase = state.phase;
  if (phase === "active" || phase === "actionable") {
    if (unresolvedDependencies(dependencies).length > 0) {
      requireInvariant(
        state.condition?.kind === "dependency",
        "native blockers require a dependency condition before release",
      );
      phase = "waiting";
      next = {
        ...next,
        pause: {
          id: input.operationId,
          conditionFingerprint: fingerprintConditionV2(state, dependencies)!,
          blockedAt: input.now,
          observationFingerprint: null,
        },
      };
    } else phase = "actionable";
  }
  return transition(next, input, "release", phase, input.reason);
}

export function closeLifecycleV2(
  state: LifecycleMetadataV2,
  input: CloseInputV2,
  dependencies: Dependencies = [],
): LifecycleMetadataV2 {
  validateInput(input);
  if (applied(state, input, "close")) return state;
  requireInvariant(state.phase !== "done", "task is already done");
  requireReleasedResources(state);
  if (input.disposition.kind === "completed") {
    requireInvariant(
      unresolvedDependencies(dependencies).length === 0,
      "completion has unresolved native requirements",
    );
    requireInvariant(
      state.condition?.purpose !== "completion" ||
        conditionFulfilledV2(state, dependencies),
      "completion condition is not fulfilled",
    );
  }
  // Reconciliation may close on behalf of an owner after validating its pause.
  const next = transition(
    {
      ...state,
      condition: null,
      pause: null,
      activeCheck: null,
      checkHistory:
        state.activeCheck === null
          ? state.checkHistory
          : [...state.checkHistory, state.activeCheck],
      disposition: input.disposition,
    },
    input,
    "close",
    "done",
    input.disposition.reason,
  );
  validateCommonLifecycleFields(next as unknown as Record<string, unknown>);
  validateCommonLifecycleReferences(next);
  return next;
}

export function deferLifecycleV2(
  state: LifecycleMetadataV2,
  input: ResumeInput,
): LifecycleMetadataV2 {
  requireOwner(state, input);
  if (applied(state, input, "defer")) return state;
  requireInvariant(
    ["active", "actionable", "waiting"].includes(state.phase),
    "defer requires nonterminal work",
  );
  assertText(input.reason, "defer reason");
  requireReleasedResources(state);
  return transition(
    { ...state, pause: null },
    input,
    "defer",
    "deferred",
    input.reason,
  );
}

export function reopenLifecycleV2(
  state: LifecycleMetadataV2,
  input: ResumeInput,
  dependencies: Dependencies = [],
): LifecycleMetadataV2 {
  validateInput(input);
  if (state.owner !== null) requireOwner(state, input);
  if (applied(state, input, "reopen")) return state;
  requireInvariant(
    state.phase === "done" || state.phase === "deferred",
    "reopen requires done or deferred phase",
  );
  assertText(input.reason, "reopen reason");
  requireReleasedResources(state);
  let next = { ...state, disposition: null };
  let phase: LifecyclePhase = "actionable";
  if (unresolvedDependencies(dependencies).length > 0) {
    requireInvariant(
      state.condition === null || state.condition.kind === "dependency",
      "native blockers conflict with retained check condition",
    );
    next = {
      ...next,
      condition: state.condition ?? {
        id: input.operationId,
        kind: "dependency",
        purpose: "completion",
      },
    };
    next = {
      ...next,
      pause: {
        id: input.operationId,
        conditionFingerprint: fingerprintConditionV2(next, dependencies)!,
        blockedAt: input.now,
        observationFingerprint: null,
      },
    };
    phase = "waiting";
  }
  return transition(next, input, "reopen", phase, input.reason);
}

function requireReleasedResources(state: LifecycleMetadataV2): void {
  const resource = state.resources.find(
    (item) => item.cleanupState !== "released",
  );
  requireInvariant(
    resource === undefined,
    "unreleased worktree resource " + resource?.claimId,
  );
}

function unresolvedDependencies(
  dependencies: Dependencies,
): NativeDependency[] {
  return dependencies.filter(
    (dep) => dep.dependencyType === "blocks" && dep.status !== "closed",
  );
}

function validateInput(input: LifecycleV2Input): void {
  assertText(input.operationId, "operationId");
  assertText(input.sessionId, "sessionId");
  assertTimestamp(input.now, "transition timestamp");
}

function requireOwner(
  state: LifecycleMetadataV2,
  input: LifecycleV2Input,
): void {
  validateInput(input);
  requireInvariant(state.owner !== null, "task has no owner");
  requireInvariant(
    state.owner.sessionId === input.sessionId,
    "task is owned by another session",
  );
}

function applied(
  state: LifecycleMetadataV2,
  input: LifecycleV2Input,
  type: string,
): boolean {
  const prior = state.transitionHistory.find(
    (entry) => entry.operationId === input.operationId,
  );
  if (!prior) return false;
  requireInvariant(
    prior.type === type && prior.sessionId === input.sessionId,
    "operationId conflicts with an earlier operation",
  );
  return true;
}

function transition(
  state: LifecycleMetadataV2,
  input: LifecycleV2Input,
  type: string,
  phase: LifecyclePhase,
  reason?: string,
): LifecycleMetadataV2 {
  return {
    ...state,
    phase,
    stateEnteredAt:
      phase === state.phase && type !== "block"
        ? state.stateEnteredAt
        : input.now,
    lastProgressAt:
      phase === "active" || phase === "done" ? input.now : state.lastProgressAt,
    transitionHistory: [
      ...state.transitionHistory,
      {
        operationId: input.operationId,
        type,
        at: input.now,
        from: state.phase,
        to: phase,
        sessionId: input.sessionId,
        ...(reason === undefined ? {} : { reason }),
      },
    ],
  };
}

function assertFingerprint(value: unknown, field: string): void {
  requireInvariant(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    field + " must be a SHA-256 fingerprint",
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
