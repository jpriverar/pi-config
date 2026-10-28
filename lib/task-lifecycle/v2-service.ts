import { isDeepStrictEqual } from "node:util";
import { assertText } from "./model.js";
import { ownerOf } from "./ownership.js";
import {
  blockLifecycleV2,
  claimLifecycleV2,
  closeLifecycleV2,
  deferLifecycleV2,
  fingerprintConditionV2,
  nativeStatusV2,
  releaseLifecycleV2,
  reopenLifecycleV2,
  resumeLifecycleV2,
  validateLifecycleV2,
} from "./v2-model.js";
import type {
  ConditionUpdate,
  CreateTaskInput,
  Disposition,
  LifecycleIssue,
  LifecycleIssueV2,
  LifecycleMetadataV2,
  LifecycleStore,
  LockOwner,
  TaskBlockInput,
} from "./types.js";

interface Dependencies {
  store: LifecycleStore;
  now(): number;
  uuid(): string;
  lifecycleWriteVersion?: 1 | 2;
}
type AddBlockers = (ids: readonly string[]) => Promise<LifecycleIssueV2>;

export async function listOwnedTasks(
  store: LifecycleStore,
  sessionId: string,
): Promise<LifecycleIssue[]> {
  const issues = await store.list([
    "open",
    "in_progress",
    "blocked",
    "deferred",
    "closed",
  ]);
  const owned: LifecycleIssue[] = [];
  for (const issue of issues) {
    if (
      issue.lifecycle === null &&
      Object.hasOwn(issue.metadata, "piLifecycle")
    )
      throw new Error(
        `task ${issue.id} has invalid or unsupported piLifecycle metadata; ownership is unavailable`,
      );
    if (ownerOf(issue.lifecycle)?.sessionId === sessionId) owned.push(issue);
  }
  return owned.sort((a, b) => a.id.localeCompare(b.id));
}

export class V2LifecycleOperations {
  constructor(private readonly deps: Dependencies) {}

  async create(
    input: CreateTaskInput,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    this.requireMode();
    const now = this.now();
    return this.deps.store.create(
      input,
      {
        version: 2,
        phase: "actionable",
        owner: null,
        condition: null,
        pause: null,
        stateEnteredAt: now,
        lastProgressAt: now,
        artifacts: [],
        activeCheck: null,
        checkHistory: [],
        transitionHistory: [],
        resources: [],
        disposition: null,
      },
      owner,
    );
  }

  async claim(
    taskId: string,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(taskId, owner, operationId, async (issue) => {
      const owned = await listOwnedTasks(this.deps.store, owner.sessionId);
      const different = owned.find((candidate) => candidate.id !== taskId);
      if (different)
        throw new Error(
          `session already owns task ${different.id}; release it before claiming ${taskId}`,
        );
      const state = issue.lifecycle;
      if (state.owner === null && state.phase === "actionable") {
        const ready = await this.deps.store.readyIds();
        if (!ready.has(taskId))
          throw new Error(
            `task ${taskId} is not natively ready; its prerequisites must be inspected`,
          );
      }
      return claimLifecycleV2(state, this.actor(owner, operationId));
    });
  }

  async block(
    taskId: string,
    input: TaskBlockInput,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(
      taskId,
      owner,
      operationId,
      async (issue, addBlockers) => {
        requireOwner(issue, owner);
        if (alreadyApplied(issue, operationId, owner, "block"))
          return issue.lifecycle;
        assertText(input.reason, "block reason");
        const changed =
          input.condition === undefined
            ? issue
            : await this.prepareCondition(
                issue,
                { ...input.condition, reason: input.reason },
                owner,
                operationId,
              );
        const before = blockLifecycleV2(
          changed.lifecycle,
          {
            ...this.actor(owner, operationId),
            reason: input.reason,
            conditionFingerprint: fingerprintConditionV2(
              changed.lifecycle,
              changed.dependencies,
            )!,
          },
          changed.dependencies,
        );
        validateLifecycleV2(before, {
          ...changed,
          status: nativeStatusV2(before),
          lifecycle: before,
        });
        if (input.condition?.kind !== "dependency") return before;
        const updated = await addBlockers(
          missingBlockers(issue, input.condition.blockerIds),
        );
        requireOwner(updated, owner);
        const state = { ...changed.lifecycle };
        return blockLifecycleV2(
          state,
          {
            ...this.actor(owner, operationId),
            reason: input.reason,
            conditionFingerprint: fingerprintConditionV2(
              state,
              updated.dependencies,
            )!,
          },
          updated.dependencies,
        );
      },
    );
  }

  async resume(
    taskId: string,
    reason: string,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(taskId, owner, operationId, (issue) =>
      resumeLifecycleV2(issue.lifecycle, {
        ...this.actor(owner, operationId),
        reason,
      }),
    );
  }

