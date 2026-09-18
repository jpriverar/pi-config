import {
  adoptLegacyLifecycle,
  attachArtifact as attachArtifactToLifecycle,
  canonicalizeArtifact,
  claimLifecycle,
  closeLifecycle,
  interruptLifecycle,
  reopenLifecycle,
  validateLifecycle,
  waitLifecycle,
} from "./model.js";
import type {
  ArtifactInput,
  Disposition,
  LifecycleCheck,
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecyclePhase,
  LifecycleStatus,
  LifecycleStore,
  LockOwner,
  Mutation,
  WorktreeResource,
} from "./types.js";

export interface TaskLifecyclePoolPort {
  release(
    repository: string,
    claimId: string,
    owner: LockOwner,
  ): Promise<{ released: boolean }>;
}

export interface TaskLifecycleServiceDependencies {
  store: LifecycleStore;
  now: () => number;
  uuid: () => string;
  executionTimeoutMs: number;
  pool?: TaskLifecyclePoolPort;
}

export type CloseDispositionInput = Omit<Disposition, "at">;

export class TaskLifecycleService {
  constructor(private readonly deps: TaskLifecycleServiceDependencies) {}

  async claim(
    taskId: string,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const readyIds = await this.deps.store.readyIds();
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const lifecycle = this.managedOrAdopted(issue, readyIds, now);
      if (
        lifecycle.phase === "active" &&
        !hasOperation(lifecycle, operationId)
      ) {
        throw new Error(
          `task ${taskId} is owned by active session ${lifecycle.execution?.sessionId ?? "unknown"}`,
        );
      }
      const next = claimLifecycle(lifecycle, {
        operationId,
        sessionId: owner.sessionId,
        now,
        expiresAt: new Date(
          this.deps.now() + this.deps.executionTimeoutMs,
        ).toISOString(),
        resourceSnapshot: {
          observedAt: now,
          resourceIds: lifecycle.resources
            .filter((resource) => resource.cleanupState !== "released")
            .map((resource) => resource.id),
        },
      });
      return this.mutation(issue, operationId, "in_progress", next);
    });
  }

  async attachArtifact(
    taskId: string,
    input: ArtifactInput,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const lifecycle = requireManaged(issue);
      requireCurrentOwner(taskId, lifecycle, owner);
      if (hasOperation(lifecycle, operationId)) {
        return this.mutation(issue, operationId, issue.status, lifecycle);
      }
      const artifact = canonicalizeArtifact(input, now, owner.sessionId);
      const attached = attachArtifactToLifecycle(lifecycle, artifact);
      const next = recordOperation(
        attached,
        operationId,
        "attach_artifact",
        now,
        owner.sessionId,
      );
      return this.mutation(issue, operationId, issue.status, next);
    });
  }

  async waitForDependencies(
    taskId: string,
    blockerIds: readonly string[],
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const blockers = [...new Set(blockerIds)];
    if (blockers.length === 0) {
      throw new Error("dependency wait requires at least one blocker task ID");
    }
    const current = await this.deps.store.show(taskId);
    const lifecycle = requireManaged(current);
    if (hasOperation(lifecycle, operationId)) return current;
    requireCurrentOwner(taskId, lifecycle, owner);
    const released = await this.releaseResources(lifecycle, owner);
    for (const blockerId of blockers) {
      await this.deps.store.addBlocker(taskId, blockerId);
    }
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = applyReleasedResources(
        requireManaged(issue),
        released,
        now,
      );
      requireCurrentOwner(taskId, latest, owner);
      const next = waitLifecycle(latest, {
        operationId,
        now,
        kind: "dependency",
      });
      return this.mutation(issue, operationId, "open", next);
    });
  }

  async waitForCheck(
    taskId: string,
    check: LifecycleCheck,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const current = await this.deps.store.show(taskId);
    const lifecycle = requireManaged(current);
    if (hasOperation(lifecycle, operationId)) return current;
    requireCurrentOwner(taskId, lifecycle, owner);
    const released = await this.releaseResources(lifecycle, owner);
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = applyReleasedResources(
        requireManaged(issue),
        released,
        now,
      );
      requireCurrentOwner(taskId, latest, owner);
      const next = waitLifecycle(latest, {
        operationId,
        now,
        kind: "check",
        check,
      });
      return this.mutation(issue, operationId, "blocked", next);
    });
  }

  async close(
    taskId: string,
    disposition: CloseDispositionInput,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const current = await this.deps.store.show(taskId);
    const lifecycle = requireManaged(current);
    if (lifecycle.phase === "active") {
      requireCurrentOwner(taskId, lifecycle, owner);
    }
    const released = await this.releaseResources(lifecycle, owner);
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = applyReleasedResources(
        requireManaged(issue),
        released,
        now,
      );
      if (latest.phase === "active") {
        requireCurrentOwner(taskId, latest, owner);
      }
      const relinquished =
        latest.phase === "active" ? { ...latest, execution: null } : latest;
      const next = closeLifecycle(relinquished, {
        operationId,
        now,
        disposition: { ...disposition, at: now },
      });
      return this.mutation(issue, operationId, "closed", next);
    });
  }

  async reopen(
    taskId: string,
    reason: string,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const lifecycle = requireManaged(issue);
      const hasUnresolvedBlockers = issue.dependencies.some(
        (dependency) =>
          dependency.dependencyType === "blocks" &&
          dependency.status !== "closed",
      );
      const next = reopenLifecycle(lifecycle, {
        operationId,
        now,
        reason,
        hasUnresolvedBlockers,
      });
      return this.mutation(issue, operationId, "open", next);
    });
  }

  async reconcileExecutionTimeout(
    taskId: string,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    const current = await this.deps.store.show(taskId);
    const execution = current.lifecycle?.execution;
    if (
      current.lifecycle?.phase !== "active" ||
      execution === null ||
      execution === undefined ||
      Date.parse(execution.expiresAt) > this.deps.now()
    ) {
      return current;
    }
    const now = this.nowIso();
    const operationId = `execution-interrupted:${execution.sessionId}:${execution.expiresAt}`;
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const lifecycle = requireManaged(issue);
      if (
        lifecycle.phase !== "active" ||
        lifecycle.execution === null ||
        Date.parse(lifecycle.execution.expiresAt) > this.deps.now()
      ) {
        return unchangedMutation(issue, operationId);
      }
      const next = interruptLifecycle(lifecycle, {
        operationId,
        now,
        expectedSessionId: execution.sessionId,
      });
      return this.mutation(issue, operationId, "open", next);
    });
  }

  private managedOrAdopted(
    issue: LifecycleIssue,
    readyIds: ReadonlySet<string>,
    now: string,
  ): LifecycleMetadataV1 {
    return (
      issue.lifecycle ?? adoptLegacyLifecycle(issue, readyIds, now).lifecycle
    );
  }

  private mutation(
    issue: LifecycleIssue,
    operationId: string,
    status: LifecycleStatus,
    lifecycle: LifecycleMetadataV1,
  ): Mutation {
    validateLifecycle(lifecycle, { ...issue, status, lifecycle });
    return { operationId, status, lifecycle };
  }

  private async releaseResources(
    lifecycle: LifecycleMetadataV1,
    owner: LockOwner,
  ): Promise<ReadonlySet<string>> {
    const resources = lifecycle.resources.filter(
      (resource) => resource.cleanupState !== "released",
    );
    if (resources.length === 0) return new Set();
    if (this.deps.pool === undefined) {
      throw new Error("active worktree resources require a configured pool");
    }
    const released = new Set<string>();
    for (const resource of resources) {
      await this.deps.pool.release(
        resource.repository,
        resource.claimId,
        owner,
      );
      released.add(resource.id);
    }
    return released;
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString();
  }
}

