export type LifecyclePhase =
  | "actionable"
  | "active"
  | "waiting"
  | "deferred"
  | "done";
export type WaitingKind = "dependency" | "check";
export type ArtifactKind =
  | "branch"
  | "commit"
  | "pull_request"
  | "document"
  | "dashboard"
  | "deployment"
  | "report"
  | "other";
export type ArtifactRole = "deliverable" | "evidence" | "supporting";
export type CheckKind = "github_pull_request" | "time" | "manual";
export type CheckState = "pending" | "satisfied" | "action_required" | "error";
export type DispositionKind = "completed" | "cancelled" | "superseded";
export type LifecycleStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "deferred"
  | "closed";

export interface ExecutionLease {
  sessionId: string;
  claimedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  resourceSnapshot: { observedAt: string; resourceIds: string[] };
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  uri: string;
  title: string;
  role: ArtifactRole;
  sourceArtifactIds: string[];
  producedAt: string;
  producedBySession?: string;
  supersededAt: string | null;
}

export interface ArtifactInput {
  id: string;
  kind: ArtifactKind;
  uri: string;
  title: string;
  role: ArtifactRole;
  sourceArtifactIds?: string[];
  producedAt?: string;
  supersededAt?: string | null;
}

export interface LifecycleCheck {
  id: string;
  kind: CheckKind;
  targetArtifactIds: string[];
  predicate: Record<string, unknown>;
  onSatisfied: "close" | "actionable";
  wakeOn: string[];
  state: CheckState;
  createdAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastObservation: string | null;
  errorCount: number;
}

export interface LifecycleTransition {
  operationId: string;
  type: string;
  at: string;
  from: LifecyclePhase;
  to: LifecyclePhase;
  sessionId?: string;
  reason?: string;
}

export type WorktreeCleanupState =
  | "acquiring"
  | "active"
  | "release_pending"
  | "released"
  | "needs_attention";

export interface WorktreeResource {
  id: string;
  kind: "worktree";
  repository: string;
  claimId: string;
  pathId: string;
  operationId: string;
  path: string | null;
  branch: string;
  branchArtifactId: string | null;
  acquiredAt: string | null;
  releasedAt: string | null;
  cleanupState: WorktreeCleanupState;
  lastObservation?: Record<string, unknown>;
}

export type PreparedWorktreeOperation =
  | {
      version: 1;
      mode: "acquire";
      taskId: string;
      operationId: string;
      claimId: string;
      pathId: string;
      repository: string;
    }
  | {
      version: 1;
      mode: "release";
      taskId: string;
      operationId: string;
      claimId: string;
      repository: string;
    };

export interface Disposition {
  kind: DispositionKind;
  reason: string;
  at: string;
  evidenceArtifactIds: string[];
  supersedingTaskId?: string;
}

export interface NativeDependency {
  id: string;
  status: LifecycleStatus;
  dependencyType: string;
}

export interface LockOwner {
  pid: number;
  sessionId: string;
  host: string;
  started: number;
}

export interface Mutation {
  operationId: string;
  status: LifecycleStatus;
  lifecycle: LifecycleMetadataV1;
}

export interface CreateTaskInput {
  title: string;
  why: string;
  workstream?: string;
  needsJp: boolean;
}

export interface UpdateTaskLabelsInput {
  addLabels: string[];
  removeLabels: string[];
}

export interface LifecycleMetadataV1 {
  version: 1;
  phase: LifecyclePhase;
  waiting: { kind: WaitingKind } | null;
  stateEnteredAt: string;
  lastProgressAt: string;
  execution: ExecutionLease | null;
  artifacts: Artifact[];
  activeCheck: LifecycleCheck | null;
  checkHistory: LifecycleCheck[];
  transitionHistory: LifecycleTransition[];
  resources: WorktreeResource[];
  disposition: Disposition | null;
}

export interface LifecycleIssue {
  id: string;
  title: string;
  status: LifecycleStatus;
  metadata: Record<string, unknown>;
  lifecycle: LifecycleMetadataV1 | null;
  dependencies: NativeDependency[];
}

export interface LifecycleStore {
  show(id: string): Promise<LifecycleIssue>;
  list(statuses: readonly LifecycleStatus[]): Promise<LifecycleIssue[]>;
  readyIds(): Promise<ReadonlySet<string>>;
  create(
    input: CreateTaskInput,
    lifecycle: LifecycleMetadataV1,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  updateLabels(
    id: string,
    input: UpdateTaskLabelsInput,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  appendComment(
    id: string,
    message: string,
    owner: LockOwner,
    validate: (issue: LifecycleIssue) => void,
  ): Promise<LifecycleIssue>;
  mutate(
    id: string,
    owner: LockOwner,
    operation: (issue: LifecycleIssue) => Mutation,
  ): Promise<LifecycleIssue>;
  addBlocker(dependentId: string, blockerId: string): Promise<void>;
}

export type DecodeLifecycleResult =
  | { ok: true; value: LifecycleMetadataV1 }
  | { ok: false; warning: string };

export interface LegacyLifecycleAdoption {
  lifecycle: LifecycleMetadataV1;
  warnings: string[];
}

export interface ClaimInput {
  operationId: string;
  sessionId: string;
  now: string;
  expiresAt: string;
  resourceSnapshot: ExecutionLease["resourceSnapshot"];
}

export interface WaitInput {
  operationId: string;
  now: string;
  kind: WaitingKind;
  check?: LifecycleCheck;
  reason?: string;
}

export interface CloseInput {
  operationId: string;
  now: string;
  disposition: Disposition;
}

export interface ReopenInput {
  operationId: string;
  now: string;
  reason: string;
  hasUnresolvedBlockers: boolean;
}

export interface InterruptInput {
  operationId: string;
  now: string;
  expectedSessionId: string;
}

export interface BeginWorktreeAcquireInput {
  operationId: string;
  claimId: string;
  pathId: string;
  repository: string;
  branch: string;
  now: string;
}

export interface CompleteWorktreeAcquireInput {
  operationId: string;
  claimId: string;
  path: string;
  head: string;
  now: string;
  observation: Record<string, unknown>;
}

export interface WorktreeReleaseInput {
  operationId: string;
  claimId: string;
  now: string;
}
