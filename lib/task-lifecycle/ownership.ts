import type { LifecycleMetadata, TaskOwner } from "./types.js";

export function ownerOf(
  lifecycle: LifecycleMetadata | null | undefined,
): TaskOwner | null {
  if (lifecycle == null) return null;
  if (lifecycle.version === 2) {
    if (lifecycle.phase === "active" && lifecycle.owner === null)
      throw new Error("active task is missing its owner");
    return lifecycle.owner;
  }
  const execution = lifecycle.execution;
  if (lifecycle.phase === "active") {
    if (execution === null)
      throw new Error("active task is missing its execution owner");
    return {
      sessionId: execution.sessionId,
      claimedAt: execution.claimedAt,
      lastActivityAt: execution.lastActivityAt,
    };
  }
  if (execution !== null)
    throw new Error("non-active v1 task has contradictory execution ownership");
  return null;
}