  async release(
    taskId: string,
    reason: string,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(taskId, owner, operationId, (issue) =>
      releaseLifecycleV2(
        issue.lifecycle,
        { ...this.actor(owner, operationId), reason },
        issue.dependencies,
      ),
    );
  }

  async updateCondition(
    taskId: string,
    change: ConditionUpdate,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(
      taskId,
      owner,
      operationId,
      async (issue, addBlockers) => {
        requireOwner(issue, owner);
        if (alreadyApplied(issue, operationId, owner, "condition_update"))
          return issue.lifecycle;
        if (issue.lifecycle.phase === "waiting")
          throw new Error(
            `task ${taskId} is blocked; resume or replace its pause atomically with task_block`,
          );
        const changed = await this.prepareCondition(
          issue,
          change,
          owner,
          operationId,
        );
        validateLifecycleV2(changed.lifecycle, {
          ...changed,
          status: nativeStatusV2(changed.lifecycle),
        });
        if (change.kind === "dependency") {
          const updated = await addBlockers(
            missingBlockers(issue, change.blockerIds),
          );
          requireOwner(updated, owner);
        }
        if (isDeepStrictEqual(changed.lifecycle, issue.lifecycle))
          return issue.lifecycle;
        const previous = issue.lifecycle.condition;
        const reason = previous
          ? `${change.reason}; previous condition ${previous.id} (${previous.purpose})`
          : change.reason;
        return {
          ...changed.lifecycle,
          transitionHistory: [
            ...changed.lifecycle.transitionHistory,
            {
              operationId,
              type: "condition_update",
              at: this.now(),
              from: changed.lifecycle.phase,
              to: changed.lifecycle.phase,
              sessionId: owner.sessionId,
              reason,
            },
          ],
        };
      },
    );
  }

  async close(
    taskId: string,
    disposition: Omit<Disposition, "at">,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(taskId, owner, operationId, (issue) => {
      requireOwner(issue, owner);
      return closeLifecycleV2(
        issue.lifecycle,
        {
          ...this.actor(owner, operationId),
          disposition: { ...disposition, at: this.now() },
        },
        issue.dependencies,
      );
    });
  }

  async defer(
    taskId: string,
    reason: string,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(taskId, owner, operationId, (issue) =>
      deferLifecycleV2(issue.lifecycle, {
        ...this.actor(owner, operationId),
        reason,
      }),
    );
  }

  async reopen(
    taskId: string,
    reason: string,
    owner: LockOwner,
    operationId = this.deps.uuid(),
  ): Promise<LifecycleIssue> {
    return this.mutate(taskId, owner, operationId, (issue) =>
      reopenLifecycleV2(
        issue.lifecycle,
        { ...this.actor(owner, operationId), reason },
        issue.dependencies,
      ),
    );
  }

