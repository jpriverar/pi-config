import type {
  Artifact,
  ArtifactInput,
  ArtifactKind,
  ArtifactRole,
  CheckKind,
  CheckState,
  ClaimInput,
  CloseInput,
  DecodeLifecycleResult,
  Disposition,
  DispositionKind,
  ExecutionLease,
  InterruptInput,
  LegacyLifecycleAdoption,
  LifecycleCheck,
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecyclePhase,
  LifecycleTransition,
  ReopenInput,
  WaitingKind,
  WaitInput,
  WorktreeCleanupState,
  WorktreeResource,
} from "./types.js";

const PHASES: readonly LifecyclePhase[] = [
  "actionable",
  "active",
  "waiting",
  "deferred",
  "done",
];
const WAITING_KINDS: readonly WaitingKind[] = ["dependency", "check"];
const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "branch",
  "commit",
  "pull_request",
  "document",
  "dashboard",
  "deployment",
  "report",
  "other",
];
const ARTIFACT_ROLES: readonly ArtifactRole[] = [
  "deliverable",
  "evidence",
  "supporting",
];
const CHECK_KINDS: readonly CheckKind[] = [
  "github_pull_request",
  "time",
  "manual",
];
const CHECK_STATES: readonly CheckState[] = [
  "pending",
  "satisfied",
  "action_required",
  "error",
];
const DISPOSITIONS: readonly DispositionKind[] = [
  "completed",
  "cancelled",
  "superseded",
];
const CLEANUP_STATES: readonly WorktreeCleanupState[] = [
  "acquiring",
  "active",
  "release_pending",
  "released",
  "needs_attention",
];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function decodeLifecycle(value: unknown): DecodeLifecycleResult {
  if (!isRecord(value)) {
    return { ok: false, warning: "invalid piLifecycle: expected an object" };
  }
  if (value.version !== 1) {
    return {
      ok: false,
      warning: `unsupported piLifecycle version ${String(value.version)}`,
    };
  }
  try {
    validateLifecycleShape(value);
    return { ok: true, value: value as unknown as LifecycleMetadataV1 };
  } catch (error) {
    return {
      ok: false,
      warning: `invalid piLifecycle: ${errorMessage(error)}`,
    };
  }
}

export function validateLifecycle(
  lifecycle: LifecycleMetadataV1,
  issue: LifecycleIssue,
): void {
  const decoded = decodeLifecycle(lifecycle);
  if (!decoded.ok) throw new Error(decoded.warning);

  const unresolvedBlockers = issue.dependencies.filter(
    (dependency) =>
      dependency.dependencyType === "blocks" && dependency.status !== "closed",
  );
  if (lifecycle.phase === "active") {
    requireInvariant(
      issue.status === "in_progress",
      "phase active requires native status in_progress",
    );
    requireInvariant(
      lifecycle.execution !== null,
      "phase active requires one execution lease",
    );
    requireInvariant(
      lifecycle.waiting === null,
      "phase active must not retain waiting state",
    );
    requireInvariant(
      lifecycle.activeCheck === null,
      "phase active must not retain an active check",
    );
  } else {
    requireInvariant(
      lifecycle.execution === null,
      "only phase active may retain an execution lease",
    );
  }

  if (lifecycle.phase === "actionable") {
    requireInvariant(
      issue.status === "open",
      "phase actionable requires native status open",
    );
    requireInvariant(
      lifecycle.waiting === null,
      "phase actionable must not retain waiting state",
    );
    requireInvariant(
      lifecycle.activeCheck === null,
      "phase actionable must not have an active check",
    );
    requireInvariant(
      unresolvedBlockers.length === 0,
      "phase actionable must not have unresolved blockers",
    );
  }

  if (lifecycle.phase === "waiting") {
    requireInvariant(
      lifecycle.waiting !== null,
      "phase waiting requires exactly one waiting subtype",
    );
    requireNoUnreleasedWorktrees(lifecycle);
    if (lifecycle.waiting?.kind === "dependency") {
      requireInvariant(
        issue.status === "open",
        "dependency wait requires native status open",
      );
      requireInvariant(
        unresolvedBlockers.length > 0,
        "dependency wait requires at least one unresolved blocker",
      );
      requireInvariant(
        lifecycle.activeCheck === null,
        "dependency wait must not have an active check",
      );
    } else if (lifecycle.waiting?.kind === "check") {
      requireInvariant(
        issue.status === "blocked",
        "check wait requires native status blocked",
      );
      requireInvariant(
        lifecycle.activeCheck !== null,
        "check wait requires one active check",
      );
      requireInvariant(
        unresolvedBlockers.length === 0,
        "check wait must not have unresolved blockers",
      );
    }
  } else {
    requireInvariant(
      lifecycle.waiting === null,
      `phase ${lifecycle.phase} must not retain waiting state`,
    );
  }

  if (lifecycle.phase === "deferred") {
    requireInvariant(
      issue.status === "deferred",
      "phase deferred requires native status deferred",
    );
    requireInvariant(
      lifecycle.activeCheck === null,
      "phase deferred must not retain an active check",
    );
  }

  if (lifecycle.phase === "done") {
    requireInvariant(
      issue.status === "closed",
      "phase done requires native status closed",
    );
    requireInvariant(
      lifecycle.disposition !== null,
      "phase done requires a disposition",
    );
    requireInvariant(
      lifecycle.activeCheck === null,
      "phase done must not retain an active check",
    );
    requireNoUnreleasedWorktrees(lifecycle);
  } else {
    requireInvariant(
      lifecycle.disposition === null,
      `phase ${lifecycle.phase} must not retain a disposition`,
    );
  }

  validateUniqueArtifacts(lifecycle.artifacts);
  validateUniqueResources(lifecycle.resources);
  validateCheckTargets(lifecycle);
}

