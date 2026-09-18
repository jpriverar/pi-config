import type { OwnerIdentity } from "../../extensions/worktree-pool/operation-lock.js";
import type {
  AcquireRequest,
  AcquireResult,
  PoolListing,
  PoolWorktreeListing,
  ReleaseResult,
} from "../../extensions/worktree-pool/pool.js";
import {
  adoptLegacyLifecycle,
  attachArtifact as attachArtifactToLifecycle,
  beginWorktreeAcquire,
  beginWorktreeRelease,
  canonicalizeArtifact,
  claimLifecycle,
  closeLifecycle,
  completeWorktreeAcquire,
  completeWorktreeRelease,
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
  list(repository?: string): Promise<PoolListing>;
  acquire(
    request: AcquireRequest,
    owner: OwnerIdentity,
    identity: { claimId: string; pathId: string },
  ): Promise<AcquireResult>;
  release(
    repository: string,
    claimId: string,
    owner: OwnerIdentity,
  ): Promise<ReleaseResult>;
}

export interface TaskWorktreeAcquireRequest extends AcquireRequest {
  taskId: string;
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
    await this.releaseResources(taskId, lifecycle, owner, operationId);
    for (const blockerId of blockers) {
      await this.deps.store.addBlocker(taskId, blockerId);
    }
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
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
    await this.releaseResources(taskId, lifecycle, owner, operationId);
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
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
    await this.releaseResources(taskId, lifecycle, owner, operationId);
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
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

  async acquireWorktree(
    request: TaskWorktreeAcquireRequest,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const pool = this.requirePool();
    const current = await this.deps.store.show(request.taskId);
    const lifecycle = requireManaged(current);
    requireCurrentOwner(request.taskId, lifecycle, owner);

    const pending = lifecycle.resources.find(
      (resource) =>
        resource.operationId === operationId &&
        resource.cleanupState === "acquiring",
    );
    await this.assertHealthyAssociations(lifecycle, pool, pending?.claimId);

    if (pending !== undefined) {
      const matches = await exactClaimMatches(
        pool,
        pending.repository,
        pending.claimId,
      );
      if (matches.length > 1) {
        throw new Error(
          `ambiguous worktree association for claim ${pending.claimId}`,
        );
      }
      if (matches.length === 1) {
        assertValidAssociation(pending, matches[0]);
        return this.finalizeWorktreeAcquire(
          request.taskId,
          owner,
          operationId,
          pending.claimId,
          matches[0].path,
          matches[0].head!,
          matches[0],
        );
      }
      const acquired = await pool.acquire(
        {
          repository: pending.repository,
          branch: pending.branch,
          ...(request.startPoint === undefined
            ? {}
            : { startPoint: request.startPoint }),
        },
        owner,
        { claimId: pending.claimId, pathId: pending.pathId },
      );
      return this.finalizeAcquireResult(
        request.taskId,
        owner,
        operationId,
        pending.claimId,
        acquired,
      );
    }

    const identityListing = await pool.list(request.repository);
    if (identityListing.repositories.length !== 1) {
      throw new Error(
        `repository ${request.repository} resolved to ${identityListing.repositories.length} pool identities`,
      );
    }
    const repository = identityListing.repositories[0].name;
    const claimId = this.deps.uuid();
    const pathId = this.deps.uuid();
    const now = this.nowIso();
    await this.deps.store.mutate(request.taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      requireCurrentOwner(request.taskId, latest, owner);
      const next = beginWorktreeAcquire(latest, {
        operationId,
        claimId,
        pathId,
        repository,
        branch: request.branch,
        now,
      });
      return this.mutation(
        issue,
        `${operationId}:acquiring`,
        issue.status,
        next,
      );
    });

