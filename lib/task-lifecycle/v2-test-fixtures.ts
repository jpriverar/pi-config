import type {
  LifecycleCheck,
  LifecycleIssueV2,
  LifecycleMetadataV2,
  LifecycleStatus,
  NativeDependency,
  TaskOwner,
  WorktreeResource,
} from "./types.js";

export const NOW = "2026-10-28T10:00:00.000Z";
export const LATER = "2026-10-28T11:00:00.000Z";
export const OWNER: TaskOwner = {
  sessionId: "session-a",
  claimedAt: NOW,
  lastActivityAt: NOW,
};

export function state(
  overrides: Partial<LifecycleMetadataV2> = {},
): LifecycleMetadataV2 {
  return {
    version: 2,
    phase: "actionable",
    owner: null,
    condition: null,
    pause: null,
    stateEnteredAt: NOW,
    lastProgressAt: NOW,
    artifacts: [],
    activeCheck: null,
    checkHistory: [],
    transitionHistory: [],
    resources: [],
    disposition: null,
    ...overrides,
  };
}

export function check(overrides: Partial<LifecycleCheck> = {}): LifecycleCheck {
  return {
    id: "check-1",
    kind: "manual",
    targetArtifactIds: [],
    predicate: {},
    onSatisfied: "actionable",
    wakeOn: [],
    state: "pending",
    createdAt: NOW,
    lastCheckedAt: null,
    nextCheckAt: null,
    lastObservation: null,
    errorCount: 0,
    ...overrides,
  };
}

export function withCheck(
  overrides: Partial<LifecycleMetadataV2> = {},
): LifecycleMetadataV2 {
  return state({
    phase: "active",
    owner: OWNER,
    condition: { id: "condition-1", kind: "check", purpose: "completion" },
    activeCheck: check(),
    ...overrides,
  });
}

export function issue(
  lifecycle: LifecycleMetadataV2,
  status: LifecycleStatus = "open",
  dependencies: NativeDependency[] = [],
): LifecycleIssueV2 {
  return {
    id: "jp-test",
    title: "Ownership test",
    status,
    metadata: { piLifecycle: lifecycle },
    lifecycle,
    dependencies,
  };
}

export function resource(
  overrides: Partial<WorktreeResource> = {},
): WorktreeResource {
  return {
    id: "resource-1",
    kind: "worktree",
    repository: "repo",
    claimId: "claim-1",
    pathId: "path-1",
    operationId: "acquire-1",
    path: "/tmp/test-worktree",
    branch: "jpriverar/test",
    branchArtifactId: null,
    acquiredAt: NOW,
    releasedAt: null,
    cleanupState: "active",
    ...overrides,
  };
}
