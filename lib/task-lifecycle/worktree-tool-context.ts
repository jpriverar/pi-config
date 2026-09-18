export const WORKTREE_LIFECYCLE_CONTEXT_KEY = "__piTaskLifecycle";

export type WorktreeLifecycleContext =
  | {
      version: 1;
      mode: "acquire";
      taskId: string;
      operationId: string;
      claimId: string;
      pathId: string;
      repository: string;
    }
  | {
      version: 1;
      mode: "release";
      taskId: string;
      operationId: string;
      claimId: string;
      repository: string;
    };

export function readWorktreeLifecycleContext(
  input: unknown,
): WorktreeLifecycleContext | null {
  if (!isRecord(input) || !(WORKTREE_LIFECYCLE_CONTEXT_KEY in input)) {
    return null;
  }
  const value = input[WORKTREE_LIFECYCLE_CONTEXT_KEY];
  if (!isRecord(value)) invalid("must be an object");
  if (value.version !== 1) invalid("version must be 1");
  if (value.mode !== "acquire" && value.mode !== "release") {
    invalid("mode must be acquire or release");
  }
  requireText(value.taskId, "taskId");
  requireText(value.operationId, "operationId");
  requireText(value.claimId, "claimId");
  requireText(value.repository, "repository");

  const allowed = new Set([
    "version",
    "mode",
    "taskId",
    "operationId",
    "claimId",
    "repository",
    ...(value.mode === "acquire" ? ["pathId"] : []),
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`unknown field ${key}`);
  }
  if (value.mode === "acquire") requireText(value.pathId, "pathId");

  return value as WorktreeLifecycleContext;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${field} must be a non-empty string`);
  }
}

function invalid(reason: string): never {
  throw new Error(`invalid worktree lifecycle context: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
