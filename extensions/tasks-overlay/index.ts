import { hostname } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  createBeadsClient,
  resolveBeadsDir,
  withBeadsEnvironment,
  listClassifiedIssues,
  type ClassifiedIssue,
} from "../../lib/beads.js";
import {
  hasCatalogSessionScope,
  persistSessionWorkScope,
  resolveSessionSelection,
  sessionScopeFingerprint,
  latestSessionScopeEntry,
  SESSION_PROJECT_ENTRY_TYPE,
  type SessionWorkSelection,
  resolveSessionProject,
  type SessionProjectWriter,
} from "../../lib/session-project.js";
import { ALL_PROJECT_ISSUE_STATUSES as ALL_ISSUE_STATUSES } from "../../lib/project-management.js";
import { renderTaskTable } from "../shared/task-table.js";

import {
  createCatalogStore,
  type CatalogStore,
} from "../../lib/work-catalog/store.js";
import { createCatalogService } from "../../lib/work-catalog/service.js";
import { workSelectionLabel } from "../../lib/work-catalog/membership.js";
import { presentWorkIssues } from "../../lib/work-catalog/presentation.js";
import { registerProjectCommands, selectWorkEntity } from "./projects.js";
import { createLegacyProjectCommands } from "./legacy-projects.js";

export default function tasksOverlay(
  pi: ExtensionAPI,
  deps: { catalog?: CatalogStore } = {},
) {
  const projectWriter = {
    appendCustomEntry(customType: string, data: unknown): unknown {
      pi.appendEntry(customType, data);
      return undefined;
    },
  } satisfies SessionProjectWriter;
  const client = createBeadsClient(
    withBeadsEnvironment((command, args) => pi.exec(command, [...args])),
  );

  const legacy = createLegacyProjectCommands(
    client,
    projectWriter,
    selectWorkEntity,
  );
  const catalog = deps.catalog ?? createCatalogStore(client);
  const catalogService = createCatalogService({
    client,
    store: catalog,
    storePath: resolveBeadsDir(),
  });

  async function showOverlay(ctx: ExtensionContext): Promise<void> {
    const fingerprint = sessionScopeFingerprint(ctx.sessionManager);
    let selection: SessionWorkSelection;
    let issues: ClassifiedIssue[];
    try {
      selection = resolveSessionSelection(
        ctx.sessionManager,
        await catalog.read(),
      );
      const listed = await listClassifiedIssues(client);
      if (!listed.ok) throw new Error("Tasks unavailable");
      if (fingerprint !== sessionScopeFingerprint(ctx.sessionManager)) return;
      issues = presentWorkIssues(selection, listed.value);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Tasks unavailable",
        "warning",
      );
      return;
    }
    const project = workSelectionLabel(selection);
    if (issues.length === 0) {
      ctx.ui.notify(
        project ? `No open tasks for ${project}` : "No open tasks",
        "info",
      );
      return;
    }

    const title = project ? `Tasks — ${project}` : "Tasks";

    await ctx.ui.custom(
      (tui, theme, _kb, done) => {
        const table = renderTaskTable(issues, theme, undefined, {
          showProject:
            selection.kind === "catalog" && selection.scope.kind !== "project",
        });
        const header = table.lines.slice(0, table.headerLines);
        const rows = table.lines.slice(table.headerLines);
        let verticalOffset = 0;
        let horizontalOffset = 0;
        let bodyViewport = 1;
        let maxVerticalOffset = 0;
        let maxHorizontalOffset = 0;
        const terminalRows = process.stdout.rows || 40;
        const maxOverlayRows = Math.max(
          table.headerLines + 3,
          Math.floor(terminalRows * 0.85),
        );
        const maxBodyViewport = Math.max(
          1,
          maxOverlayRows - table.headerLines - 2,
        );

        return {
          render(width: number) {
            const innerWidth = Math.max(1, width - 4);
            bodyViewport = Math.min(rows.length, maxBodyViewport);
            maxVerticalOffset = Math.max(0, rows.length - bodyViewport);
            maxHorizontalOffset = Math.max(0, table.width - innerWidth);
            verticalOffset = Math.min(verticalOffset, maxVerticalOffset);
            horizontalOffset = Math.min(horizontalOffset, maxHorizontalOffset);
            const visible = [
              ...header,
              ...rows.slice(verticalOffset, verticalOffset + bodyViewport),
            ];
            const side = theme.fg("border", "│");
            const body = visible.map((line) => {
              const sliced = sliceByColumn(
                line,
                horizontalOffset,
                innerWidth,
                true,
              );
              const padding = Math.max(0, innerWidth - visibleWidth(sliced));
              return `${side} ${sliced}${" ".repeat(padding)} ${side}`;
            });
            const rowEnd = Math.min(verticalOffset + bodyViewport, rows.length);
            const scrollInfo = ` [rows ${rows.length === 0 ? 0 : verticalOffset + 1}-${rowEnd}/${rows.length} • cols ${horizontalOffset + 1}-${Math.min(horizontalOffset + innerWidth, table.width)}/${table.width}]`;
            const helpText = `↑↓←→ scroll • pgup/pgdn • home/end • esc close${scrollInfo}`;
            const topFill = Math.max(0, width - 5 - visibleWidth(title));
            const visibleHelp = truncateToWidth(
              helpText,
              Math.max(1, width - 5),
            );
            const bottomFill = Math.max(
              0,
              width - 5 - visibleWidth(visibleHelp),
            );
            const topLine = `${theme.fg("border", "┌─")} ${theme.fg("accent", theme.bold(title))} ${theme.fg("border", "─".repeat(topFill) + "┐")}`;
            const bottomLine = `${theme.fg("border", "└─")} ${theme.fg("dim", visibleHelp)} ${theme.fg("border", "─".repeat(bottomFill) + "┘")}`;
            return [topLine, ...body, bottomLine];
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
              done(null);
            } else if (matchesKey(data, Key.up)) {
              verticalOffset = Math.max(0, verticalOffset - 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.down)) {
              verticalOffset = Math.min(maxVerticalOffset, verticalOffset + 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.left)) {
              horizontalOffset = Math.max(0, horizontalOffset - 4);
              tui.requestRender();
            } else if (matchesKey(data, Key.right)) {
              horizontalOffset = Math.min(
                maxHorizontalOffset,
                horizontalOffset + 4,
              );
              tui.requestRender();
            } else if (matchesKey(data, Key.pageUp)) {
              verticalOffset = Math.max(0, verticalOffset - bodyViewport);
              tui.requestRender();
            } else if (matchesKey(data, Key.pageDown)) {
              verticalOffset = Math.min(
                maxVerticalOffset,
                verticalOffset + bodyViewport,
              );
              tui.requestRender();
            } else if (matchesKey(data, Key.home)) {
              verticalOffset = 0;
              tui.requestRender();
            } else if (matchesKey(data, Key.end)) {
              verticalOffset = maxVerticalOffset;
              tui.requestRender();
            }
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" },
      },
    );
  }

  pi.registerCommand("tasks", {
    description: "Show project task list as an overlay",
    handler: async (_args, ctx) => showOverlay(ctx),
  });

  registerProjectCommands(pi, {
    catalog,
    service: catalogService,
    issues: async () => {
      const result = await client.listIssues(ALL_ISSUE_STATUSES);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    owner: (ctx) => ({
      pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      host: hostname(),
      started: Date.now(),
    }),
    select: (scope, _current, ctx) => {
      persistSessionWorkScope(projectWriter, scope);
      pi.events.emit(
        "pi:work-scope-changed",
        ctx.sessionManager.getSessionId(),
      );
    },
    choose: selectWorkEntity,
    legacy: legacy.handle,
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Show project task list",
    handler: async (ctx) => showOverlay(ctx),
  });

  let pendingForkScope: { data: unknown } | undefined;
  pi.on("session_before_fork", (_event, ctx) => {
    if (hasCatalogSessionScope(ctx.sessionManager)) {
      pendingForkScope = undefined;
      return;
    }
    const entry = latestSessionScopeEntry(ctx.sessionManager);
    const legacy = resolveSessionProject(ctx.sessionManager);
    pendingForkScope = entry
      ? { data: structuredClone(entry.data) }
      : legacy.workstream
        ? { data: { version: 1, workstream: legacy.workstream } }
        : undefined;
  });
  pi.on("session_start", async (event, ctx) => {
    const pending = pendingForkScope;
    pendingForkScope = undefined;
    if (event.reason === "fork" && pending) {
      const current = latestSessionScopeEntry(ctx.sessionManager);
      if (
        !current ||
        JSON.stringify(current.data) !== JSON.stringify(pending.data)
      )
        projectWriter.appendCustomEntry(
          SESSION_PROJECT_ENTRY_TYPE,
          pending.data,
        );
    }
    if (event.reason === "new") return;
    try {
      const current = await catalog.read();
      if (current?.state === "active") return;
      resolveSessionSelection(ctx.sessionManager, current);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Work scope unavailable",
        "warning",
      );
      return;
    }

    await legacy.resume(event.reason, ctx);
  });
}