function requireManaged(issue: LifecycleIssue): LifecycleMetadataV1 {
  if (issue.lifecycle === null) {
    throw new Error(`task ${issue.id} has no valid piLifecycle metadata`);
  }
  return issue.lifecycle;
}

function requireCurrentOwner(
  taskId: string,
  lifecycle: LifecycleMetadataV1,
  owner: LockOwner,
): void {
  if (lifecycle.phase !== "active" || lifecycle.execution === null) {
    throw new Error(`task ${taskId} is not actively owned`);
  }
  if (lifecycle.execution.sessionId !== owner.sessionId) {
    throw new Error(
      `task ${taskId} is owned by active session ${lifecycle.execution.sessionId}`,
    );
  }
}

function applyReleasedResources(
  lifecycle: LifecycleMetadataV1,
  releasedIds: ReadonlySet<string>,
  now: string,
): LifecycleMetadataV1 {
  if (releasedIds.size === 0) return lifecycle;
  return {
    ...lifecycle,
    resources: lifecycle.resources.map((resource) =>
      releasedIds.has(resource.id)
        ? {
            ...resource,
            cleanupState: "released" as const,
            releasedAt: now,
          }
        : resource,
    ),
  };
}

function recordOperation(
  lifecycle: LifecycleMetadataV1,
  operationId: string,
  type: string,
  at: string,
  sessionId?: string,
): LifecycleMetadataV1 {
  if (hasOperation(lifecycle, operationId)) return lifecycle;
  const phase: LifecyclePhase = lifecycle.phase;
  return {
    ...lifecycle,
    lastProgressAt: at,
    transitionHistory: [
      ...lifecycle.transitionHistory,
      {
        operationId,
        type,
        at,
        from: phase,
        to: phase,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    ],
  };
}

function hasOperation(
  lifecycle: LifecycleMetadataV1,
  operationId: string,
): boolean {
  return lifecycle.transitionHistory.some(
    (transition) => transition.operationId === operationId,
  );
}

function unchangedMutation(
  issue: LifecycleIssue,
  operationId: string,
): Mutation {
  const lifecycle = requireManaged(issue);
  if (!hasOperation(lifecycle, operationId)) {
    throw new Error(
      `task ${issue.id} changed before timeout reconciliation could be recorded`,
    );
  }
  return { operationId, status: issue.status, lifecycle };
}

export type { WorktreeResource };