export function createActionableLifecycle(now: string): LifecycleMetadataV1 {
  assertTimestamp(now, "task creation timestamp");
  return {
    version: 1,
    phase: "actionable",
    waiting: null,
    stateEnteredAt: now,
    lastProgressAt: now,
    execution: null,
    artifacts: [],
    activeCheck: null,
    checkHistory: [],
    transitionHistory: [],
    resources: [],
    disposition: null,
  };
}

export function adoptLegacyLifecycle(
  issue: LifecycleIssue,
  readyIds: ReadonlySet<string>,
  now: string,
): LegacyLifecycleAdoption {
  assertTimestamp(now, "legacy adoption timestamp");
  const warnings: string[] = [];
  let phase: LifecyclePhase;
  let waiting: LifecycleMetadataV1["waiting"] = null;
  let disposition: Disposition | null = null;

  if (issue.status === "closed") {
    phase = "done";
    disposition = {
      kind: "completed",
      reason: "legacy closed issue",
      at: now,
      evidenceArtifactIds: [],
    };
  } else if (issue.status === "deferred") {
    phase = "deferred";
  } else if (issue.status === "blocked") {
    phase = "waiting";
    waiting = { kind: "check" };
    warnings.push("legacy blocked issue has no structured check");
  } else if (issue.status === "in_progress") {
    phase = "actionable";
    warnings.push("legacy in_progress ownership was not trusted");
  } else if (unresolvedBlockers(issue).length > 0) {
    phase = "waiting";
    waiting = { kind: "dependency" };
  } else {
    phase = "actionable";
    if (!readyIds.has(issue.id)) {
      warnings.push("legacy open issue is not reported ready by Beads");
    }
  }

  return {
    lifecycle: {
      version: 1,
      phase,
      waiting,
      stateEnteredAt: now,
      lastProgressAt: now,
      execution: null,
      artifacts: [],
      activeCheck: null,
      checkHistory: [],
      transitionHistory: [],
      resources: [],
      disposition,
    },
    warnings,
  };
}

export function canonicalizeArtifact(
  input: ArtifactInput,
  now: string,
  sessionId?: string,
): Artifact {
  assertEnum(input.kind, ARTIFACT_KINDS, "artifact kind");
  assertEnum(input.role, ARTIFACT_ROLES, "artifact role");
  assertText(input.id, "artifact id");
  assertText(input.title, "artifact title");
  assertTimestamp(input.producedAt ?? now, "artifact producedAt");
  if (input.supersededAt !== undefined && input.supersededAt !== null) {
    assertTimestamp(input.supersededAt, "artifact supersededAt");
  }
  if (sessionId !== undefined)
    assertText(sessionId, "artifact producer session");

  const artifact: Artifact = {
    id: input.id.trim(),
    kind: input.kind,
    uri: canonicalArtifactUri(input.kind, input.uri),
    title: input.title.trim(),
    role: input.role,
    sourceArtifactIds: uniqueTexts(
      input.sourceArtifactIds ?? [],
      "source artifact id",
    ),
    producedAt: input.producedAt ?? now,
    ...(sessionId === undefined ? {} : { producedBySession: sessionId }),
    supersededAt: input.supersededAt ?? null,
  };
  validateArtifact(artifact, "artifact");
  return artifact;
}

