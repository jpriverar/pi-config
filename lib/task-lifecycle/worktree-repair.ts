import type { WorktreePool } from "../../extensions/worktree-pool/pool.js";
import {
  ClaimRepairError,
  type ClaimRepairSnapshot,
} from "../../extensions/worktree-pool/claim-repair.js";
import {
  beginWorktreeAcquire,
  completeWorktreeAcquire,
  validateLifecycle,
} from "./model.js";
import { digest } from "./reconciliation.js";
import type {
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecycleStore,
  LockOwner,
} from "./types.js";

export type RepairPool = Pick<
  WorktreePool,
  "list" | "inspectRepairClaims" | "withClaimRepair"
>;
export type RepairAction = "cancel_release" | "associate" | "none";
export interface WorktreeRepairPlan {
  version: 1;
  taskId: string;
  repository: string;
  originalSessionId: string;
  executionExpiresAt: string;
  fingerprint: string;
  claims: Array<{
    claimId: string;
    path: string;
    branch: string;
    head: string;
    owner: LockOwner;
    poolState: string;
    nativeLock: "matching" | "absent";
    taskState: string;
    action: RepairAction;
  }>;
}
export interface WorktreeRepairResult {
  taskId: string;
  repairedClaimIds: string[];
}
export class WorktreeRepairError extends Error {}

export class WorktreeRepairService {
  constructor(
    private readonly deps: {
      store: LifecycleStore;
      loadPool(claimIds: readonly string[]): Promise<RepairPool>;
      now(): number;
    },
  ) {}

  async preview(
    taskId: string,
    claimIds: readonly string[],
  ): Promise<WorktreeRepairPlan> {
    const ids = selection(taskId, claimIds);
    try {
      const pool = await this.deps.loadPool(ids);
      const repository = await this.repository(pool, ids);
      const issue = await this.deps.store.show(taskId);
      const inventory = await this.inventory();
      const snapshots = await pool.inspectRepairClaims(repository, ids);
      return this.plan(issue, inventory, repository, snapshots);
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async apply(
    taskId: string,
    claimIds: readonly string[],
    expectedFingerprint: string,
    actor: LockOwner,
    signal?: AbortSignal,
  ): Promise<WorktreeRepairResult> {
    const ids = selection(taskId, claimIds);
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint))
      throw new WorktreeRepairError(
        "Invalid repair fingerprint; request a fresh preview.",
      );
    let mutationAttempted = false;
    const repairedClaimIds: string[] = [];
    try {
      signal?.throwIfAborted();
      const pool = await this.deps.loadPool(ids);
      const repository = await this.repository(pool, ids);
      // Hold pool then store through verified persistence; confirmation happens before this call.
      await pool.withClaimRepair(repository, ids, actor, (transaction) =>
        this.deps.store.mutate(taskId, actor, async (current) => {
          signal?.throwIfAborted();
          const inventory = await this.inventory();
          const snapshots = await transaction.inspect();
          const plan = this.plan(current, inventory, repository, snapshots);
          if (plan.fingerprint !== expectedFingerprint)
            throw new WorktreeRepairError(
              "Repair preview is stale; state changed. Request a fresh preview.",
            );
          if (plan.claims.every((claim) => claim.action === "none"))
            return null;
          const operationId = `operator-worktree-repair:${expectedFingerprint}`;
          const now = new Date(this.deps.now()).toISOString();
          const next = repairedLifecycle(
            current,
            plan,
            snapshots,
            operationId,
            actor,
            now,
          );
          validateLifecycle(next, { ...current, lifecycle: next });
          for (const snapshot of snapshots) {
            signal?.throwIfAborted();
            if (snapshot.record.state === "removing") {
              mutationAttempted = true;
              await transaction.restore(snapshot);
            }
          }
          const final = await transaction.inspect();
          for (const snapshot of final) {
            if (
              snapshot.record.state !== "active" ||
              snapshot.nativeLock !== "matching"
            )
              throw new WorktreeRepairError(
                "Repair ownership could not be verified after restoration.",
              );
          }
          if (
            digest(final) !==
            digest(
              snapshots.map((snapshot) => ({
                ...snapshot,
                nativeLock: "matching",
                record: { ...snapshot.record, state: "active" },
              })),
            )
          )
            throw new WorktreeRepairError("Claim state changed during repair.");
          signal?.throwIfAborted();
          requireActiveOwner(current, this.deps.now());
          mutationAttempted = true;
          repairedClaimIds.push(
            ...plan.claims
              .filter((claim) => claim.action !== "none")
              .map((claim) => claim.claimId),
          );
          return { operationId, status: current.status, lifecycle: next };
        }),
      );
      return { taskId, repairedClaimIds };
    } catch (error) {
      if (mutationAttempted)
        throw new WorktreeRepairError(
          "Repair may have partially changed pool or task state. Do not retry this apply automatically; request a fresh preview before further action.",
        );
      if (signal?.aborted)
        throw new WorktreeRepairError("Repair cancelled before mutation.");
      throw inspectionError(error);
    }
  }

