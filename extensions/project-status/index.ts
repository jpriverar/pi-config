import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import {
  classifyReadiness,
  createBeadsClient,
  type ClassifiedIssue,
} from "../../lib/beads.js";
import { resolveSessionProject } from "../../lib/session-project.js";
import { createPaneReporter, type PaneReporter } from "./herdr-pane.js";
import {
  createHerdrMetadataSender,
  type MetadataSender,
} from "./herdr-transport.js";
import { selectTaskAssignment } from "./herdr-values.js";

const WIDGET_KEY = "project-status";

interface Counts {
  inProgress: number;
  blocked: number;
  ready: number;
  waiting: number;
  needsJp: number;
  closed: number;
  sessionTask?: { id: string; title: string };
}

type TaskState = Counts | "unavailable";

function primaryWorkstream(issue: ClassifiedIssue): string | undefined {
  return issue.workstreams[0];
}

function scopeIssues(
  issues: ClassifiedIssue[],
  project?: string,
): ClassifiedIssue[] {
  if (!project) return issues;
  const target = project.toLowerCase();
  return issues.filter(
    (issue) => primaryWorkstream(issue)?.toLowerCase() === target,
  );
}

export default function projectStatus(
  pi: ExtensionAPI,
  dependencies: {
    metadataSender?: MetadataSender | null;
    now?: () => number;
  } = {},
) {
  const metadataSender =
    dependencies.metadataSender === undefined
      ? createHerdrMetadataSender(process.env)
      : dependencies.metadataSender;
  const now = dependencies.now ?? Date.now;
  let reporter: PaneReporter | undefined;
  let pendingRefresh: { ctx: ExtensionContext; generation: number } | undefined;
  let refreshing: Promise<void> | undefined;
  const client = createBeadsClient(async (command, args) => {
    const result = await pi.exec(command, [...args], { timeout: 1500 });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
  let currentSessionName: string | undefined;
  let currentTaskState: TaskState = "unavailable";
  let sessionGeneration = 0;

  function isCurrentSession(generation: number): boolean {
    return generation === sessionGeneration;
  }

  async function getCounts(
    project: string | undefined,
    sessionId: string,
    generation: number,
  ): Promise<TaskState | undefined> {
    const listed = await client.listIssues();
    if (!isCurrentSession(generation)) return undefined;
    reporter?.updateTask(
      selectTaskAssignment(
        listed.ok ? listed.value : undefined,
        sessionId,
        now(),
      ),
    );
    if (!listed.ok) return "unavailable";

    const ready = await client.listReadyIssueIds();
    if (!isCurrentSession(generation)) return undefined;
    if (!ready.ok) return "unavailable";

    const closed = await client.listIssues(["closed"]);
    if (!isCurrentSession(generation)) return undefined;
    if (!closed.ok) return "unavailable";

    const sessionTasks = listed.value.filter(
      (issue) =>
        issue.lifecycle?.phase === "active" &&
        issue.lifecycle.execution?.sessionId === sessionId,
    );
    const sessionTask =
      sessionTasks.length === 1
        ? { id: sessionTasks[0].id, title: sessionTasks[0].title }
        : undefined;
    const active = scopeIssues(
      classifyReadiness(listed.value, ready.value),
      project,
    );
    const historical = scopeIssues(
      classifyReadiness(closed.value, new Set()),
      project,
    );

    return {
      inProgress: active.filter((issue) => issue.readiness === "in_progress")
        .length,
      blocked: active.filter((issue) => issue.readiness === "blocked").length,
      ready: active.filter((issue) => issue.readiness === "ready").length,
      waiting: active.filter((issue) => issue.readiness === "waiting").length,
      needsJp: active.filter((issue) => issue.needsJp).length,
      closed: historical.length,
      ...(sessionTask === undefined ? {} : { sessionTask }),
    };
  }

  function renderStatus(
    ctx: ExtensionContext,
    project: string | undefined,
    taskState: TaskState,
  ): void {
    const theme = ctx.ui.theme;
    const leftParts: string[] = [];
    if (project) leftParts.push(theme.fg("accent", project));

    if (taskState === "unavailable") {
      leftParts.push(theme.fg("muted", "tasks unavailable"));
    } else if (taskState.sessionTask) {
      leftParts.push(
        theme.fg("warning", taskState.sessionTask.id) +
          theme.fg("dim", " • ") +
          theme.fg("dim", taskState.sessionTask.title),
      );
    } else {
      const segments: string[] = [];
      if (taskState.inProgress > 0) {
        segments.push(
          theme.fg("warning", `${taskState.inProgress} in-progress`),
        );
      }
      if (taskState.blocked > 0) {
        segments.push(theme.fg("error", `${taskState.blocked} blocked`));
      }
      if (taskState.needsJp > 0) {
        segments.push(theme.fg("warning", `${taskState.needsJp} needs you`));
      }
      if (taskState.ready > 0) {
        segments.push(theme.fg("dim", `${taskState.ready} ready`));
      }
      if (taskState.waiting > 0) {
        segments.push(theme.fg("muted", `${taskState.waiting} waiting`));
      }
      if (taskState.closed > 0) {
        segments.push(theme.fg("success", `${taskState.closed} closed`));
      }
      if (segments.length > 0) {
        leftParts.push(segments.join(theme.fg("dim", " • ")));
      }
    }
    const left = leftParts.join(theme.fg("dim", " │ "));

    if (!left) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, () => ({
      render(width: number) {
        if (width <= 0) return [""];
        return [truncateToWidth(left, width, "…", true)];
      },
      invalidate() {},
    }));
  }

  async function refreshOnce(
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    const sessionName = pi.getSessionName() ?? undefined;
    const project = resolveSessionProject(ctx.sessionManager).workstream;
    const taskState = await getCounts(
      project,
      ctx.sessionManager.getSessionId(),
      generation,
    );
    if (taskState === undefined || !isCurrentSession(generation)) return;

    currentSessionName = sessionName;
    currentTaskState = taskState;
    renderStatus(ctx, currentSessionName, currentTaskState);
  }

  function refresh(ctx: ExtensionContext, generation: number): Promise<void> {
    if (!isCurrentSession(generation)) return Promise.resolve();
    pendingRefresh = { ctx, generation };
    if (!refreshing) {
      refreshing = (async () => {
        while (pendingRefresh) {
          const next = pendingRefresh;
          pendingRefresh = undefined;
          if (!isCurrentSession(next.generation)) continue;
          try {
            await refreshOnce(next.ctx, next.generation);
          } catch {
            if (!isCurrentSession(next.generation)) continue;
            reporter?.updateTask({ label: "Task unavailable" });
            currentTaskState = "unavailable";
            renderStatus(next.ctx, currentSessionName, currentTaskState);
          }
        }
      })().finally(() => {
        refreshing = undefined;
      });
    }
    return refreshing;
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;
    const previous = reporter;
    reporter = undefined;
    await previous?.stop();
    if (!isCurrentSession(generation)) return;
    if (metadataSender) {
      reporter = createPaneReporter({
        context: ctx,
        send: metadataSender,
        now,
        refreshTask: () => refresh(ctx, generation),
      });
    }
    await refresh(ctx, generation);
  });
  pi.on("session_shutdown", async () => {
    sessionGeneration += 1;
    pendingRefresh = undefined;
    const previous = reporter;
    reporter = undefined;
    await previous?.stop();
  });
  const refreshSession = (_event: unknown, ctx: ExtensionContext) => {
    reporter?.updateRuntime(ctx);
    return refresh(ctx, sessionGeneration);
  };
  pi.on("session_info_changed", refreshSession);
  pi.on("turn_end", refreshSession);
  pi.on("before_agent_start", (_event, ctx) => {
    // Optional display reads must not become a prompt-start prerequisite.
    void refreshSession(_event, ctx);
  });
  const refreshRuntime = (_event: unknown, ctx: ExtensionContext) =>
    reporter?.updateRuntime(ctx);
  pi.on("model_select", refreshRuntime);
  pi.on("session_compact", refreshRuntime);
  pi.on("session_tree", refreshRuntime);
  pi.on("turn_start", refreshRuntime);
  const taskChanges = new Set([
    "task_claim",
    "task_wait",
    "task_defer",
    "task_close",
    "task_reopen",
    "task_reconcile",
  ]);
  pi.on("tool_execution_end", (event, ctx) => {
    if (taskChanges.has(event.toolName)) return refresh(ctx, sessionGeneration);
  });
}