export function attachArtifact(
  state: LifecycleMetadataV1,
  artifact: Artifact,
): LifecycleMetadataV1 {
  validateArtifact(artifact, "artifact");
  const idMatch = state.artifacts.find(
    (existing) => existing.id === artifact.id,
  );
  if (
    idMatch !== undefined &&
    (idMatch.kind !== artifact.kind || idMatch.uri !== artifact.uri)
  ) {
    throw new Error(
      `artifact id ${artifact.id} already identifies another artifact`,
    );
  }
  const index = state.artifacts.findIndex(
    (existing) =>
      existing.kind === artifact.kind && existing.uri === artifact.uri,
  );
  if (index === -1) {
    return { ...state, artifacts: [...state.artifacts, artifact] };
  }

  const existing = state.artifacts[index];
  const merged: Artifact = {
    ...existing,
    sourceArtifactIds: [
      ...new Set([
        ...existing.sourceArtifactIds,
        ...artifact.sourceArtifactIds,
      ]),
    ],
    ...(existing.producedBySession === undefined &&
    artifact.producedBySession !== undefined
      ? { producedBySession: artifact.producedBySession }
      : {}),
  };
  const artifacts = [...state.artifacts];
  artifacts[index] = merged;
  return { ...state, artifacts };
}

export function claimLifecycle(
  state: LifecycleMetadataV1,
  input: ClaimInput,
): LifecycleMetadataV1 {
  if (hasOperation(state, input.operationId)) return state;
  requireInvariant(
    state.phase === "actionable",
    "claim requires phase actionable",
  );
  requireInvariant(
    state.execution === null,
    "claim requires no execution lease",
  );
  assertText(input.operationId, "claim operationId");
  assertText(input.sessionId, "claim sessionId");
  assertTimestamp(input.now, "claim timestamp");
  assertTimestamp(input.expiresAt, "claim expiresAt");
  assertTimestamp(
    input.resourceSnapshot.observedAt,
    "resource snapshot timestamp",
  );
  const knownResourceIds = new Set(
    state.resources.map((resource) => resource.id),
  );
  for (const resourceId of input.resourceSnapshot.resourceIds) {
    requireInvariant(
      knownResourceIds.has(resourceId),
      `resource snapshot references unknown resource ${resourceId}`,
    );
  }
  const execution: ExecutionLease = {
    sessionId: input.sessionId,
    claimedAt: input.now,
    lastActivityAt: input.now,
    expiresAt: input.expiresAt,
    resourceSnapshot: {
      observedAt: input.resourceSnapshot.observedAt,
      resourceIds: [...new Set(input.resourceSnapshot.resourceIds)],
    },
  };
  return transition(
    { ...state, execution, waiting: null, activeCheck: null },
    input.operationId,
    "claim",
    input.now,
    "active",
    { sessionId: input.sessionId },
  );
}

export function waitLifecycle(
  state: LifecycleMetadataV1,
  input: WaitInput,
): LifecycleMetadataV1 {
  if (hasOperation(state, input.operationId)) return state;
  requireInvariant(state.phase === "active", "wait requires phase active");
  requireInvariant(
    state.execution !== null,
    "wait requires an execution lease",
  );
  requireNoUnreleasedWorktrees(state);
  assertText(input.operationId, "wait operationId");
  assertTimestamp(input.now, "wait timestamp");
  assertEnum(input.kind, WAITING_KINDS, "waiting kind");
  if (input.kind === "dependency") {
    requireInvariant(
      input.check === undefined,
      "dependency wait must not have an active check",
    );
  } else {
    requireInvariant(
      input.check !== undefined,
      "check wait requires one active check",
    );
    validateCheck(input.check!, "active check");
  }
  return transition(
    {
      ...state,
      execution: null,
      waiting: { kind: input.kind },
      activeCheck: input.kind === "check" ? input.check! : null,
    },
    input.operationId,
    "wait",
    input.now,
    "waiting",
    input.reason === undefined ? {} : { reason: input.reason },
  );
}

export function deferLifecycle(
  state: LifecycleMetadataV1,
  input: { operationId: string; now: string; reason: string },
): LifecycleMetadataV1 {
  if (hasOperation(state, input.operationId)) return state;
  requireInvariant(state.phase === "active", "defer requires phase active");
  requireInvariant(
    state.execution !== null,
    "defer requires an execution lease",
  );
  requireNoUnreleasedWorktrees(state);
  assertText(input.operationId, "defer operationId");
  assertTimestamp(input.now, "defer timestamp");
  assertText(input.reason, "defer reason");
  const checkHistory =
    state.activeCheck === null ||
    state.checkHistory.some(
      (candidate) => candidate.id === state.activeCheck?.id,
    )
      ? state.checkHistory
      : [...state.checkHistory, state.activeCheck];
  return transition(
    {
      ...state,
      execution: null,
      waiting: null,
      activeCheck: null,
      checkHistory,
    },
    input.operationId,
    "defer",
    input.now,
    "deferred",
    { reason: input.reason },
  );
}