  private inventory() {
    return this.deps.store.list([
      "open",
      "in_progress",
      "blocked",
      "deferred",
      "closed",
    ]);
  }

  private async repository(
    pool: RepairPool,
    ids: readonly string[],
  ): Promise<string> {
    const listing = await pool.list();
    const names = ids.map((id) => {
      const matches = listing.repositories.flatMap((repo) =>
        repo.worktrees.filter((w) => w.claimId === id).map(() => repo.name),
      );
      if (matches.length !== 1)
        throw new WorktreeRepairError(
          `Repair claim ${id} is missing or ambiguous.`,
        );
      return matches[0];
    });
    if (new Set(names).size !== 1)
      throw new WorktreeRepairError(
        "A repair preview must select claims from one repository.",
      );
    return names[0];
  }

  private plan(
    issue: LifecycleIssue,
    inventory: LifecycleIssue[],
    repository: string,
    snapshots: ClaimRepairSnapshot[],
  ): WorktreeRepairPlan {
    const lifecycle = requireActiveOwner(issue, this.deps.now());
    const owned = inventory.filter(
      (item) =>
        item.lifecycle?.phase === "active" &&
        item.lifecycle.execution?.sessionId === lifecycle.execution!.sessionId,
    );
    if (owned.length !== 1 || owned[0].id !== issue.id)
      throw new WorktreeRepairError(
        "Repair original owner has missing or ambiguous active task ownership.",
      );
    if (
      inventory.some(
        (item) =>
          item.lifecycle === null &&
          Object.hasOwn(item.metadata, "piLifecycle"),
      )
    )
      throw new WorktreeRepairError(
        "Repair cannot verify associations while lifecycle inventory contains malformed managed state.",
      );
    const claims = snapshots.map((snapshot) => {
      const record = snapshot.record;
      if (record.sessionId !== lifecycle.execution!.sessionId)
        throw new WorktreeRepairError(
          `Repair claim ${record.claimId} belongs to a different session owner.`,
        );
      const foreign = inventory.some(
        (item) =>
          item.id !== issue.id &&
          item.lifecycle?.resources.some(
            (resource) => resource.claimId === record.claimId,
          ),
      );
      if (foreign)
        throw new WorktreeRepairError(
          `Repair claim ${record.claimId} is associated with another task.`,
        );
      const resources = lifecycle.resources.filter(
        (resource) => resource.claimId === record.claimId,
      );
      if (resources.length > 1)
        throw new WorktreeRepairError(
          `Repair claim ${record.claimId} has ambiguous task resources.`,
        );
      const resource = resources[0];
      let action: RepairAction;
      if (resource === undefined) {
        if (record.state !== "active" || snapshot.nativeLock !== "matching")
          throw new WorktreeRepairError(
            "Only healthy active claims can be associated with a task.",
          );
        if (
          lifecycle.resources.some(
            (r) =>
              r.cleanupState !== "released" &&
              r.repository === repository &&
              fullBranch(r.branch) === fullBranch(record.branch),
          )
        )
          throw new WorktreeRepairError(
            "Repair would create a duplicate worktree branch association.",
          );
        action = "associate";
      } else {
        if (
          resource.repository !== repository ||
          resource.path !== record.path ||
          resource.pathId !== record.pathId ||
          fullBranch(resource.branch) !== fullBranch(record.branch)
        )
          throw new WorktreeRepairError(
            `Repair claim ${record.claimId} contradicts its task resource.`,
          );
        if (resource.cleanupState === "release_pending")
          action = "cancel_release";
        else if (
          resource.cleanupState === "active" &&
          record.state === "active" &&
          snapshot.nativeLock === "matching"
        )
          action = "none";
        else
          throw new WorktreeRepairError(
            `Repair claim ${record.claimId} has an unsupported task state.`,
          );
      }
      return {
        claimId: record.claimId,
        path: record.path,
        branch: record.branch,
        head: snapshot.head,
        owner: {
          pid: record.pid,
          sessionId: record.sessionId,
          host: record.host,
          started: record.started,
        },
        poolState: record.state,
        nativeLock: snapshot.nativeLock,
        taskState: resource?.cleanupState ?? "unassociated",
        action,
      };
    });
    return {
      version: 1,
      taskId: issue.id,
      repository,
      originalSessionId: lifecycle.execution!.sessionId,
      executionExpiresAt: lifecycle.execution!.expiresAt,
      fingerprint: digest({
        version: 1,
        taskId: issue.id,
        status: issue.status,
        lifecycle,
        dependencies: issue.dependencies,
        repository,
        snapshots,
      }),
      claims,
    };
  }
}

