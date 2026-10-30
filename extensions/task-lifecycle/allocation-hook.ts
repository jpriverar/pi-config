import {
  ALLOCATION_HOOK_EVENT,
  type AllocationEventBus,
  type AllocationHook,
} from "../worktree-pool/allocation-hook.js";
import type { TaskLifecycleService } from "../../lib/task-lifecycle/service.js";

export type AllocationService = Pick<
  TaskLifecycleService,
  "ownedTasksForSession" | "prepareWorktreeAcquire" | "finalizeWorktreeAcquire"
>;

export function registerLifecycleAllocationHook(
  events: AllocationEventBus | undefined,
  service: AllocationService,
): void {
  if (!events?.on)
    throw new Error("lifecycle v2 requires the native allocation event bus");
  const run: AllocationHook = async (operation) => {
    const { request, owner } = operation;
    const owned = await service.ownedTasksForSession(owner.sessionId);
    if (
      owned.length !== 1 ||
      owned[0].lifecycle?.version !== 2 ||
      owned[0].lifecycle.phase !== "active"
    )
      throw new Error(
        "worktree_acquire requires one owned In-progress v2 task; revalidate ownership and explicitly resume before acquiring",
      );
    const prepared = await service.prepareWorktreeAcquire(
      { ...request, taskId: owned[0].id },
      owner,
      operation.operationId,
    );
    const acquired = await operation.allocate({
      claimId: prepared.claimId,
      pathId: prepared.pathId,
    });
    try {
      await service.finalizeWorktreeAcquire(prepared, acquired, owner);
    } catch {
      throw new Error(
        `worktree_acquire allocated claim ${acquired.claimId} at ${acquired.path}, but task ${prepared.taskId} finalization is uncertain; reconcile the task before continuing. The allocated worktree was not removed.`,
      );
    }
    return acquired;
  };
  events.on(ALLOCATION_HOOK_EVENT, (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "register" in value &&
      typeof value.register === "function"
    )
      value.register({ version: 1, run });
  });
}
