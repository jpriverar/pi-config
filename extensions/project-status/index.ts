import { ALL_PROJECT_ISSUE_STATUSES } from "../../lib/project-management.js";
import { lifecycleStatusLabel } from "../../lib/task-lifecycle/presentation.js";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import {
  classifyReadiness,
  isClaimableIssue,
  isOwnedReadyIssue,
  createBeadsClient,
  withBeadsEnvironment,
  type BeadsIssue,
} from "../../lib/beads.js";
import {
  resolveSessionSelection,
  sessionScopeFingerprint,
  hasCatalogSessionScope,
  type SessionWorkSelection,
} from "../../lib/session-project.js";
import { selectWorkIssues } from "../../lib/work-catalog/membership.js";
import {
  resolveOwnedTask,
  resolveWorkingIdentity,
} from "../../lib/session-identity.js";
import { createCatalogStore } from "../../lib/work-catalog/store.js";
import type { WorkCatalog } from "../../lib/work-catalog/model.js";
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
  ownedReady: number;
  waiting: number;
  needsJp: number;
  closed: number;
}

type TaskState =
  | Counts
  | {
      sessionTask: {
        id: string;
        title: string;
        status?: string;
        outsideView?: boolean;
        workstream?: string;
      };
    }
  | "unavailable";

function browseLabel(selection: SessionWorkSelection): string | undefined {
  if (selection.kind === "legacy") return selection.project;
  const { catalog, scope } = selection;
  if (scope.kind === "global") return undefined;
  return scope.kind === "area"
    ? `${catalog.areas[scope.areaId].name} (area)`
    : catalog.projects[scope.projectId].name;
}