  private async prepareCondition(
    issue: LifecycleIssueV2,
    change: ConditionUpdate,
    owner: LockOwner,
    operationId: string,
  ): Promise<LifecycleIssueV2> {
    const state = issue.lifecycle;
    requireOwner(issue, owner);
    if (state.phase === "done" || state.phase === "deferred")
      throw new Error(
        `task ${issue.id} must be reopened before changing its condition`,
      );
    assertText(change.reason, "condition change reason");
    let next: LifecycleMetadataV2;
    let dependencies = issue.dependencies;
    if (change.kind === "clear") {
      if (
        dependencies.some(
          (dep) => dep.dependencyType === "blocks" && dep.status !== "closed",
        )
      )
        throw new Error(
          `task ${issue.id} has unresolved native blockers; clearing metadata cannot remove them`,
        );
      next = { ...state, condition: null, activeCheck: null, pause: null };
    } else if (change.kind === "dependency") {
      const ids = [...new Set(change.blockerIds)];
      if (ids.length === 0 || ids.includes(issue.id))
        throw new Error(
          `task ${issue.id} requires nonempty dependency IDs excluding itself`,
        );
      const targets = await this.deps.store.showMany(ids);
      const statuses = new Map(
        targets.map((target) => [target.id, target.status]),
      );
      if (ids.some((id) => !statuses.has(id)))
        throw new Error(`task ${issue.id} has unavailable dependency targets`);
      const existing = new Set(
        dependencies
          .filter((dep) => dep.dependencyType === "blocks")
          .map((dep) => dep.id),
      );
      dependencies = [
        ...dependencies,
        ...ids
          .filter((id) => !existing.has(id))
          .map((id) => ({
            id,
            status: statuses.get(id)!,
            dependencyType: "blocks",
          })),
      ];
      next = {
        ...state,
        condition: {
          id:
            state.condition?.kind === "dependency"
              ? state.condition.id
              : operationId,
          kind: "dependency",
          purpose: "completion",
        },
        activeCheck: null,
        pause: null,
      };
    } else {
      const check = change.check;
      if (
        check.state !== "pending" ||
        check.lastCheckedAt !== null ||
        check.lastObservation !== null ||
        check.errorCount !== 0
      )
        throw new Error(
          `task ${issue.id} requires a pending, unobserved condition; observations cannot be supplied by an edit`,
        );
      next = {
        ...state,
        condition: {
          id:
            state.condition?.kind === "check" &&
            state.activeCheck?.id === check.id
              ? state.condition.id
              : check.id,
          kind: "check",
          purpose: change.purpose,
        },
        activeCheck: {
          ...check,
          nextCheckAt: check.kind === "manual" ? null : check.nextCheckAt,
        },
        pause: null,
      };
    }
    const unchangedCriterion =
      fingerprintConditionV2(state, issue.dependencies) ===
      fingerprintConditionV2(next, dependencies);
    if (
      unchangedCriterion &&
      state.activeCheck !== null &&
      next.activeCheck !== null
    ) {
      next.activeCheck = {
        ...next.activeCheck,
        state: state.activeCheck.state,
        lastCheckedAt: state.activeCheck.lastCheckedAt,
        nextCheckAt: state.activeCheck.nextCheckAt,
        lastObservation: state.activeCheck.lastObservation,
        errorCount: state.activeCheck.errorCount,
      };
    }
    const extendingDependencies =
      state.condition?.kind === "dependency" && change.kind === "dependency";
    if (
      !unchangedCriterion &&
      !extendingDependencies &&
      change.kind !== "clear" &&
      state.condition?.purpose === "completion" &&
      (state.condition.kind === "dependency"
        ? issue.dependencies.some(
            (dep) => dep.dependencyType === "blocks" && dep.status !== "closed",
          )
        : state.activeCheck?.state !== "satisfied")
    ) {
      throw new Error(
        `task ${issue.id} has an unmet completion requirement; explicitly clear it before replacing it`,
      );
    }
    if (!unchangedCriterion && state.activeCheck !== null)
      next.checkHistory = [...state.checkHistory, state.activeCheck];
    return { ...issue, lifecycle: next, dependencies };
  }

  private async mutate(
    taskId: string,
    owner: LockOwner,
    operationId: string,
    operation: (
      issue: LifecycleIssueV2,
      addBlockers: AddBlockers,
    ) => LifecycleMetadataV2 | Promise<LifecycleMetadataV2>,
  ): Promise<LifecycleIssue> {
    this.requireMode();
    return this.deps.store.mutate(taskId, owner, async (raw, addBlockers) => {
      let current = requireV2(raw);
      const next = await operation(current, async (ids) => {
        if (ids.length > 0) current = requireV2(await addBlockers(ids));
        return current;
      });
      if (isDeepStrictEqual(current.lifecycle, next)) return null;
      const status = nativeStatusV2(next);
      validateLifecycleV2(next, { ...current, status, lifecycle: next });
      return { operationId, status, lifecycle: next };
    });
  }

  private requireMode(): void {
    if ((this.deps.lifecycleWriteVersion ?? 1) !== 2)
      throw new Error("this operation requires lifecycle write version 2");
  }

  private now(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private actor(owner: LockOwner, operationId: string) {
    return { operationId, sessionId: owner.sessionId, now: this.now() };
  }
}

function requireV2(issue: LifecycleIssue): LifecycleIssueV2 {
  if (issue.lifecycle?.version !== 2)
    throw new Error(
      `task ${issue.id} requires reviewed conversion before lifecycle write version 2`,
    );
  if (issue.status !== nativeStatusV2(issue.lifecycle))
    throw new Error(
      `task ${issue.id} lifecycle phase conflicts with native status ${issue.status}`,
    );
  return { ...issue, lifecycle: issue.lifecycle };
}

function requireOwner(issue: LifecycleIssueV2, owner: LockOwner): void {
  if (issue.lifecycle.owner?.sessionId !== owner.sessionId)
    throw new Error(
      `task ${issue.id} is not owned by session ${owner.sessionId}`,
    );
}

function alreadyApplied(
  issue: LifecycleIssueV2,
  operationId: string,
  owner: LockOwner,
  type: string,
): boolean {
  const prior = issue.lifecycle.transitionHistory.find(
    (entry) => entry.operationId === operationId,
  );
  if (prior === undefined) return false;
  if (prior.type !== type || prior.sessionId !== owner.sessionId)
    throw new Error(
      `task ${issue.id} operation ${operationId} conflicts with an earlier operation`,
    );
  return true;
}

function missingBlockers(
  issue: LifecycleIssueV2,
  ids: readonly string[],
): string[] {
  const existing = new Set(
    issue.dependencies
      .filter((dep) => dep.dependencyType === "blocks")
      .map((dep) => dep.id),
  );
  return [...new Set(ids)].filter((id) => !existing.has(id));
}
