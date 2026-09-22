import { hostname } from "node:os";

import type {
  ArtifactInput,
  LifecycleIssue,
  LockOwner,
} from "../../lib/task-lifecycle/types.js";
import type {
  GitArtifactCommandClassifier,
  GitArtifactObservationIntent,
} from "./git-artifact-command.js";
import type { GitArtifactObserver } from "./git-artifact-observer.js";

export interface GitArtifactHookService {
  activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]>;
  recordObservedArtifacts(
    taskId: string,
    artifacts: readonly ArtifactInput[],
    owner: LockOwner,
    operationId: string,
  ): Promise<LifecycleIssue>;
}

export interface GitArtifactHookContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui?: { notify(message: string, level: "warning"): void };
}

interface GitArtifactHookApi {
  on(
    event: "tool_call" | "tool_result",
    handler: (event: any, context: GitArtifactHookContext) => unknown,
  ): void;
}

interface PendingGitArtifactObservation {
  taskId: string;
  owner: LockOwner;
  intents: readonly GitArtifactObservationIntent[];
  operationId: string;
}

const SKIPPED_WARNING =
  "Git artifact observation skipped; use task_attach_artifact if needed.";
const FAILED_WARNING =
  "Git artifact observation failed; use task_attach_artifact if needed.";

export function registerGitArtifactHooks(
  pi: GitArtifactHookApi,
  deps: {
    service: GitArtifactHookService;
    classifier: GitArtifactCommandClassifier;
    observer: GitArtifactObserver;
  },
): void {
  const pending = new Map<string, PendingGitArtifactObservation>();

  pi.on("tool_call", async (event, context) => {
    if (
      event?.toolName !== "bash" ||
      typeof event?.toolCallId !== "string" ||
      !isRecord(event.input) ||
      typeof event.input.command !== "string"
    ) {
      return undefined;
    }

    let intents: GitArtifactObservationIntent[];
    try {
      intents = deps.classifier.classify(event.input.command, context.cwd);
    } catch {
      notify(context, FAILED_WARNING);
      return undefined;
    }
    if (intents.length === 0) return undefined;

    const sessionId = context.sessionManager.getSessionId();
    let activeTasks: LifecycleIssue[];
    try {
      activeTasks = await deps.service.activeTasksForSession(sessionId);
    } catch {
      notify(context, SKIPPED_WARNING);
      return undefined;
    }
    if (activeTasks.length === 0) return undefined;
    if (activeTasks.length !== 1) {
      notify(context, SKIPPED_WARNING);
      return undefined;
    }

    pending.set(event.toolCallId, {
      taskId: activeTasks[0].id,
      owner: {
        pid: process.pid,
        sessionId,
        host: hostname(),
        started: Date.now(),
      },
      intents: intents.map((intent) => ({ ...intent })),
      operationId: `git-artifacts:${event.toolCallId}`,
    });
    return undefined;
  });

  pi.on("tool_result", async (event, context) => {
    if (typeof event?.toolCallId !== "string") return undefined;
    const observation = pending.get(event.toolCallId);
    if (observation === undefined) return undefined;
    pending.delete(event.toolCallId);
    if (event.toolName !== "bash" || event.isError === true) return undefined;

    try {
      const artifacts = await deps.observer.observe(observation.intents);
      if (artifacts.length !== 0) {
        await deps.service.recordObservedArtifacts(
          observation.taskId,
          artifacts,
          observation.owner,
          observation.operationId,
        );
      }
    } catch {
      notify(context, FAILED_WARNING);
    }
    return undefined;
  });
}

function notify(context: GitArtifactHookContext, message: string): void {
  try {
    context.ui?.notify(message, "warning");
  } catch {
    // Artifact bookkeeping must never alter tool execution.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