export function closeLifecycle(
  state: LifecycleMetadataV1,
  input: CloseInput,
): LifecycleMetadataV1 {
  if (hasOperation(state, input.operationId)) return state;
  requireInvariant(
    state.execution === null,
    "close requires no execution lease",
  );
  requireNoUnreleasedWorktrees(state);
  assertText(input.operationId, "close operationId");
  assertTimestamp(input.now, "close timestamp");
  validateDisposition(input.disposition, "disposition");
  const checkHistory =
    state.activeCheck === null ||
    state.checkHistory.some(
      (candidate) => candidate.id === state.activeCheck?.id,
    )
      ? state.checkHistory
      : [...state.checkHistory, state.activeCheck];
  return transition(
    {
      ...state,
      waiting: null,
      activeCheck: null,
      checkHistory,
      disposition: input.disposition,
    },
    input.operationId,
    "close",
    input.now,
    "done",
    { reason: input.disposition.reason },
  );
}

export function interruptLifecycle(
  state: LifecycleMetadataV1,
  input: InterruptInput,
): LifecycleMetadataV1 {
  if (hasOperation(state, input.operationId)) return state;
  requireInvariant(state.phase === "active", "interrupt requires phase active");
  requireInvariant(
    state.execution !== null,
    "interrupt requires an execution lease",
  );
  assertText(input.operationId, "interrupt operationId");
  assertText(input.expectedSessionId, "interrupt expectedSessionId");
  assertTimestamp(input.now, "interrupt timestamp");
  requireInvariant(
    state.execution.sessionId === input.expectedSessionId,
    `execution belongs to session ${state.execution.sessionId}, not ${input.expectedSessionId}`,
  );
  const execution = state.execution;
  return transition(
    { ...state, execution: null },
    input.operationId,
    "execution_interrupted",
    input.now,
    "actionable",
    {
      sessionId: execution.sessionId,
      reason: `last activity ${execution.lastActivityAt}; observed ${input.now}`,
    },
  );
}

export function reopenLifecycle(
  state: LifecycleMetadataV1,
  input: ReopenInput,
): LifecycleMetadataV1 {
  if (hasOperation(state, input.operationId)) return state;
  requireInvariant(state.phase === "done", "reopen requires phase done");
  requireNoUnreleasedWorktrees(state);
  assertText(input.operationId, "reopen operationId");
  assertText(input.reason, "reopen reason");
  assertTimestamp(input.now, "reopen timestamp");
  const phase: LifecyclePhase = input.hasUnresolvedBlockers
    ? "waiting"
    : "actionable";
  return transition(
    {
      ...state,
      disposition: null,
      waiting: input.hasUnresolvedBlockers ? { kind: "dependency" } : null,
      activeCheck: null,
    },
    input.operationId,
    "reopen",
    input.now,
    phase,
    { reason: input.reason },
  );
}

function transition(
  state: LifecycleMetadataV1,
  operationId: string,
  type: string,
  at: string,
  to: LifecyclePhase,
  details: Pick<LifecycleTransition, "sessionId" | "reason">,
): LifecycleMetadataV1 {
  const from = state.phase;
  return {
    ...state,
    phase: to,
    stateEnteredAt: at,
    lastProgressAt: at,
    transitionHistory: [
      ...state.transitionHistory,
      { operationId, type, at, from, to, ...details },
    ],
  };
}

function hasOperation(
  state: LifecycleMetadataV1,
  operationId: string,
): boolean {
  return state.transitionHistory.some(
    (transition) => transition.operationId === operationId,
  );
}

function requireNoUnreleasedWorktrees(state: LifecycleMetadataV1): void {
  const unreleased = state.resources.find(
    (resource) => resource.cleanupState !== "released",
  );
  requireInvariant(
    unreleased === undefined,
    `lifecycle transition requires release of unreleased worktree ${unreleased?.id}`,
  );
}

