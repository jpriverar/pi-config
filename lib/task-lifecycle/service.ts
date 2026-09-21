import { basename } from "node:path";

import type { OwnerIdentity } from "../../extensions/worktree-pool/operation-lock.js";
import {
  nextCheckBackoffMs,
  type CheckAdapterRegistry,
  type ObserveCheckInput,
} from "./checks.js";
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
  createActionableLifecycle,
  deferLifecycle,
  interruptLifecycle,
  reopenLifecycle,
  validateLifecycle,
  waitLifecycle,
} from "./model.js";
import type {
  ArtifactInput,
  CreateTaskInput,
  Disposition,
  LifecycleCheck,
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecyclePhase,
  LifecycleStatus,
  LifecycleStore,
  LockOwner,
  Mutation,
  PreparedWorktreeOperation,
  UpdateTaskLabelsInput,
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
  activityWriteIntervalMs?: number;
  prPollIntervalMs?: number;
  maxBackoffMs?: number;
  pool?: TaskLifecyclePoolPort;
  checkAdapters?: CheckAdapterRegistry;
}

export interface ReconcileLimits {
  taskLimit: number;
  checkLimit: number;
}

export type CloseDispositionInput = Omit<Disposition, "at">;

export function normalizeLabelUpdate(
  input: UpdateTaskLabelsInput,
): UpdateTaskLabelsInput {
  const addLabels = normalizeLabels(input.addLabels);
  const removeLabels = normalizeLabels(input.removeLabels);
  if (addLabels.length === 0 && removeLabels.length === 0) {
    throw new Error("task update requires at least one label change");
  }
  const removed = new Set(removeLabels);
  const overlap = addLabels.find((label) => removed.has(label));
  if (overlap !== undefined) {
    throw new Error(
      `label ${JSON.stringify(overlap)} cannot be both add and remove`,
    );
  }
  return { addLabels, removeLabels };
}

export class TaskLifecycleService {
  constructor(private readonly deps: TaskLifecycleServiceDependencies) {}

  async create(
    input: CreateTaskInput,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    return this.deps.store.create(
      input,
      createActionableLifecycle(this.nowIso()),
      owner,
    );
  }

  async updateLabels(
    taskId: string,
    input: UpdateTaskLabelsInput,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    return this.deps.store.updateLabels(
      taskId,
      normalizeLabelUpdate(input),
      owner,
    );
  }

  async log(
    taskId: string,
    message: string,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    if (message.trim().length === 0) {
      throw new Error("task log message must not be empty");
    }
    return this.deps.store.appendComment(taskId, message, owner, (issue) => {
      const lifecycle = requireManaged(issue);
      requireCurrentOwner(taskId, lifecycle, owner);
      if (lifecycle.phase !== "active") {
        throw new Error(
          `task ${taskId} must be active before logging progress`,
        );
      }
    });
  }

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
      await this.deps.store.addBlocker(taskId, blockerId, owner);
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