    const acquired = await pool.acquire(
      {
        repository,
        branch: request.branch,
        ...(request.startPoint === undefined
          ? {}
          : { startPoint: request.startPoint }),
      },
      owner,
      { claimId, pathId },
    );
    if (acquired.claimId !== claimId) {
      throw new Error(
        `pool returned claim ${acquired.claimId} instead of persisted claim ${claimId}`,
      );
    }
    return this.finalizeAcquireResult(
      request.taskId,
      owner,
      operationId,
      claimId,
      acquired,
    );
  }

  async releaseWorktree(
    taskId: string,
    claimId: string,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const pool = this.requirePool();
    const current = await this.deps.store.show(taskId);
    const lifecycle = requireManaged(current);
    requireCurrentOwner(taskId, lifecycle, owner);
    const resource = lifecycle.resources.find(
      (candidate) => candidate.claimId === claimId,
    );
    if (resource === undefined)
      throw new Error(`unknown worktree claim ${claimId}`);
    if (resource.cleanupState === "released") return current;
    const wasPending =
      resource.cleanupState === "release_pending" &&
      resource.operationId === operationId;
    const now = this.nowIso();
    if (!wasPending) {
      await this.deps.store.mutate(taskId, owner, (issue) => {
        const latest = requireManaged(issue);
        requireCurrentOwner(taskId, latest, owner);
        const next = beginWorktreeRelease(latest, {
          operationId,
          claimId,
          now,
        });
        return this.mutation(
          issue,
          `${operationId}:release-pending`,
          issue.status,
          next,
        );
      });
    }

    if (wasPending) {
      const matches = await exactClaimMatches(
        pool,
        resource.repository,
        claimId,
      );
      if (matches.length > 1) {
        throw new Error(`ambiguous worktree association for claim ${claimId}`);
      }
      if (matches.length === 0) {
        return this.finalizeWorktreeRelease(
          taskId,
          owner,
          operationId,
          claimId,
        );
      }
    }
    await pool.release(resource.repository, claimId, owner);
    return this.finalizeWorktreeRelease(taskId, owner, operationId, claimId);
  }

  async hasActiveTask(sessionId: string): Promise<boolean> {
    const issues = await this.deps.store.list(["in_progress"]);
    return issues.some(
      (issue) =>
        issue.lifecycle?.phase === "active" &&
        issue.lifecycle.execution?.sessionId === sessionId,
    );
  }

  async isClaimAssociated(claimId: string): Promise<boolean> {
    const issues = await this.deps.store.list([
      "open",
      "in_progress",
      "blocked",
      "deferred",
      "closed",
    ]);
    return issues.some((issue) =>
      issue.lifecycle?.resources.some(
        (resource) => resource.claimId === claimId,
      ),
    );
  }

  private async finalizeAcquireResult(
    taskId: string,
    owner: LockOwner,
    operationId: string,
    claimId: string,
    acquired: AcquireResult,
  ): Promise<LifecycleIssue> {
    const observation: PoolWorktreeListing = {
      claimId,
      path: acquired.path,
      state: "active",
      branch: acquired.branch,
      currentBranch: `refs/heads/${acquired.branch}`,
      head: acquired.head,
      clean: true,
      branchProtectsHead: true,
      evidence: {
        pathExists: true,
        registered: true,
        nativeClaimMatches: true,
      },
    };
    return this.finalizeWorktreeAcquire(
      taskId,
      owner,
      operationId,
      claimId,
      acquired.path,
      acquired.head,
      observation,
    );
  }

  private async finalizeWorktreeAcquire(
    taskId: string,
    owner: LockOwner,
    operationId: string,
    claimId: string,
    path: string,
    head: string,
    observation: PoolWorktreeListing,
  ): Promise<LifecycleIssue> {
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      requireCurrentOwner(taskId, latest, owner);
      const next = completeWorktreeAcquire(latest, {
        operationId,
        claimId,
        path,
        head,
        now,
        observation,
      });
      return this.mutation(issue, `${operationId}:active`, issue.status, next);
    });
  }

  private async finalizeWorktreeRelease(
    taskId: string,
    owner: LockOwner,
    operationId: string,
    claimId: string,
  ): Promise<LifecycleIssue> {
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      requireCurrentOwner(taskId, latest, owner);
      const next = completeWorktreeRelease(latest, {
        operationId,
        claimId,
        now,
      });
      return this.mutation(
        issue,
        `${operationId}:released`,
        issue.status,
        next,
      );
    });
  }

  private async assertHealthyAssociations(
    lifecycle: LifecycleMetadataV1,
    pool: TaskLifecyclePoolPort,
    ignoredClaimId?: string,
  ): Promise<void> {
    for (const resource of lifecycle.resources) {
      if (
        resource.cleanupState === "released" ||
        resource.claimId === ignoredClaimId
      ) {
        continue;
      }
      if (resource.cleanupState !== "active") {
        throw new Error(
          `pending worktree association ${resource.claimId} requires reconciliation`,
        );
      }
      const matches = await exactClaimMatches(
        pool,
        resource.repository,
        resource.claimId,
      );
      if (matches.length !== 1) {
        throw new Error(
          `${matches.length === 0 ? "missing" : "ambiguous"} worktree association for claim ${resource.claimId}`,
        );
      }
      assertValidAssociation(resource, matches[0]);
    }
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
    taskId: string,
    lifecycle: LifecycleMetadataV1,
    owner: LockOwner,
    parentOperationId: string,
  ): Promise<void> {
    for (const resource of lifecycle.resources) {
      if (resource.cleanupState === "released") continue;
      await this.releaseWorktree(
        taskId,
        resource.claimId,
        owner,
        `${parentOperationId}:release:${resource.claimId}`,
      );
    }
  }

  private requirePool(): TaskLifecyclePoolPort {
    if (this.deps.pool === undefined) {
      throw new Error("task worktree operation requires a configured pool");
    }
    return this.deps.pool;
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

async function exactClaimMatches(
  pool: TaskLifecyclePoolPort,
  repository: string,
  claimId: string,
): Promise<PoolWorktreeListing[]> {
  const listing = await pool.list(repository);
  return listing.repositories
    .flatMap((candidate) => candidate.worktrees)
    .filter((worktree) => worktree.claimId === claimId);
}

function assertValidAssociation(
  resource: WorktreeResource,
  listing: PoolWorktreeListing,
): void {
  const fullBranch = resource.branch.startsWith("refs/heads/")
    ? resource.branch
    : `refs/heads/${resource.branch}`;
  const branch = listing.branch?.startsWith("refs/heads/")
    ? listing.branch
    : listing.branch === undefined
      ? undefined
      : `refs/heads/${listing.branch}`;
  const valid =
    branch === fullBranch &&
    listing.currentBranch === fullBranch &&
    listing.head !== null &&
    listing.branchProtectsHead === true &&
    listing.evidence.pathExists === true &&
    listing.evidence.registered === true &&
    listing.evidence.nativeClaimMatches === true &&
    (resource.path === null || resource.path === listing.path);
  if (!valid) {
    throw new Error(
      `contradictory worktree association for claim ${resource.claimId}`,
    );
  }
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