function validateLifecycleShape(value: Record<string, unknown>): void {
  assertExactKeys(
    value,
    [
      "version",
      "phase",
      "waiting",
      "stateEnteredAt",
      "lastProgressAt",
      "execution",
      "artifacts",
      "activeCheck",
      "checkHistory",
      "transitionHistory",
      "resources",
      "disposition",
    ],
    "piLifecycle",
  );
  assertEnum(value.phase, PHASES, "phase");
  if (value.waiting !== null) {
    const waiting = assertRecord(value.waiting, "waiting");
    assertExactKeys(waiting, ["kind"], "waiting");
    assertEnum(waiting.kind, WAITING_KINDS, "waiting kind");
  }
  assertTimestamp(value.stateEnteredAt, "stateEnteredAt");
  assertTimestamp(value.lastProgressAt, "lastProgressAt");
  if (value.execution !== null) validateExecution(value.execution, "execution");
  for (const [index, artifact] of assertArray(
    value.artifacts,
    "artifacts",
  ).entries()) {
    validateArtifact(artifact, `artifact ${index}`);
  }
  if (value.activeCheck !== null)
    validateCheck(value.activeCheck, "active check");
  for (const [index, item] of assertArray(
    value.checkHistory,
    "checkHistory",
  ).entries()) {
    validateCheck(item, `check history ${index}`);
  }
  for (const [index, item] of assertArray(
    value.transitionHistory,
    "transitionHistory",
  ).entries()) {
    validateTransition(item, `transition ${index}`);
  }
  for (const [index, item] of assertArray(
    value.resources,
    "resources",
  ).entries()) {
    validateResource(item, `resource ${index}`);
  }
  if (value.disposition !== null)
    validateDisposition(value.disposition, "disposition");
}

function validateExecution(value: unknown, field: string): void {
  const execution = assertRecord(value, field);
  assertExactKeys(
    execution,
    [
      "sessionId",
      "claimedAt",
      "lastActivityAt",
      "expiresAt",
      "resourceSnapshot",
    ],
    field,
  );
  assertText(execution.sessionId, `${field}.sessionId`);
  assertTimestamp(execution.claimedAt, `${field}.claimedAt`);
  assertTimestamp(execution.lastActivityAt, `${field}.lastActivityAt`);
  assertTimestamp(execution.expiresAt, `${field}.expiresAt`);
  const snapshot = assertRecord(
    execution.resourceSnapshot,
    `${field}.resourceSnapshot`,
  );
  assertExactKeys(
    snapshot,
    ["observedAt", "resourceIds"],
    `${field}.resourceSnapshot`,
  );
  assertTimestamp(snapshot.observedAt, `${field}.resourceSnapshot.observedAt`);
  uniqueTexts(snapshot.resourceIds, `${field}.resourceSnapshot.resourceIds`);
}

function validateArtifact(
  value: unknown,
  field: string,
): asserts value is Artifact {
  const artifact = assertRecord(value, field);
  assertAllowedKeys(
    artifact,
    [
      "id",
      "kind",
      "uri",
      "title",
      "role",
      "sourceArtifactIds",
      "producedAt",
      "producedBySession",
      "supersededAt",
    ],
    field,
  );
  for (const required of [
    "id",
    "kind",
    "uri",
    "title",
    "role",
    "sourceArtifactIds",
    "producedAt",
    "supersededAt",
  ]) {
    requireField(artifact, required, field);
  }
  assertText(artifact.id, `${field}.id`);
  assertEnum(artifact.kind, ARTIFACT_KINDS, `${field} kind`);
  assertText(artifact.uri, `${field}.uri`);
  assertText(artifact.title, `${field}.title`);
  assertEnum(artifact.role, ARTIFACT_ROLES, `${field}.role`);
  uniqueTexts(artifact.sourceArtifactIds, `${field}.sourceArtifactIds`);
  assertTimestamp(artifact.producedAt, `${field}.producedAt`);
  if (artifact.producedBySession !== undefined)
    assertText(artifact.producedBySession, `${field}.producedBySession`);
  if (artifact.supersededAt !== null)
    assertTimestamp(artifact.supersededAt, `${field}.supersededAt`);
}

function validateCheck(
  value: unknown,
  field: string,
): asserts value is LifecycleCheck {
  const item = assertRecord(value, field);
  assertExactKeys(
    item,
    [
      "id",
      "kind",
      "targetArtifactIds",
      "predicate",
      "onSatisfied",
      "wakeOn",
      "state",
      "createdAt",
      "lastCheckedAt",
      "nextCheckAt",
      "lastObservation",
      "errorCount",
    ],
    field,
  );
  assertText(item.id, `${field}.id`);
  assertEnum(item.kind, CHECK_KINDS, `${field} kind`);
  uniqueTexts(item.targetArtifactIds, `${field}.targetArtifactIds`);
  assertRecord(item.predicate, `${field}.predicate`);
  assertEnum(
    item.onSatisfied,
    ["close", "actionable"] as const,
    `${field}.onSatisfied`,
  );
  uniqueTexts(item.wakeOn, `${field}.wakeOn`);
  assertEnum(item.state, CHECK_STATES, `${field} state`);
  assertTimestamp(item.createdAt, `${field}.createdAt`);
  assertNullableTimestamp(item.lastCheckedAt, `${field}.lastCheckedAt`);
  assertNullableTimestamp(item.nextCheckAt, `${field}.nextCheckAt`);
  if (item.lastObservation !== null)
    assertText(item.lastObservation, `${field}.lastObservation`);
  if (!Number.isInteger(item.errorCount) || (item.errorCount as number) < 0)
    throw new Error(`${field}.errorCount must be a non-negative integer`);
}

