import type {
  ExtensionAPI,
  ExtensionContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  classifyReadiness,
  createBeadsClient,
  type ClassifiedIssue,
} from "../../lib/beads.js";

const WIDGET_KEY = "project-status";

interface Counts {
  inProgress: number;
  blocked: number;
  ready: number;
  waiting: number;
  needsJp: number;
  closed: number;
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

export default function projectStatus(pi: ExtensionAPI) {
  const client = createBeadsClient(async (command, args) => {
    const result = await pi.exec(command, [...args]);
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
  let currentProject: string | undefined;
  let currentTaskState: TaskState = "unavailable";

  async function getCounts(project?: string): Promise<TaskState> {
    const listed = await client.listIssues();
    if (!listed.ok) return "unavailable";

    const ready = await client.listReadyIssueIds();
    if (!ready.ok) return "unavailable";

    const closed = await client.listIssues(["closed"]);
    if (!closed.ok) return "unavailable";

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

    const model = ctx.model?.name || ctx.model?.id || "";
    let modelShort = model.startsWith("Claude ") ? model.slice(7) : model;
    modelShort = modelShort.replace(/\s*\(AI Gateway.*\)/, "");
    const thinking = pi.getThinkingLevel();
    const rightParts: string[] = [];
    if (modelShort) rightParts.push(theme.fg("dim", modelShort));
    if (thinking && thinking !== "off") {
      rightParts.push(theme.fg("dim", thinking));
    }

    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
    const percent =
      usage?.percent ??
      (usage?.tokens != null && contextWindow
        ? (usage.tokens / contextWindow) * 100
        : null);
    if (percent !== null && percent !== undefined) {
      const rounded = Math.round(percent);
      const color: ThemeColor =
        rounded > 90 ? "error" : rounded > 70 ? "warning" : "dim";
      rightParts.push(theme.fg(color, `${rounded}%`));
    }
    const right = rightParts.join(theme.fg("dim", " • "));

    if (!left && !right) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, () => ({
      render(width: number) {
        const gap = Math.max(
          2,
          width - visibleWidth(left) - visibleWidth(right),
        );
        return [left + " ".repeat(gap) + right];
      },
      invalidate() {},
    }));
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    currentProject = pi.getSessionName() ?? undefined;
    currentTaskState = await getCounts(currentProject);
    renderStatus(ctx, currentProject, currentTaskState);
  }

  function refreshIdentity(ctx: ExtensionContext): void {
    renderStatus(ctx, currentProject, currentTaskState);
  }

  pi.on("session_start", async (_event, ctx) => refresh(ctx));
  pi.on("session_info_changed", async (_event, ctx) => refresh(ctx));
  pi.on("model_select", async (_event, ctx) => refreshIdentity(ctx));
  pi.on("thinking_level_select", async (_event, ctx) => refreshIdentity(ctx));
  pi.on("turn_end", async (_event, ctx) => refresh(ctx));
}
