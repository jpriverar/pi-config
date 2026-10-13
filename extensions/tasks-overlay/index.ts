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
  withBeadsEnvironment,
  listClassifiedIssues,
  type ClassifiedIssue,
  type IssueStatus,
  type Readiness,
} from "../../lib/beads.js";
import { resolveProjectRename } from "../../lib/project-renames.js";
import {
  generateSessionProjectName,
  persistSessionProject,
  resolveSessionProject,
  type SessionProjectWriter,
} from "../../lib/session-project.js";
import {
  ALL_PROJECT_ISSUE_STATUSES as ALL_ISSUE_STATUSES,
  collectProjects,
  createProjectManager,
  isProjectHidden,
  type Project,
} from "../../lib/project-management.js";
import { renderTaskTable } from "../shared/task-table.js";

const PROJECT_PICKER_VISIBLE_ITEMS = 8;

function primaryWorkstream(issue: ClassifiedIssue): string | undefined {
  return issue.workstreams[0];
}

async function selectProject(
  ctx: ExtensionContext,
  title: string,
  items: string[],
): Promise<string | undefined> {
  if (ctx.mode !== "tui" || items.length <= PROJECT_PICKER_VISIBLE_ITEMS) {
    return ctx.ui.select(title, items);
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let selectedIndex = 0;
    const visibleCount = Math.min(PROJECT_PICKER_VISIBLE_ITEMS, items.length);

    return {
      render(width: number) {
        const contentWidth = Math.max(1, width - 2);
        const startIndex = Math.max(
          0,
          Math.min(
            selectedIndex - Math.floor(visibleCount / 2),
            items.length - visibleCount,
          ),
        );
        const endIndex = Math.min(startIndex + visibleCount, items.length);
        const lines = [
          theme.fg(
            "accent",
            theme.bold(truncateToWidth(title, Math.max(1, width))),
          ),
        ];

        for (let index = startIndex; index < endIndex; index++) {
          const item = truncateToWidth(items[index], contentWidth);
          lines.push(
            index === selectedIndex
              ? theme.fg("accent", `→ ${item}`)
              : `  ${theme.fg("text", item)}`,
          );
        }

        const position =
          items.length > visibleCount
            ? ` • ${selectedIndex + 1}/${items.length}`
            : "";
        lines.push(
          theme.fg(
            "dim",
            truncateToWidth(
              `↑↓ navigate • enter select • esc cancel${position}`,
              Math.max(1, width),
            ),
          ),
        );
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up") || data === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          tui.requestRender();
        } else if (
          keybindings.matches(data, "tui.select.down") ||
          data === "j"
        ) {
          selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
          tui.requestRender();
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done(items[selectedIndex]);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        }
      },
    };
  });
}