function validateTransition(value: unknown, field: string): void {
  const item = assertRecord(value, field);
  assertAllowedKeys(
    item,
    ["operationId", "type", "at", "from", "to", "sessionId", "reason"],
    field,
  );
  for (const required of ["operationId", "type", "at", "from", "to"])
    requireField(item, required, field);
  assertText(item.operationId, `${field}.operationId`);
  assertText(item.type, `${field}.type`);
  assertTimestamp(item.at, `${field}.at`);
  assertEnum(item.from, PHASES, `${field}.from`);
  assertEnum(item.to, PHASES, `${field}.to`);
  if (item.sessionId !== undefined)
    assertText(item.sessionId, `${field}.sessionId`);
  if (item.reason !== undefined) assertText(item.reason, `${field}.reason`);
}

function validateResource(
  value: unknown,
  field: string,
): asserts value is WorktreeResource {
  const item = assertRecord(value, field);
  assertAllowedKeys(
    item,
    [
      "id",
      "kind",
      "repository",
      "claimId",
      "pathId",
      "operationId",
      "path",
      "branch",
      "branchArtifactId",
      "acquiredAt",
      "releasedAt",
      "cleanupState",
      "lastObservation",
    ],
    field,
  );
  for (const required of [
    "id",
    "kind",
    "repository",
    "claimId",
    "pathId",
    "operationId",
    "path",
    "branch",
    "branchArtifactId",
    "acquiredAt",
    "releasedAt",
    "cleanupState",
  ])
    requireField(item, required, field);
  assertText(item.id, `${field}.id`);
  if (item.kind !== "worktree")
    throw new Error(`${field}.kind must be worktree`);
  for (const key of [
    "repository",
    "claimId",
    "pathId",
    "operationId",
    "branch",
  ] as const)
    assertText(item[key], `${field}.${key}`);
  if (item.path !== null) assertText(item.path, `${field}.path`);
  if (item.branchArtifactId !== null)
    assertText(item.branchArtifactId, `${field}.branchArtifactId`);
  assertNullableTimestamp(item.acquiredAt, `${field}.acquiredAt`);
  assertNullableTimestamp(item.releasedAt, `${field}.releasedAt`);
  assertEnum(item.cleanupState, CLEANUP_STATES, `${field} state`);
  if (item.lastObservation !== undefined)
    assertRecord(item.lastObservation, `${field}.lastObservation`);
}

function validateDisposition(
  value: unknown,
  field: string,
): asserts value is Disposition {
  const item = assertRecord(value, field);
  assertAllowedKeys(
    item,
    ["kind", "reason", "at", "evidenceArtifactIds", "supersedingTaskId"],
    field,
  );
  for (const required of ["kind", "reason", "at", "evidenceArtifactIds"])
    requireField(item, required, field);
  assertEnum(item.kind, DISPOSITIONS, `${field} kind`);
  assertText(item.reason, `${field}.reason`);
  assertTimestamp(item.at, `${field}.at`);
  uniqueTexts(item.evidenceArtifactIds, `${field}.evidenceArtifactIds`);
  if (item.supersedingTaskId !== undefined)
    assertText(item.supersedingTaskId, `${field}.supersedingTaskId`);
}

function validateUniqueArtifacts(artifacts: Artifact[]): void {
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const artifact of artifacts) {
    requireInvariant(
      !ids.has(artifact.id),
      `duplicate artifact id ${artifact.id}`,
    );
    ids.add(artifact.id);
    const identity = `${artifact.kind}\0${artifact.uri}`;
    requireInvariant(
      !identities.has(identity),
      `duplicate artifact ${artifact.kind} ${artifact.uri}`,
    );
    identities.add(identity);
  }
}

function validateUniqueResources(resources: WorktreeResource[]): void {
  const ids = new Set<string>();
  const claims = new Set<string>();
  const activePairs = new Set<string>();
  for (const resource of resources) {
    requireInvariant(
      !ids.has(resource.id),
      `duplicate resource id ${resource.id}`,
    );
    ids.add(resource.id);
    requireInvariant(
      !claims.has(resource.claimId),
      `duplicate worktree claim ${resource.claimId}`,
    );
    claims.add(resource.claimId);
    if (resource.cleanupState === "released") continue;
    const pair = `${resource.repository}\0${fullBranchRef(resource.branch)}`;
    requireInvariant(
      !activePairs.has(pair),
      `duplicate unreleased worktree resource ${resource.repository} ${fullBranchRef(resource.branch)}`,
    );
    activePairs.add(pair);
  }
}

