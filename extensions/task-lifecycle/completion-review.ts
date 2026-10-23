import type {
  AgentBeforeSettleEvent,
  BeforeAgentStartEvent,
  BoundaryResult,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  renderTaskContext,
  type TaskContextResult,
  type TaskSession,
} from "./task-context.js";
import { resolveSessionProject } from "../../lib/session-project.js";

export const COMPLETION_REVIEW_CUE =
  "Automatic completion review — not a new user instruction or approval. Check the user's full, latest agreement against what you have actually completed. If useful, already-authorized work remains, take the next action. Otherwise finish, identify the concrete external blocker, or ask for the missing decision. Task records, plan steps, and this reminder do not expand authority. Respect user stops, denials, retry limits, and native async waiting. Do not invent extra work or repeat an unchanged closing report.";

interface ReviewContext {
  sessionManager: TaskSession;
  signal?: AbortSignal;
  hasPendingMessages?(): boolean;
  ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

export interface CompletionReviewApi {
  on(
    event: "session_start",
    handler: (event: unknown, context: ReviewContext) => void,
  ): void;
  on(
    event: "session_shutdown",
    handler: (event: unknown, context: ReviewContext) => void,
  ): void;
  on(
    event: "before_agent_start",
    handler: (event: BeforeAgentStartEvent, context: ReviewContext) => void,
  ): void;
  on(
    event: "tool_execution_end",
    handler: (event: ToolExecutionEndEvent, context: ReviewContext) => void,
  ): void;
  on(
    event: "agent_before_settle",
    handler: (
      event: AgentBeforeSettleEvent,
      context: ReviewContext,
    ) => Promise<BoundaryResult | undefined>,
  ): void;
  registerCommand?(
    name: string,
    options: {
      description: string;
      handler(args: string, context: ReviewContext): Promise<void>;
    },
  ): void;
}

export interface CompletionReviewDependencies {
  runtimeVersion: string;
  readContext(session: TaskSession): Promise<TaskContextResult>;
  isChild?(): boolean;
}

interface ReviewState {
  enabled: boolean;
  epoch: number;
  run?: { reviewed: boolean; suppressed: boolean };
}

function supportedVersion(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    [major, minor, patch].every(Number.isSafeInteger) &&
    (major > 1 || (major === 1 && minor >= 2))
  );
}

function childRuntime(): boolean {
  const child = process.env.PI_SUBAGENT_CHILD;
  const depth = process.env.PI_SUBAGENT_DEPTH;
  return Boolean((child && child !== "0") || (depth && depth !== "0"));
}

export function registerCompletionReview(
  pi: CompletionReviewApi,
  deps: CompletionReviewDependencies,
): void {
  const states = new Map<string, ReviewState>();
  const isChild = deps.isChild ?? childRuntime;
  const sessionId = (context: ReviewContext) => {
    const id = context.sessionManager.getSessionId?.();
    return typeof id === "string" && id.trim().length > 0 ? id : undefined;
  };
  function stateFor(context: ReviewContext): ReviewState | undefined {
    const id = sessionId(context);
    if (id === undefined) return undefined;
    let state = states.get(id);
    if (!state) {
      state = { enabled: false, epoch: 0 };
      states.set(id, state);
    }
    return state;
  }
  function ineligible(context: ReviewContext): string | undefined {
    if (!supportedVersion(deps.runtimeVersion))
      return "requires a recognized stable Pi runtime >= 1.2.0";
    if (isChild())
      return "parent sessions only; child runtimes cannot enable it";
    if (sessionId(context) === undefined)
      return "trusted session identity is unavailable";
    return undefined;
  }

  pi.registerCommand?.("mission-check", {
    description:
      "Operator-only, session-local completion review: on, off, or status (default off).",
    async handler(args, context) {
      const action = args.trim() || "status";
      if (!["on", "off", "status"].includes(action)) {
        context.ui?.notify("Usage: /mission-check on|off|status", "warning");
        return;
      }
      const state = stateFor(context);
      const reason = ineligible(context);
      if (action === "on" && reason) {
        context.ui?.notify(`Mission check remains off: ${reason}.`, "warning");
        return;
      }
      if (state && action !== "status") {
        state.enabled = action === "on";
        if (action === "off") state.epoch += 1;
      }
      const enabled = state?.enabled && !reason;
      context.ui?.notify(
        `Mission check: ${enabled ? "on" : "off"} (session-local; new/resumed sessions start off).${reason ? ` ${reason}.` : ""}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, context) => {
    const id = sessionId(context);
    if (id !== undefined) states.set(id, { enabled: false, epoch: 0 });
  });
  pi.on("session_shutdown", (_event, context) => {
    const id = sessionId(context);
    if (id !== undefined) states.delete(id);
  });
  pi.on("before_agent_start", (event, context) => {
    const state = stateFor(context);
    if (state)
      state.run =
        event.messageType === "user"
          ? { reviewed: false, suppressed: false }
          : undefined;
  });
  pi.on("tool_execution_end", (event, context) => {
    const run = stateFor(context)?.run;
    // Even a recovered error must not turn this review into another retry.
    if (run && (event.isError || event.result?.terminate))
      run.suppressed = true;
  });
  pi.on("agent_before_settle", async (event, context) => {
    const id = sessionId(context);
    if (id === undefined) return;
    const state = states.get(id);
    const run = state?.run;
    if (!state || !run || run.reviewed || event.outcome !== "completed") return;
    const eligible = () =>
      state.enabled &&
      !run.suppressed &&
      !ineligible(context) &&
      !context.signal?.aborted &&
      !context.hasPendingMessages?.() &&
      !event.context.pendingMessages.length &&
      !event.continue;
    if (!eligible()) return;
    const epoch = state.epoch;
    const project = resolveSessionProject(context.sessionManager);
    // Reserve before the asynchronous read so a second boundary cannot review again.
    run.reviewed = true;
    let taskContext: TaskContextResult;
    try {
      taskContext = await deps.readContext(context.sessionManager);
    } catch {
      taskContext = {
        kind: "unavailable",
        reason:
          "Owned task context is unavailable; use the latest user agreement.",
      };
    }
    const nextProject = resolveSessionProject(context.sessionManager);
    if (
      sessionId(context) !== id ||
      states.get(id) !== state ||
      state.run !== run ||
      state.epoch !== epoch ||
      nextProject.source !== project.source ||
      nextProject.workstream !== project.workstream ||
      !eligible()
    )
      return;
    const content = renderTaskContext(taskContext);
    return {
      entries: [
        ...(content === undefined
          ? []
          : [
              {
                type: "custom_message" as const,
                customType: "jp-mission-context",
                content,
                display: false,
              },
            ]),
        {
          type: "custom_message",
          customType: "jp-completion-review",
          content: COMPLETION_REVIEW_CUE,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