export default function tasksOverlay(pi: ExtensionAPI) {
  const projectWriter = {
    appendCustomEntry(customType: string, data: unknown): unknown {
      pi.appendEntry(customType, data);
      return undefined;
    },
  } satisfies SessionProjectWriter;
  const client = createBeadsClient(
    withBeadsEnvironment((command, args) => pi.exec(command, [...args])),
  );

  const projectsManager = createProjectManager(client);

  async function getIssues(
    project?: string,
    statuses?: readonly IssueStatus[],
  ): Promise<ClassifiedIssue[] | undefined> {
    const listed = await listClassifiedIssues(client, statuses);
    if (!listed.ok) return undefined;

    const issues = listed.value;
    if (!project) return issues;

    const target = project.toLowerCase();
    return issues.filter(
      (issue) => primaryWorkstream(issue)?.toLowerCase() === target,
    );
  }

  async function showOverlay(ctx: ExtensionContext): Promise<void> {
    const project = resolveSessionProject(ctx.sessionManager).workstream;
    const issues = await getIssues(project);

    if (!issues) {
      ctx.ui.notify("Tasks unavailable", "warning");
      return;
    }
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
        const table = renderTaskTable(issues, theme);
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

  async function chooseProject(
    ctx: ExtensionContext,
    title: string,
    projects: Project[],
  ): Promise<Project | undefined> {
    if (projects.length === 0) {
      ctx.ui.notify(`No projects available for ${title.toLowerCase()}`, "info");
      return undefined;
    }
    const labels = projects.map(
      (project) => `${project.name} — ${project.issues.length} tasks`,
    );
    const selected = await selectProject(ctx, title, labels);
    return selected === undefined
      ? undefined
      : projects[labels.indexOf(selected)];
  }

  async function renameProject(
    ctx: ExtensionContext,
    selected?: Project,
  ): Promise<void> {
    const projects = await projectsManager.list();
    const project =
      selected ?? (await chooseProject(ctx, "Rename project", projects));
    if (!project) return;
    const next = await ctx.ui.input("New project name", project.name);
    if (next === undefined) return;
    const plan = await projectsManager.prepareRename(
      projects,
      project.name,
      next,
    );
    if (
      !(await ctx.ui.confirm(
        "Rename project",
        `${project.name} → ${plan.next} across ${plan.project.issues.length} tasks`,
      ))
    )
      return;
    const result = await projectsManager.rename(plan);
    const current = resolveSessionProject(ctx.sessionManager);
    if (current.workstream?.toLowerCase() === project.name.toLowerCase()) {
      persistSessionProject(projectWriter, plan.next);
      pi.setSessionName(
        generateSessionProjectName(ctx.sessionManager, plan.next),
      );
    }
    ctx.ui.notify(
      result.warning
        ? `Renamed project ${project.name} → ${plan.next}, but ${result.warning}`
        : `Renamed project ${project.name} → ${plan.next} across ${plan.project.issues.length} tasks`,
      result.warning ? "warning" : "info",
    );
  }

  async function manageProjects(
    ctx: ExtensionContext,
    archived: boolean,
  ): Promise<void> {
    while (true) {
      const projects = await projectsManager.list();
      const registry = await projectsManager.archives();
      const candidates = projects.filter((project) =>
        archived
          ? registry.archived.includes(project.name.toLowerCase())
          : !isProjectHidden(project, registry),
      );
      const project = await chooseProject(
        ctx,
        archived ? "Archived projects" : "Manage projects",
        candidates,
      );
      if (!project) return;
      const action = await ctx.ui.select(
        project.name,
        archived ? ["Restore"] : ["Rename", "Archive"],
      );
      if (action === "Rename") {
        await renameProject(ctx, project);
        continue;
      }
      if (action !== "Archive" && action !== "Restore") continue;
      if (
        action === "Archive" &&
        !(await ctx.ui.confirm(
          "Archive project",
          `Hide ${project.name} from the project picker? Tasks and history will be preserved.`,
        ))
      )
        continue;
      await projectsManager.setArchived(project.name, action === "Archive");
      ctx.ui.notify(
        `${action === "Archive" ? "Archived" : "Restored"} project ${project.name}`,
        "info",
      );
    }
  }

  async function switchProject(ctx: ExtensionContext): Promise<void> {
    const issues = await getIssues(undefined, ALL_ISSUE_STATUSES);
    if (!issues) {
      ctx.ui.notify("Projects unavailable", "warning");
      return;
    }

    const archives = await projectsManager.archives();
    const hidden = new Set(
      collectProjects(issues)
        .filter((project) => isProjectHidden(project, archives))
        .map((project) => project.name.toLowerCase()),
    );
    const projects = new Map<
      string,
      {
        name: string;
        counts: Record<Readiness, number>;
      }
    >();
    for (const issue of issues) {
      const name = primaryWorkstream(issue);
      if (!name) continue;

      const key = name.toLowerCase();
      if (hidden.has(key)) continue;
      let project = projects.get(key);
      if (!project) {
        project = {
          name,
          counts: { in_progress: 0, blocked: 0, ready: 0, waiting: 0 },
        };
        projects.set(key, project);
      }
      if (issue.status !== "closed" && issue.status !== "deferred") {
        project.counts[issue.readiness]++;
      }
    }

    const global = "Global / no project";
    const labels = [global];
    const namesByLabel = new Map<string, string>();
    const sortedProjects = [...projects.values()].sort((left, right) => {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    });
    for (const project of sortedProjects) {
      const activeCount = Object.values(project.counts).reduce(
        (total, count) => total + count,
        0,
      );
      const label =
        activeCount === 0
          ? `${project.name} — No open tasks`
          : `${project.name} — Active: ${project.counts.in_progress} • Actionable: ${project.counts.ready} • Waiting: ${project.counts.blocked + project.counts.waiting}`;
      labels.push(label);
      namesByLabel.set(label, project.name);
    }

    labels.push("Manage projects…", "Archived projects…");
    const selected = await selectProject(ctx, "Switch project", labels);
    if (selected === undefined) return;
    if (selected === "Manage projects…") return manageProjects(ctx, false);
    if (selected === "Archived projects…") return manageProjects(ctx, true);

    const current = resolveSessionProject(ctx.sessionManager);
    if (selected === global) {
      if (current.source === "explicit" && current.workstream === undefined)
        return;

      persistSessionProject(projectWriter, null);
      pi.setSessionName("");
      return;
    }

    const next = namesByLabel.get(selected);
    if (next === undefined) return;
    if (
      current.source === "explicit" &&
      current.workstream !== undefined &&
      next.toLowerCase() === current.workstream.toLowerCase()
    )
      return;

    persistSessionProject(projectWriter, next);
    pi.setSessionName(generateSessionProjectName(ctx.sessionManager, next));
  }

  pi.registerCommand("tasks", {
    description: "Show project task list as an overlay",
    handler: async (_args, ctx) => showOverlay(ctx),
  });

  pi.registerCommand("project", {
    description: "Switch projects or manage project names and archival",
    handler: async (args, ctx) => {
      try {
        if (args.trim().toLowerCase() === "rename") await renameProject(ctx);
        else await switchProject(ctx);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Project operation failed",
          "warning",
        );
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Show project task list",
    handler: async (ctx) => showOverlay(ctx),
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new") return;

    const project = resolveSessionProject(ctx.sessionManager);
    if (project.workstream === undefined) return;

    const registry = await client.getProjectRenameRegistry();
    if (!registry.ok) {
      ctx.ui.notify(
        "Project scope could not be migrated automatically",
        "warning",
      );
      return;
    }

    const projectKey = project.workstream.toLowerCase();
    const hasAlias = Object.prototype.hasOwnProperty.call(
      registry.value.aliases,
      projectKey,
    );
    const canonical = resolveProjectRename(registry.value, project.workstream);
    if (hasAlias && canonical === undefined) {
      ctx.ui.notify(
        "Project scope could not be migrated automatically",
        "warning",
      );
      return;
    }

    if (canonical !== undefined && canonical !== project.workstream) {
      persistSessionProject(projectWriter, canonical);
      pi.setSessionName(
        generateSessionProjectName(ctx.sessionManager, canonical),
      );
      return;
    }

    if (event.reason !== "fork" || project.source !== "explicit") return;
    pi.setSessionName(
      generateSessionProjectName(ctx.sessionManager, project.workstream),
    );
  });
}