function validateCheckTargets(lifecycle: LifecycleMetadataV1): void {
  const artifactIds = new Set(
    lifecycle.artifacts.map((artifact) => artifact.id),
  );
  for (const item of [
    ...(lifecycle.activeCheck === null ? [] : [lifecycle.activeCheck]),
    ...lifecycle.checkHistory,
  ]) {
    for (const id of item.targetArtifactIds) {
      requireInvariant(
        artifactIds.has(id),
        `check ${item.id} targets unknown artifact ${id}`,
      );
    }
  }
  const evidenceIds = lifecycle.disposition?.evidenceArtifactIds ?? [];
  for (const id of evidenceIds)
    requireInvariant(
      artifactIds.has(id),
      `disposition references unknown artifact ${id}`,
    );
}

function unresolvedBlockers(issue: LifecycleIssue) {
  return issue.dependencies.filter(
    (dependency) =>
      dependency.dependencyType === "blocks" && dependency.status !== "closed",
  );
}

function canonicalArtifactUri(kind: ArtifactKind, value: string): string {
  assertText(value, "artifact URI");
  const uri = value.trim();
  if (kind === "branch") {
    if (!/^git:\/\/.+\/refs\/heads\/.+$/.test(uri)) {
      throw new Error(
        "branch URI must include repository identity and refs/heads full ref",
      );
    }
    return uri;
  }
  if (kind === "pull_request") {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`pull request URI is invalid: ${JSON.stringify(uri)}`);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(parsed.pathname)
    ) {
      throw new Error(`pull request URI is invalid: ${JSON.stringify(uri)}`);
    }
    parsed.protocol = "https:";
    parsed.hostname = "github.com";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString().replace(/\/$/, "");
  }
  return uri.replace(/\/$/, "");
}

function fullBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

function uniqueTexts(value: unknown, field: string): string[] {
  const values = assertArray(value, field);
  const result: string[] = [];
  for (const item of values) {
    assertText(item, field);
    if (!result.includes(item.trim())) result.push(item.trim());
  }
  return result;
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function assertArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} must be non-empty text`);
}

function assertTimestamp(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(`${field} must be an ISO timestamp`);
}

function assertNullableTimestamp(value: unknown, field: string): void {
  if (value !== null) assertTimestamp(value, field);
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new Error(`${field} has unknown value ${JSON.stringify(value)}`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  assertAllowedKeys(value, keys, field);
  for (const key of keys) requireField(value, key, field);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined)
    throw new Error(`${field} has unknown field ${unknown}`);
}

function requireField(
  value: Record<string, unknown>,
  key: string,
  field: string,
): void {
  if (!(key in value)) throw new Error(`${field} is missing ${key}`);
}

function requireInvariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function beginWorktreeAcquire(
  state: LifecycleMetadataV1,
  input: import("./types.js").BeginWorktreeAcquireInput,
): LifecycleMetadataV1 {
  assertText(input.operationId, "worktree acquire operationId");
  assertText(input.claimId, "worktree acquire claimId");
  assertText(input.pathId, "worktree acquire pathId");
  assertText(input.repository, "worktree acquire repository");
  assertText(input.branch, "worktree acquire branch");
  assertTimestamp(input.now, "worktree acquire timestamp");
  const existing = state.resources.find(
    (resource) => resource.operationId === input.operationId,
  );
  if (existing !== undefined) {
    requireInvariant(
      existing.claimId === input.claimId && existing.pathId === input.pathId,
      `worktree operation ${input.operationId} has contradictory identities`,
    );
    return state;
  }
  requireInvariant(
    state.phase === "active",
    "worktree acquire requires phase active",
  );
  const fullBranch = fullBranchRef(input.branch);
  requireInvariant(
    !state.resources.some(
      (resource) =>
        resource.cleanupState !== "released" &&
        resource.repository === input.repository &&
        fullBranchRef(resource.branch) === fullBranch,
    ),
    `duplicate unreleased worktree resource ${input.repository} ${fullBranch}`,
  );
  const resource: WorktreeResource = {
    id: `worktree:${input.claimId}`,
    kind: "worktree",
    repository: input.repository,
    claimId: input.claimId,
    pathId: input.pathId,
    operationId: input.operationId,
    path: null,
    branch: input.branch,
    branchArtifactId: null,
    acquiredAt: null,
    releasedAt: null,
    cleanupState: "acquiring",
  };
  return recordResourceOperation(
    { ...state, resources: [...state.resources, resource] },
    `${input.operationId}:acquiring`,
    "worktree_acquire_pending",
    input.now,
  );
}

export function completeWorktreeAcquire(
  state: LifecycleMetadataV1,
  input: import("./types.js").CompleteWorktreeAcquireInput,
): LifecycleMetadataV1 {
  assertText(input.operationId, "worktree acquire operationId");
  assertText(input.claimId, "worktree acquire claimId");
  assertText(input.path, "worktree acquire path");
  assertText(input.head, "worktree acquire head");
  assertTimestamp(input.now, "worktree acquire timestamp");
  const index = state.resources.findIndex(
    (resource) => resource.claimId === input.claimId,
  );
  requireInvariant(index >= 0, `unknown worktree claim ${input.claimId}`);
  const current = state.resources[index];
  requireInvariant(
    current.operationId === input.operationId,
    `worktree claim ${input.claimId} belongs to operation ${current.operationId}`,
  );
  if (current.cleanupState === "active") return state;
  requireInvariant(
    current.cleanupState === "acquiring",
    `worktree claim ${input.claimId} is not acquiring`,
  );
  const artifact = canonicalizeArtifact(
    {
      id: `branch:${input.claimId}`,
      kind: "branch",
      uri: `git://${current.repository}/${fullBranchRef(current.branch)}`,
      title: `${current.repository} ${current.branch}`,
      role: "supporting",
    },
    input.now,
  );
  const withArtifact = attachArtifact(state, artifact);
  const resources = [...withArtifact.resources];
  resources[index] = {
    ...current,
    path: input.path,
    branchArtifactId: artifact.id,
    acquiredAt: input.now,
    cleanupState: "active",
    lastObservation: input.observation,
  };
  return recordResourceOperation(
    { ...withArtifact, resources },
    `${input.operationId}:active`,
    "worktree_acquired",
    input.now,
  );
}