export default function projectStatus(
  pi: ExtensionAPI,
  dependencies: {
    metadataSender?: MetadataSender | null;
    readCatalog?: () => Promise<WorkCatalog | null>;
  } = {},
) {
  const metadataSender =
    dependencies.metadataSender === undefined
      ? createHerdrMetadataSender(process.env)
      : dependencies.metadataSender;
  let reporter: PaneReporter | undefined;
  let pendingRefresh: { ctx: ExtensionContext; generation: number } | undefined;
  let refreshing: Promise<void> | undefined;
  const client = createBeadsClient(
    withBeadsEnvironment((command, args) =>
      pi.exec(command, [...args], { timeout: 1500 }),
    ),
  );
  const readCatalog =
    dependencies.readCatalog ?? (() => createCatalogStore(client).read());
  let currentSessionName: string | undefined;
  let currentTaskState: TaskState = "unavailable";
  let sessionGeneration = 0;
  let usesCatalog = false;
  let currentContext: ExtensionContext | undefined;

  function isCurrentSession(generation: number): boolean {
    return generation === sessionGeneration;
  }

  async function getCounts(
    issues: readonly BeadsIssue[],
    selection: SessionWorkSelection,
    sessionId: string,
    current: () => boolean,
  ): Promise<TaskState | undefined> {
    const selected = resolveOwnedTask(issues, sessionId);
    if (selected.kind === "unavailable" || selected.kind === "ambiguous")
      return "unavailable";
    if (selected.kind === "owned") {
      const issue = selected.issue;
      return {
        sessionTask: {
          id: issue.id,
          title: issue.title,
          status:
            issue.lifecycle?.version === 2
              ? (lifecycleStatusLabel(issue.lifecycle.phase, true) ?? undefined)
              : undefined,
          workstream:
            selection.kind === "legacy"
              ? classifyReadiness([issue], new Set())[0].workstreams[0]
              : undefined,
          outsideView:
            selection.kind === "catalog" &&
            selectWorkIssues(selection, [issue]).length === 0,
        },
      };
    }

    const ready = await client.listReadyIssueIds();
    if (!current()) return undefined;
    if (!ready.ok) return "unavailable";

    const active = selectWorkIssues(
      selection,
      classifyReadiness(
        issues.filter(
          (issue) => issue.status !== "closed" && issue.status !== "deferred",
        ),
        ready.value,
      ),
    );
    const historical = selectWorkIssues(
      selection,
      classifyReadiness(
        issues.filter((issue) => issue.status === "closed"),
        new Set(),
      ),
    );

    return {
      inProgress: active.filter((issue) => issue.readiness === "in_progress")
        .length,
      blocked: active.filter((issue) => issue.readiness === "blocked").length,
      ready: active.filter(isClaimableIssue).length,
      ownedReady: active.filter(isOwnedReadyIssue).length,
      waiting: active.filter((issue) => issue.readiness === "waiting").length,
      needsJp: active.filter((issue) => issue.needsJp).length,
      closed: historical.length,
    };
  }

  function renderStatus(
    ctx: ExtensionContext,
    sessionName: string | undefined,
    taskState: TaskState,
    workContext: string | undefined,
    browse?: string,
  ): void {
    const theme = ctx.ui.theme;
    const leftParts: string[] = [];
    const identity: string[] = [];
    if (sessionName) identity.push(theme.fg("accent", sessionName));
    if (workContext) identity.push(theme.fg("muted", workContext));
    if (identity.length) leftParts.push(identity.join(theme.fg("dim", " • ")));

    if (taskState === "unavailable") {
      leftParts.push(theme.fg("muted", "tasks unavailable"));
    } else if ("sessionTask" in taskState) {
      leftParts.push(
        theme.fg("warning", taskState.sessionTask.id) +
          theme.fg("dim", " • ") +
          (taskState.sessionTask.status
            ? theme.fg("muted", `${taskState.sessionTask.status} • `)
            : "") +
          theme.fg("dim", taskState.sessionTask.title) +
          (taskState.sessionTask.outsideView
            ? theme.fg("muted", " (outside current view)")
            : ""),
      );
    } else {
      const segments: string[] = [];
      if (browse) segments.push(theme.fg("muted", `Browse: ${browse}`));
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
      if (taskState.ownedReady > 0)
        segments.push(theme.fg("dim", `${taskState.ownedReady} owned ready`));
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
    currentSessionName = sessionName;
    const fingerprint = sessionScopeFingerprint(ctx.sessionManager);
    const sessionId = ctx.sessionManager.getSessionId();
    const current = () =>
      isCurrentSession(generation) &&
      sessionId === ctx.sessionManager.getSessionId() &&
      fingerprint === sessionScopeFingerprint(ctx.sessionManager);
    const catalog = await readCatalog();
    if (!current()) return;
    usesCatalog =
      catalog?.state === "active" || hasCatalogSessionScope(ctx.sessionManager);
    const legacySelection =
      catalog?.state === "active"
        ? undefined
        : resolveSessionSelection(ctx.sessionManager, catalog);
    const listed = await client.listIssues(ALL_PROJECT_ISSUE_STATUSES);
    if (!current()) return;
    const identity =
      catalog?.state === "active"
        ? listed.ok
          ? resolveWorkingIdentity(listed.value, catalog, sessionId)
          : { kind: "unavailable" as const, reason: "Task lookup failed" }
        : undefined;
    const assignment = selectTaskAssignment(
      !listed.ok || identity?.kind === "unavailable"
        ? undefined
        : identity?.kind === "unassigned"
          ? []
          : listed.value,
      sessionId,
    );
    if (
      assignment.state === "assigned" &&
      identity?.kind === "assigned" &&
      identity.taskId === assignment.taskId
    ) {
      assignment.project = identity.projectName;
      assignment.area = identity.areaName;
    }
    reporter?.updateTask(assignment, currentSessionName);
    const workContext =
      identity?.kind === "assigned"
        ? `${identity.projectName} • ${identity.areaName}`
        : identity?.kind === "unavailable"
          ? "identity unavailable"
          : undefined;
    if (!listed.ok || identity?.kind === "unavailable") {
      currentTaskState = "unavailable";
      renderStatus(ctx, currentSessionName, currentTaskState, workContext);
      return;
    }
    let selection: SessionWorkSelection;
    try {
      selection =
        legacySelection ?? resolveSessionSelection(ctx.sessionManager, catalog);
    } catch {
      currentTaskState = "unavailable";
      renderStatus(ctx, currentSessionName, currentTaskState, workContext);
      return;
    }
    const taskState = await getCounts(
      listed.value,
      selection,
      sessionId,
      current,
    );
    if (taskState === undefined || !current()) return;
    currentTaskState = taskState;
    renderStatus(
      ctx,
      currentSessionName,
      currentTaskState,
      workContext ??
        (typeof taskState === "object" && "sessionTask" in taskState
          ? taskState.sessionTask.workstream
          : undefined),
      browseLabel(selection),
    );
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
            reporter?.updateTask({
              state: "unavailable",
              label: "Task unavailable",
            });
            currentTaskState = "unavailable";
            renderStatus(
              next.ctx,
              currentSessionName,
              currentTaskState,
              usesCatalog ? "identity unavailable" : undefined,
            );
          }
        }
      })().finally(() => {
        refreshing = undefined;
      });
    }
    return refreshing;
  }

  pi.events.on("pi:work-scope-changed", (sessionId: unknown) => {
    const context = currentContext;
    if (context && sessionId === context.sessionManager.getSessionId())
      void refresh(context, sessionGeneration);
  });

  pi.events.on("pi:wakeup-waiting", (label: unknown) => {
    if (label === null || typeof label === "string")
      reporter?.updateWaiting(label);
  });

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;
    currentContext = ctx;
    usesCatalog = false;
    const previous = reporter;
    reporter = undefined;
    await previous?.stop();
    if (!isCurrentSession(generation)) return;
    if (metadataSender) {
      reporter = createPaneReporter({
        context: ctx,
        send: metadataSender,
      });
    }
    await refresh(ctx, generation);
  });
  pi.on("session_shutdown", async () => {
    sessionGeneration += 1;
    currentContext = undefined;
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
    "task_block",
    "task_resume",
    "task_release",
    "task_defer",
    "task_close",
    "task_reopen",
    "task_reconcile",
    "work_catalog",
  ]);
  pi.on("tool_execution_end", (event, ctx) => {
    if (taskChanges.has(event.toolName)) return refresh(ctx, sessionGeneration);
  });
}