function selection(taskId: string, claimIds: readonly string[]): string[] {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) ||
    !Array.isArray(claimIds) ||
    claimIds.length < 1 ||
    claimIds.length > 8 ||
    new Set(claimIds).size !== claimIds.length ||
    claimIds.some(
      (id) =>
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          id,
        ),
    )
  )
    throw new WorktreeRepairError(
      "Repair requires a task ID and one to eight distinct exact claim UUIDs.",
    );
  return [...claimIds].sort();
}

function requireActiveOwner(
  issue: LifecycleIssue,
  now: number,
): LifecycleMetadataV1 {
  const state = issue.lifecycle;
  if (
    issue.status !== "in_progress" ||
    state?.phase !== "active" ||
    state.execution === null ||
    Date.parse(state.execution.expiresAt) <= now
  )
    throw new WorktreeRepairError(
      "Repair requires an active task with an unexpired original owner.",
    );
  validateLifecycle(state, issue);
  return state;
}

function repairedLifecycle(
  issue: LifecycleIssue,
  plan: WorktreeRepairPlan,
  snapshots: ClaimRepairSnapshot[],
  operationId: string,
  actor: LockOwner,
  now: string,
): LifecycleMetadataV1 {
  let next = structuredClone(issue.lifecycle!);
  for (const snapshot of snapshots) {
    const record = snapshot.record;
    const action = plan.claims.find(
      (claim) => claim.claimId === record.claimId,
    )!.action;
    const observation = {
      claimId: record.claimId,
      path: record.path,
      branch: record.branch,
      currentBranch: record.branch,
      head: snapshot.head,
      clean: true,
      branchProtectsHead: true,
      state: "active",
      evidence: {
        pathExists: true,
        registered: true,
        nativeClaimMatches: true,
      },
    };
    const claimOperation = `${operationId}:${record.claimId}`;
    if (action === "cancel_release") {
      next.resources = next.resources.map((resource) =>
        resource.claimId === record.claimId
          ? {
              ...resource,
              operationId: claimOperation,
              cleanupState: "active",
              lastObservation: observation,
            }
          : resource,
      );
    } else if (action === "associate") {
      next = beginWorktreeAcquire(next, {
        operationId: claimOperation,
        claimId: record.claimId,
        pathId: record.pathId,
        repository: record.repository,
        branch: record.branch,
        now,
      });
      next = completeWorktreeAcquire(next, {
        operationId: claimOperation,
        claimId: record.claimId,
        path: record.path,
        head: snapshot.head,
        now,
        observation,
      });
    }
  }
  next.lastProgressAt = now;
  next.transitionHistory.push({
    operationId,
    type: "operator_worktree_repair",
    at: now,
    from: next.phase,
    to: next.phase,
    sessionId: actor.sessionId,
    reason: `Operator-confirmed repair of ${plan.claims
      .filter((c) => c.action !== "none")
      .map((c) => c.claimId)
      .join(", ")}; original owner preserved: ${plan.originalSessionId}`,
  });
  return next;
}

function inspectionError(error: unknown): WorktreeRepairError {
  if (error instanceof WorktreeRepairError) return error;
  if (error instanceof ClaimRepairError)
    return new WorktreeRepairError(error.message);
  return new WorktreeRepairError(
    "Unable to inspect repair state safely; no repair was started.",
  );
}

function fullBranch(branch: string) {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}
