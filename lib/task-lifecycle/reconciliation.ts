import type {
  LifecycleIssue,
  LifecycleStatus,
  LifecycleStore,
} from "./types.js";

export interface ReconciliationCandidate {
  taskId: string;
  eligibleAtMs: number;
  reasons: readonly ("execution" | "resource" | "dependency" | "check")[];
}

export interface ReconciliationScan {
  candidates: readonly ReconciliationCandidate[];
  diagnostics: readonly { taskId?: string; code: string }[];
}

function canReconcile(issue: LifecycleIssue): boolean {
  return (
    (issue.status === "open" ||
      issue.status === "in_progress" ||
      issue.status === "blocked") &&
    (issue.lifecycle?.phase === "active" ||
      issue.lifecycle?.phase === "waiting")
  );
}

export function selectDueCandidates(
  issues: readonly LifecycleIssue[],
  blockerStatuses: ReadonlyMap<string, LifecycleStatus>,
  nowMs: number,
): ReconciliationCandidate[] {
  const candidates: ReconciliationCandidate[] = [];
  for (const issue of issues) {
    if (!canReconcile(issue)) continue;
    const lifecycle = issue.lifecycle!;
    const reasons: ReconciliationCandidate["reasons"][number][] = [];
    const deadlines: number[] = [];
    const enteredAt = Date.parse(lifecycle.stateEnteredAt);
    const execution = lifecycle.execution;
    if (lifecycle.phase === "active") {
      if (execution !== null && Date.parse(execution.expiresAt) <= nowMs) {
        reasons.push("execution");
        deadlines.push(Date.parse(execution.expiresAt));
      }
      const pending = lifecycle.resources.filter(
        (r) =>
          r.cleanupState === "acquiring" ||
          r.cleanupState === "release_pending",
      );
      if (pending.length > 0) {
        reasons.push("resource");
        for (const resource of pending) {
          const suffix =
            resource.cleanupState === "acquiring"
              ? "acquiring"
              : "release-pending";
          const transition = lifecycle.transitionHistory.find(
            (t) => t.operationId === `${resource.operationId}:${suffix}`,
          );
          deadlines.push(
            Date.parse(
              transition?.at ?? resource.acquiredAt ?? lifecycle.stateEnteredAt,
            ),
          );
        }
      }
    }
    if (lifecycle.waiting?.kind === "dependency") {
      const blockers = issue.dependencies.filter(
        (dep) => dep.dependencyType === "blocks",
      );
      if (blockers.every((dep) => blockerStatuses.get(dep.id) === "closed")) {
        reasons.push("dependency");
        deadlines.push(enteredAt);
      }
    }
    if (lifecycle.waiting?.kind === "check" && lifecycle.activeCheck !== null) {
      const next = lifecycle.activeCheck.nextCheckAt;
      if (next === null || Date.parse(next) <= nowMs) {
        reasons.push("check");
        deadlines.push(next === null ? enteredAt : Date.parse(next));
      }
    }
    if (reasons.length > 0) {
      candidates.push({
        taskId: issue.id,
        eligibleAtMs: Math.min(...deadlines),
        reasons,
      });
    }
  }
  return candidates.sort(
    (a, b) =>
      a.eligibleAtMs - b.eligibleAtMs || a.taskId.localeCompare(b.taskId),
  );
}

export async function scanReconciliation(
  store: LifecycleStore,
  nowMs: number,
): Promise<ReconciliationScan> {
  const issues = await store.list(["open", "in_progress", "blocked"]);
  const diagnostics: { taskId?: string; code: string }[] = [];
  const targets = new Set<string>();
  for (const issue of issues) {
    if (
      issue.lifecycle === null &&
      Object.hasOwn(issue.metadata, "piLifecycle")
    ) {
      diagnostics.push({ taskId: issue.id, code: "malformed_lifecycle" });
    }
    if (!canReconcile(issue) || issue.lifecycle?.waiting?.kind !== "dependency")
      continue;
    for (const dependency of issue.dependencies) {
      if (dependency.dependencyType === "blocks") targets.add(dependency.id);
    }
  }

  const statuses = new Map<string, LifecycleStatus>();
  let batch: string[] = [];
  let bytes = 0;
  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    try {
      const resolved = await store.showMany(batch);
      for (const target of resolved) statuses.set(target.id, target.status);
    } catch {
      // A failed batch cannot establish completion, but unrelated work can proceed.
      diagnostics.push({ code: "blocker_lookup_failed" });
    }
    batch = [];
    bytes = 0;
  }
  for (const id of targets) {
    const size = Buffer.byteLength(id) + 1;
    if (size > 16 * 1024) {
      diagnostics.push({ code: "blocker_id_too_large" });
      continue;
    }
    if (batch.length === 100 || bytes + size > 16 * 1024) await flush();
    batch.push(id);
    bytes += size;
  }
  await flush();
  for (const issue of issues) {
    if (!canReconcile(issue) || issue.lifecycle?.waiting?.kind !== "dependency")
      continue;
    if (
      issue.dependencies.some(
        (dep) => dep.dependencyType === "blocks" && !statuses.has(dep.id),
      )
    ) {
      diagnostics.push({ taskId: issue.id, code: "blocker_unavailable" });
    }
  }
  return {
    candidates: selectDueCandidates(issues, statuses, nowMs),
    diagnostics,
  };
}