  async waitOnExistingCondition(
    taskId: string,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const current = await this.deps.store.show(taskId);
    const lifecycle = requireManaged(current);
    if (hasOperation(lifecycle, operationId)) return current;
    requireCurrentOwner(taskId, lifecycle, owner);
    const hasUnresolvedBlockers = current.dependencies.some(
      (dependency) =>
        dependency.dependencyType === "blocks" &&
        dependency.status !== "closed",
    );
    const kind =
      lifecycle.waiting?.kind ?? (hasUnresolvedBlockers ? "dependency" : null);
    if (kind === null) {
      throw new Error(`task ${taskId} has no unresolved waiting condition`);
    }
    if (kind === "check" && lifecycle.activeCheck === null) {
      throw new Error(`task ${taskId} has no active check to wait on`);
    }
    await this.releaseResources(taskId, lifecycle, owner, operationId);
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      requireCurrentOwner(taskId, latest, owner);
      const next = waitLifecycle(latest, {
        operationId,
        now,
        kind,
        ...(kind === "check" ? { check: latest.activeCheck! } : {}),
      });
      return this.mutation(
        issue,
        operationId,
        kind === "check" ? "blocked" : "open",
        next,
      );
    });
  }

  async defer(
    taskId: string,
    reason: string,
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
      const next = deferLifecycle(latest, { operationId, now, reason });
      return this.mutation(issue, operationId, "deferred", next);
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
    if (disposition.kind === "completed" && hasUnresolvedCondition(current)) {
      throw new Error(
        `task ${taskId} has an unresolved condition and cannot be completed`,
      );
    }
    await this.releaseResources(taskId, lifecycle, owner, operationId);
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      if (latest.phase === "active") {
        requireCurrentOwner(taskId, latest, owner);
      }
      if (disposition.kind === "completed" && hasUnresolvedCondition(issue)) {
        throw new Error(
          `task ${taskId} has an unresolved condition and cannot be completed`,
        );
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

  async reconcileTask(
    taskId: string,
    owner: LockOwner,
    input: ObserveCheckInput = {},
  ): Promise<LifecycleIssue> {
    let current = await this.deps.store.show(taskId);
    let lifecycle = current.lifecycle;
    if (lifecycle === null) return current;
    if (lifecycle.phase === "active") {
      current = await this.reconcileWorktreeResources(
        taskId,
        current,
        lifecycle,
        owner,
      );
      current = await this.reconcileExecutionTimeout(taskId, owner);
      lifecycle = current.lifecycle;
      if (lifecycle?.phase !== "active") return current;
    }
    if (
      (lifecycle.phase !== "waiting" && lifecycle.phase !== "active") ||
      lifecycle.waiting === null
    ) {
      return current;
    }
    const now = this.nowIso();
    if (lifecycle.waiting.kind === "dependency") {
      const unresolved = current.dependencies.some(
        (dependency) =>
          dependency.dependencyType === "blocks" &&
          dependency.status !== "closed",
      );
      if (unresolved) return current;
      const operationId = `dependencies-satisfied:${lifecycle.stateEnteredAt}`;
      return this.deps.store.mutate(taskId, owner, (issue) => {
        const latest = requireManaged(issue);
        if (
          (latest.phase !== "waiting" && latest.phase !== "active") ||
          latest.waiting?.kind !== "dependency"
        ) {
          return unchangedMutation(issue, operationId);
        }
        const next =
          latest.phase === "active"
            ? finishActiveWaiting(
                latest,
                operationId,
                "dependencies_satisfied",
                now,
                null,
              )
            : finishWaiting(
                latest,
                operationId,
                "dependencies_satisfied",
                now,
                null,
              );
        return this.mutation(
          issue,
          operationId,
          latest.phase === "active" ? "in_progress" : "open",
          next,
        );
      });
    }

    const activeCheck = lifecycle.activeCheck;
    if (activeCheck === null) return current;
    const explicitlyReconciled = input.manualOutcome !== undefined;
    if (
      !explicitlyReconciled &&
      activeCheck.nextCheckAt !== null &&
      Date.parse(activeCheck.nextCheckAt) > this.deps.now()
    ) {
      return current;
    }
    if (this.deps.checkAdapters === undefined) {
      throw new Error("check reconciliation requires configured adapters");
    }
    const observation = await this.deps.checkAdapters.observe(
      activeCheck,
      lifecycle.artifacts,
      input,
    );
    const operationId = `check-observation:${activeCheck.id}:${now}`;
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      if (
        (latest.phase !== "waiting" && latest.phase !== "active") ||
        latest.waiting?.kind !== "check" ||
        latest.activeCheck?.id !== activeCheck.id
      ) {
        return unchangedMutation(issue, operationId);
      }
      const check = {
        ...latest.activeCheck,
        state: observation.outcome,
        lastCheckedAt: now,
        lastObservation: observation.observation,
      };
      if (observation.outcome === "pending") {
        check.errorCount = 0;
        check.nextCheckAt = new Date(
          this.deps.now() + (this.deps.prPollIntervalMs ?? 900_000),
        ).toISOString();
        const next = recordCheckObservation(
          { ...latest, activeCheck: check },
          operationId,
          now,
        );
        return this.mutation(
          issue,
          operationId,
          latest.phase === "active" ? "in_progress" : "blocked",
          next,
        );
      }
      if (observation.outcome === "error") {
        check.errorCount = latest.activeCheck.errorCount + 1;
        check.nextCheckAt = new Date(
          this.deps.now() +
            nextCheckBackoffMs(
              check.errorCount,
              this.deps.prPollIntervalMs ?? 900_000,
              this.deps.maxBackoffMs ?? 21_600_000,
            ),
        ).toISOString();
        const next = recordCheckObservation(
          { ...latest, activeCheck: check },
          operationId,
          now,
        );
        return this.mutation(
          issue,
          operationId,
          latest.phase === "active" ? "in_progress" : "blocked",
          next,
        );
      }
      check.nextCheckAt = null;
      if (latest.phase === "active") {
        const type =
          observation.outcome === "satisfied"
            ? "check_satisfied"
            : "check_action_required";
        const next = finishActiveWaiting(latest, operationId, type, now, check);
        return this.mutation(issue, operationId, "in_progress", next);
      }
      if (
        observation.outcome === "satisfied" &&
        check.onSatisfied === "close"
      ) {
        const next = closeLifecycle(
          { ...latest, activeCheck: check },
          {
            operationId,
            now,
            disposition: {
              kind: "completed",
              reason: `check ${check.id} satisfied: ${observation.observation}`,
              at: now,
              evidenceArtifactIds: check.targetArtifactIds,
            },
          },
        );
        return this.mutation(issue, operationId, "closed", next);
      }
      const type =
        observation.outcome === "satisfied"
          ? "check_satisfied"
          : "check_action_required";
      const next = finishWaiting(latest, operationId, type, now, check);
      return this.mutation(issue, operationId, "open", next);
    });
  }

  async reconcileDue(
    owner: LockOwner,
    limits: ReconcileLimits,
  ): Promise<LifecycleIssue[]> {
    const issues = await this.deps.store.list([
      "open",
      "in_progress",
      "blocked",
    ]);
    const results: LifecycleIssue[] = [];
    let checks = 0;
    for (const issue of issues) {
      if (results.length >= limits.taskLimit) break;
      if (
        (issue.lifecycle?.phase === "waiting" ||
          issue.lifecycle?.phase === "active") &&
        issue.lifecycle.waiting?.kind === "check"
      ) {
        if (checks >= limits.checkLimit) continue;
        checks += 1;
      }
      results.push(await this.reconcileTask(issue.id, owner));
    }
    return results;
  }

  async refreshSessionActivity(owner: LockOwner): Promise<LifecycleIssue[]> {
    const issues = await this.deps.store.list(["in_progress"]);
    const nowMs = this.deps.now();
    const now = new Date(nowMs).toISOString();
    const interval = this.deps.activityWriteIntervalMs ?? 300_000;
    const results: LifecycleIssue[] = [];
    for (const issue of issues) {
      const execution = issue.lifecycle?.execution;
      if (
        issue.lifecycle?.phase !== "active" ||
        execution?.sessionId !== owner.sessionId ||
        nowMs - Date.parse(execution.lastActivityAt) < interval
      ) {
        continue;
      }
      const operationId = `activity:${owner.sessionId}:${now}`;
      results.push(
        await this.deps.store.mutate(issue.id, owner, (latestIssue) => {
          const lifecycle = requireManaged(latestIssue);
          requireCurrentOwner(issue.id, lifecycle, owner);
          const currentExecution = lifecycle.execution!;
          const next = recordCheckObservation(
            {
              ...lifecycle,
              execution: {
                ...currentExecution,
                lastActivityAt: now,
                expiresAt: new Date(
                  nowMs + this.deps.executionTimeoutMs,
                ).toISOString(),
              },
            },
            operationId,
            now,
            "execution_activity",
          );
          return this.mutation(latestIssue, operationId, "in_progress", next);
        }),
      );
    }
    return results;
  }

  async interruptSession(
    owner: LockOwner,
    reason: string,
  ): Promise<LifecycleIssue[]> {
    if (reason === "reload") return [];
    const issues = await this.deps.store.list(["in_progress"]);
    const now = this.nowIso();
    const results: LifecycleIssue[] = [];
    for (const issue of issues) {
      const execution = issue.lifecycle?.execution;
      if (
        issue.lifecycle?.phase !== "active" ||
        execution?.sessionId !== owner.sessionId
      ) {
        continue;
      }
      const operationId = `execution-interrupted:${owner.sessionId}:${execution.expiresAt}`;
      results.push(
        await this.deps.store.mutate(issue.id, owner, (latestIssue) => {
          const lifecycle = requireManaged(latestIssue);
          if (hasOperation(lifecycle, operationId)) {
            return this.mutation(
              latestIssue,
              operationId,
              latestIssue.status,
              lifecycle,
            );
          }
          requireCurrentOwner(issue.id, lifecycle, owner);
          const next = interruptLifecycle(lifecycle, {
            operationId,
            now,
            expectedSessionId: owner.sessionId,
          });
          return this.mutation(
            latestIssue,
            operationId,
            interruptedStatus(next),
            next,
          );
        }),
      );
    }
    return results;
  }

  async recordWorktreeAcquire(
    request: TaskWorktreeAcquireRequest,
    acquired: AcquireResult,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const pool = this.requirePool();
    const current = await this.deps.store.show(request.taskId);
    const lifecycle = requireManaged(current);
    requireCurrentOwner(request.taskId, lifecycle, owner);

    const listing = await pool.list(request.repository);
    if (listing.repositories.length !== 1) {
      throw new Error(
        `repository ${request.repository} resolved to ${listing.repositories.length} pool identities`,
      );
    }
    const repository = listing.repositories[0];
    const matches = repository.worktrees.filter(
      (worktree) => worktree.claimId === acquired.claimId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `${matches.length === 0 ? "missing" : "ambiguous"} worktree association for claim ${acquired.claimId}`,
      );
    }
    const observation = matches[0];
    if (
      !sameBranch(request.branch, acquired.branch) ||
      observation.path !== acquired.path ||
      observation.head !== acquired.head
    ) {
      throw new Error(
        `contradictory worktree association for claim ${acquired.claimId}`,
      );
    }
    const pathId = pathIdFromManagedPath(acquired.path, acquired.claimId);
    const candidate: WorktreeResource = {
      id: `worktree:${acquired.claimId}`,
      kind: "worktree",
      repository: repository.name,
      claimId: acquired.claimId,
      pathId,
      operationId,
      path: acquired.path,
      branch: acquired.branch,
      branchArtifactId: null,
      acquiredAt: null,
      releasedAt: null,
      cleanupState: "acquiring",
    };
    assertValidAssociation(candidate, observation);
    await this.assertHealthyAssociations(lifecycle, pool, acquired.claimId);

    const poolObservation = observation;
    const now = this.nowIso();
    return this.deps.store.mutate(request.taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      requireCurrentOwner(request.taskId, latest, owner);
      const existing = latest.resources.find(
        (resource) => resource.claimId === acquired.claimId,
      );
      if (existing?.cleanupState === "active") {
        assertValidAssociation(existing, observation);
        return unchangedMutation(issue, `${existing.operationId}:active`);
      }
      if (existing !== undefined && existing.cleanupState !== "acquiring") {
        throw new Error(
          `worktree claim ${acquired.claimId} is ${existing.cleanupState}`,
        );
      }

      const effectiveOperationId = existing?.operationId ?? operationId;
      const acquiring =
        existing === undefined
          ? beginWorktreeAcquire(latest, {
              operationId,
              claimId: acquired.claimId,
              pathId,
              repository: repository.name,
              branch: acquired.branch,
              now,
            })
          : latest;
      const next = completeWorktreeAcquire(acquiring, {
        operationId: effectiveOperationId,
        claimId: acquired.claimId,
        path: acquired.path,
        head: acquired.head,
        now,
        observation: poolObservation,
      });
      return this.mutation(
        issue,
        `${effectiveOperationId}:active`,
        issue.status,
        next,
      );
    });
  }

  async prepareWorktreeAcquire(
    request: TaskWorktreeAcquireRequest,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<Extract<PreparedWorktreeOperation, { mode: "acquire" }>> {
    const pool = this.requirePool();
    const current = await this.deps.store.show(request.taskId);
    const lifecycle = requireManaged(current);
    requireCurrentOwner(request.taskId, lifecycle, owner);

    const identityListing = await pool.list(request.repository);
    if (identityListing.repositories.length !== 1) {
      throw new Error(
        `repository ${request.repository} resolved to ${identityListing.repositories.length} pool identities`,
      );
    }
    const repository = identityListing.repositories[0].name;
    const pending = lifecycle.resources.find(
      (resource) =>
        resource.cleanupState === "acquiring" &&
        resource.repository === repository &&
        sameBranch(resource.branch, request.branch),
    );
    await this.assertHealthyAssociations(lifecycle, pool, pending?.claimId);

    if (pending !== undefined) {
      return {
        version: 1,
        mode: "acquire",
        taskId: request.taskId,
        operationId: pending.operationId,
        claimId: pending.claimId,
        pathId: pending.pathId,
        repository: pending.repository,
      };
    }

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
    return {
      version: 1,
      mode: "acquire",
      taskId: request.taskId,
      operationId,
      claimId,
      pathId,
      repository,
    };
  }

  async finalizeWorktreeAcquire(
    context: Extract<PreparedWorktreeOperation, { mode: "acquire" }>,
    acquired: AcquireResult,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    if (acquired.claimId !== context.claimId) {
      throw new Error(
        `pool returned claim ${acquired.claimId} instead of persisted claim ${context.claimId}`,
      );
    }
    return this.finalizeAcquireResult(
      context.taskId,
      owner,
      context.operationId,
      context.claimId,
      acquired,
    );
  }

  async acquireWorktree(
    request: TaskWorktreeAcquireRequest,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const pool = this.requirePool();
    const prepared = await this.prepareWorktreeAcquire(
      request,
      owner,
      operationId,
    );
    const matches = await exactClaimMatches(
      pool,
      prepared.repository,
      prepared.claimId,
    );
    if (matches.length > 1) {
      throw new Error(
        `ambiguous worktree association for claim ${prepared.claimId}`,
      );
    }
    if (matches.length === 1) {
      const current = requireManaged(
        await this.deps.store.show(request.taskId),
      );
      const resource = current.resources.find(
        (candidate) => candidate.claimId === prepared.claimId,
      )!;
      assertValidAssociation(resource, matches[0]);
      return this.finishWorktreeAcquire(
        request.taskId,
        owner,
        prepared.operationId,
        prepared.claimId,
        matches[0].path,
        matches[0].head!,
        matches[0],
      );
    }
    const acquired = await pool.acquire(
      {
        repository: prepared.repository,
        branch: request.branch,
        ...(request.startPoint === undefined
          ? {}
          : { startPoint: request.startPoint }),
      },
      owner,
      { claimId: prepared.claimId, pathId: prepared.pathId },
    );
    return this.finalizeWorktreeAcquire(prepared, acquired, owner);
  }

  async prepareWorktreeRelease(
    taskId: string,
    claimId: string,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<Extract<PreparedWorktreeOperation, { mode: "release" }>> {
    const current = await this.deps.store.show(taskId);
    const lifecycle = requireManaged(current);
    requireCurrentOwner(taskId, lifecycle, owner);
    const resource = lifecycle.resources.find(
      (candidate) => candidate.claimId === claimId,
    );
    if (resource === undefined) {
      throw new Error(`unknown worktree claim ${claimId}`);
    }
    if (resource.cleanupState === "released") {
      throw new Error(`worktree claim ${claimId} is already released`);
    }
    if (resource.cleanupState === "release_pending") {
      return {
        version: 1,
        mode: "release",
        taskId,
        operationId: resource.operationId,
        claimId,
        repository: resource.repository,
      };
    }

    const now = this.nowIso();
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
    return {
      version: 1,
      mode: "release",
      taskId,
      operationId,
      claimId,
      repository: resource.repository,
    };
  }

  async finalizeWorktreeRelease(
    context: Extract<PreparedWorktreeOperation, { mode: "release" }>,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    return this.finishWorktreeRelease(
      context.taskId,
      owner,
      context.operationId,
      context.claimId,
    );
  }

  async releaseWorktree(
    taskId: string,
    claimId: string,
    owner: LockOwner,
    operationId: string = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    const pool = this.requirePool();
    const before = requireManaged(await this.deps.store.show(taskId));
    const wasPending = before.resources.some(
      (resource) =>
        resource.claimId === claimId &&
        resource.cleanupState === "release_pending",
    );
    const prepared = await this.prepareWorktreeRelease(
      taskId,
      claimId,
      owner,
      operationId,
    );
    if (wasPending) {
      const matches = await exactClaimMatches(
        pool,
        prepared.repository,
        claimId,
      );
      if (matches.length > 1) {
        throw new Error(`ambiguous worktree association for claim ${claimId}`);
      }
      if (matches.length === 0) {
        return this.finalizeWorktreeRelease(prepared, owner);
      }
    }
    const released = await pool.release(prepared.repository, claimId, owner);
    if (!released.released) {
      throw new Error(`worktree release refused for claim ${claimId}`);
    }
    return this.finalizeWorktreeRelease(prepared, owner);
  }

  async activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]> {
    const issues = await this.deps.store.list(["in_progress"]);
    return issues
      .filter(
        (issue) =>
          issue.lifecycle?.phase === "active" &&
          issue.lifecycle.execution?.sessionId === sessionId,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async hasActiveTask(sessionId: string): Promise<boolean> {
    return (await this.activeTasksForSession(sessionId)).length > 0;
  }

  async associatedTasksForClaim(claimId: string): Promise<LifecycleIssue[]> {
    const issues = await this.deps.store.list([
      "open",
      "in_progress",
      "blocked",
      "deferred",
      "closed",
    ]);
    return issues
      .filter((issue) =>
        issue.lifecycle?.resources.some(
          (resource) => resource.claimId === claimId,
        ),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async isClaimAssociated(claimId: string): Promise<boolean> {
    return (await this.associatedTasksForClaim(claimId)).length > 0;
  }

  private async finalizeAcquireResult(
    taskId: string,
    owner: LockOwner,
    operationId: string,
    claimId: string,
    acquired: AcquireResult,
  ): Promise<LifecycleIssue> {
    return this.finishWorktreeAcquire(
      taskId,
      owner,
      operationId,
      claimId,
      acquired.path,
      acquired.head,
      acquireObservation(acquired),
    );
  }

  private async finishWorktreeAcquire(
    taskId: string,
    owner: LockOwner,
    operationId: string,
    claimId: string,
    path: string,
    head: string,
    observation: PoolWorktreeListing,
    expectedSessionId: string = owner.sessionId,
  ): Promise<LifecycleIssue> {
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      requireCurrentOwnerSession(taskId, latest, expectedSessionId);
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

  private async finishWorktreeRelease(
    taskId: string,
    owner: LockOwner,
    operationId: string,
    claimId: string,
    expectedSessionId: string = owner.sessionId,
  ): Promise<LifecycleIssue> {
    const now = this.nowIso();
    return this.deps.store.mutate(taskId, owner, (issue) => {
      const latest = requireManaged(issue);
      requireCurrentOwnerSession(taskId, latest, expectedSessionId);
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

  private async reconcileWorktreeResources(
    taskId: string,
    issue: LifecycleIssue,
    lifecycle: LifecycleMetadataV1,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    const pending = lifecycle.resources.filter(
      (resource) =>
        resource.cleanupState === "acquiring" ||
        resource.cleanupState === "release_pending",
    );
    if (pending.length === 0) return issue;

    const pool = this.requirePool();
    const expectedSessionId = lifecycle.execution?.sessionId;
    if (expectedSessionId === undefined) {
      throw new Error(`task ${taskId} is not actively owned`);
    }
    let current = issue;
    for (const resource of pending) {
      const matches = await exactClaimMatches(
        pool,
        resource.repository,
        resource.claimId,
      );
      if (matches.length !== 1) {
        if (
          resource.cleanupState === "release_pending" &&
          matches.length === 0
        ) {
          current = await this.finishWorktreeRelease(
            taskId,
            owner,
            resource.operationId,
            resource.claimId,
            expectedSessionId,
          );
          continue;
        }
        throw new Error(
          `${matches.length === 0 ? "missing" : "ambiguous"} worktree association for claim ${resource.claimId}`,
        );
      }

      assertValidAssociation(resource, matches[0]);
      if (resource.cleanupState === "release_pending") {
        throw new Error(
          `worktree release remains pending for claim ${resource.claimId}`,
        );
      }
      current = await this.finishWorktreeAcquire(
        taskId,
        owner,
        resource.operationId,
        resource.claimId,
        matches[0].path,
        matches[0].head!,
        matches[0],
        expectedSessionId,
      );
    }
    return current;
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
      return this.mutation(issue, operationId, interruptedStatus(next), next);
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
      try {
        await this.releaseWorktree(
          taskId,
          resource.claimId,
          owner,
          `${parentOperationId}:release:${resource.claimId}`,
        );
      } catch {
        throw new Error(
          `task ${safeIdentifier(taskId)} still owns worktree ${safeIdentifier(resource.claimId)}; make it releasable or release it before waiting`,
        );
      }
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

function interruptedStatus(lifecycle: LifecycleMetadataV1): LifecycleStatus {
  return lifecycle.phase === "waiting" && lifecycle.waiting?.kind === "check"
    ? "blocked"
    : "open";
}

function hasUnresolvedCondition(issue: LifecycleIssue): boolean {
  return (
    issue.dependencies.some(
      (dependency) =>
        dependency.dependencyType === "blocks" &&
        dependency.status !== "closed",
    ) ||
    (issue.lifecycle !== null && issue.lifecycle.activeCheck !== null)
  );
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
  requireCurrentOwnerSession(taskId, lifecycle, owner.sessionId);
}

function requireCurrentOwnerSession(
  taskId: string,
  lifecycle: LifecycleMetadataV1,
  expectedSessionId: string,
): void {
  if (lifecycle.phase !== "active" || lifecycle.execution === null) {
    throw new Error(`task ${taskId} is not actively owned`);
  }
  if (lifecycle.execution.sessionId !== expectedSessionId) {
    throw new Error(
      `task ${taskId} is owned by active session ${lifecycle.execution.sessionId}`,
    );
  }
}

function finishActiveWaiting(
  lifecycle: LifecycleMetadataV1,
  operationId: string,
  type: string,
  now: string,
  check: LifecycleCheck | null,
): LifecycleMetadataV1 {
  return {
    ...lifecycle,
    waiting: null,
    activeCheck: null,
    checkHistory:
      check === null
        ? lifecycle.checkHistory
        : [...lifecycle.checkHistory, check],
    lastProgressAt: now,
    transitionHistory: [
      ...lifecycle.transitionHistory,
      {
        operationId,
        type,
        at: now,
        from: "active",
        to: "active",
        sessionId: lifecycle.execution?.sessionId,
      },
    ],
  };
}

function finishWaiting(
  lifecycle: LifecycleMetadataV1,
  operationId: string,
  type: string,
  now: string,
  check: LifecycleCheck | null,
): LifecycleMetadataV1 {
  return {
    ...lifecycle,
    phase: "actionable",
    waiting: null,
    activeCheck: null,
    checkHistory:
      check === null
        ? lifecycle.checkHistory
        : [...lifecycle.checkHistory, check],
    stateEnteredAt: now,
    lastProgressAt: now,
    transitionHistory: [
      ...lifecycle.transitionHistory,
      {
        operationId,
        type,
        at: now,
        from: lifecycle.phase,
        to: "actionable",
      },
    ],
  };
}

function recordCheckObservation(
  lifecycle: LifecycleMetadataV1,
  operationId: string,
  now: string,
  type = "check_observed",
): LifecycleMetadataV1 {
  if (hasOperation(lifecycle, operationId)) return lifecycle;
  return {
    ...lifecycle,
    transitionHistory: [
      ...lifecycle.transitionHistory,
      {
        operationId,
        type,
        at: now,
        from: lifecycle.phase,
        to: lifecycle.phase,
      },
    ],
  };
}

function acquireObservation(acquired: AcquireResult): PoolWorktreeListing {
  return {
    claimId: acquired.claimId,
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
}

function pathIdFromManagedPath(path: string, claimId: string): string {
  const prefix = "worktree-";
  const name = basename(path);
  if (!name.startsWith(prefix) || name.length === prefix.length) {
    throw new Error(`invalid managed path for claim ${claimId}`);
  }
  return name.slice(prefix.length);
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
  const currentBranch = listing.currentBranch?.startsWith("refs/heads/")
    ? listing.currentBranch
    : listing.currentBranch === null
      ? null
      : `refs/heads/${listing.currentBranch}`;
  const valid =
    branch === fullBranch &&
    currentBranch === fullBranch &&
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

function normalizeLabels(labels: readonly string[]): string[] {
  const normalized = labels.map((label) => label.trim());
  const empty = normalized.find((label) => label.length === 0);
  if (empty !== undefined) {
    throw new Error("task labels must not be empty");
  }
  return [...new Set(normalized)];
}

function safeIdentifier(value: string): string {
  return value.slice(0, 128).replace(/[^A-Za-z0-9._:-]/g, "?");
}

function sameBranch(left: string, right: string): boolean {
  const canonical = (branch: string) =>
    branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
  return canonical(left) === canonical(right);
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
