export type TaskToolRequirement =
  | { kind: "none" }
  | { kind: "active-task" }
  | { kind: "same-task"; taskId: string }
  | { kind: "owned-task"; taskId: string }
  | { kind: "claim-task"; taskId: string };

const sameTaskTools = new Set([
  "task_attach_artifact",
  "task_wait",
  "task_log",
  "task_defer",
  "task_close",
]);

export function classifyTaskToolRequirement(
  toolName: string,
  input: unknown,
  lifecycleWriteVersion: 1 | 2 = 1,
): TaskToolRequirement {
  if (toolName === "subagent") {
    if (
      lifecycleWriteVersion === 2 &&
      isRecord(input) &&
      (input.action === "resume" ||
        input.action === "steer" ||
        (input.action === "project.open" &&
          typeof input.message === "string" &&
          input.message.trim().length > 0))
    )
      return { kind: "active-task" };
    return isRecord(input) && typeof input.action === "string"
      ? { kind: "none" }
      : { kind: "active-task" };
  }
  if (toolName === "worktree_acquire") {
    return { kind: "active-task" };
  }

  const taskId = readTaskId(input);
  if (
    lifecycleWriteVersion === 2 &&
    taskId !== null &&
    ([
      "task_block",
      "task_resume",
      "task_release",
      "task_close",
      "task_defer",
    ].includes(toolName) ||
      (toolName === "task_update" &&
        isRecord(input) &&
        input.condition !== undefined))
  )
    return { kind: "owned-task", taskId };
  if (toolName === "task_claim" && taskId !== null) {
    return { kind: "claim-task", taskId };
  }
  if (
    toolName === "task_update" &&
    taskId !== null &&
    isRecord(input) &&
    (input.description !== undefined || input.next_step !== undefined)
  ) {
    return { kind: "same-task", taskId };
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
