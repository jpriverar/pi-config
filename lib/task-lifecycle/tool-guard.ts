export type TaskToolRequirement =
  | { kind: "none" }
  | { kind: "active-task" }
  | { kind: "same-task"; taskId: string }
  | { kind: "claim-task"; taskId: string };

const sameTaskTools = new Set([
  "task_attach_artifact",
  "task_wait",
  "task_close",
]);

export function classifyTaskToolRequirement(
  toolName: string,
  input: unknown,
): TaskToolRequirement {
  if (toolName === "subagent") {
    return isRecord(input) && typeof input.action === "string"
      ? { kind: "none" }
      : { kind: "active-task" };
  }
  if (
    toolName === "worktree_pool" &&
    isRecord(input) &&
    input.action === "acquire"
  ) {
    return { kind: "active-task" };
  }

  const taskId = readTaskId(input);
  if (toolName === "task_claim" && taskId !== null) {
    return { kind: "claim-task", taskId };
  }
  if (sameTaskTools.has(toolName) && taskId !== null) {
    return { kind: "same-task", taskId };
  }
  return { kind: "none" };
}

function readTaskId(input: unknown): string | null {
  if (!isRecord(input)) return null;
  return typeof input.taskId === "string" && input.taskId.length > 0
    ? input.taskId
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