export function beginWorktreeRelease(
  state: LifecycleMetadataV1,
  input: import("./types.js").WorktreeReleaseInput,
): LifecycleMetadataV1 {
  assertText(input.operationId, "worktree release operationId");
  assertText(input.claimId, "worktree release claimId");
  assertTimestamp(input.now, "worktree release timestamp");
  const index = state.resources.findIndex(
    (resource) => resource.claimId === input.claimId,
  );
  requireInvariant(index >= 0, `unknown worktree claim ${input.claimId}`);
  const current = state.resources[index];
  if (current.cleanupState === "released") return state;
  if (
    current.cleanupState === "release_pending" &&
    current.operationId === input.operationId
  ) {
    return state;
  }
  requireInvariant(
    current.cleanupState === "active" ||
      current.cleanupState === "needs_attention",
    `worktree claim ${input.claimId} cannot enter release_pending from ${current.cleanupState}`,
  );
  const resources = [...state.resources];
  resources[index] = {
    ...current,
    operationId: input.operationId,
    cleanupState: "release_pending",
  };
  return recordResourceOperation(
    { ...state, resources },
    `${input.operationId}:release-pending`,
    "worktree_release_pending",
    input.now,
  );
}

export function completeWorktreeRelease(
  state: LifecycleMetadataV1,
  input: import("./types.js").WorktreeReleaseInput,
): LifecycleMetadataV1 {
  assertText(input.operationId, "worktree release operationId");
  assertText(input.claimId, "worktree release claimId");
  assertTimestamp(input.now, "worktree release timestamp");
  const index = state.resources.findIndex(
    (resource) => resource.claimId === input.claimId,
  );
  requireInvariant(index >= 0, `unknown worktree claim ${input.claimId}`);
  const current = state.resources[index];
  if (current.cleanupState === "released") return state;
  requireInvariant(
    current.cleanupState === "release_pending" &&
      current.operationId === input.operationId,
    `worktree claim ${input.claimId} does not have this release pending`,
  );
  const resources = [...state.resources];
  resources[index] = {
    ...current,
    cleanupState: "released",
    releasedAt: input.now,
  };
  return recordResourceOperation(
    { ...state, resources },
    `${input.operationId}:released`,
    "worktree_released",
    input.now,
  );
}

function recordResourceOperation(
  state: LifecycleMetadataV1,
  operationId: string,
  type: string,
  at: string,
): LifecycleMetadataV1 {
  if (hasOperation(state, operationId)) return state;
  return {
    ...state,
    lastProgressAt: at,
    transitionHistory: [
      ...state.transitionHistory,
      {
        operationId,
        type,
        at,
        from: state.phase,
        to: state.phase,
      },
    ],
  };
}
