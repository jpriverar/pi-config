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
  listClassifiedIssues,
  normalizeBeadsLabel,
  type ClassifiedIssue,
  type IssueStatus,
  type Readiness,
} from "../../lib/beads.js";
import {
  recordProjectRename,
  resolveProjectRename,
  validateProjectName,
} from "../../lib/project-renames.js";
import {
  generateSessionProjectName,
  persistSessionProject,
  resolveSessionProject,
  type SessionProjectWriter,
} from "../../lib/session-project.js";
import { renderTaskTable } from "../shared/task-table.js";

const ALL_ISSUE_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
] as const;
const WORKSTREAM_LABEL_PREFIX = "workstream:";
const PROJECT_PICKER_VISIBLE_ITEMS = 8;

function primaryWorkstream(issue: ClassifiedIssue): string | undefined {
  return issue.workstreams[0];
}

function workstreamLabels(issue: { labels: readonly string[] }): string[] {
  return issue.labels.filter((label) =>
    label.startsWith(WORKSTREAM_LABEL_PREFIX),
  );
}

function normalizeLabelSet(labels: readonly string[]): Set<string> {
  return new Set(
    labels
      .map((label) => normalizeBeadsLabel(label))
      .filter((label) => label.length > 0),
  );
}

function sameLabelSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return (
    left.size === right.size && [...left].every((label) => right.has(label))
  );
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
  const client = createBeadsClient(async (command, args) => {
    const result = await pi.exec(command, [...args]);
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });

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
        const viewport = Math.max(8, Math.floor(terminalRows * 0.4) - 2);

        return {
          render(width: number) {
            const innerWidth = Math.max(1, width - 4);
            bodyViewport = Math.max(1, viewport - table.headerLines);
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
            while (body.length < viewport) {
              body.push(`${side} ${" ".repeat(innerWidth)} ${side}`);
            }

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

  async function renameProject(ctx: ExtensionContext): Promise<void> {
    const listed = await client.listIssues(ALL_ISSUE_STATUSES);
    if (!listed.ok) {
      ctx.ui.notify("Projects unavailable", "warning");
      return;
    }

    const projects = new Map<
      string,
      {
        name: string;
        variants: Set<string>;
        issueIds: string[];
      }
    >();
    for (const issue of listed.value) {
      const seen = new Set<string>();
      for (const label of workstreamLabels(issue)) {
        const name = label.slice(WORKSTREAM_LABEL_PREFIX.length);
        if (!name) continue;

        const key = name.toLowerCase();
        let project = projects.get(key);
        if (!project) {
          project = { name, variants: new Set(), issueIds: [] };
          projects.set(key, project);
        }
        project.variants.add(name);
        if (!seen.has(key)) {
          project.issueIds.push(issue.id);
          seen.add(key);
        }
      }
    }

    const sortedProjects = [...projects.entries()].sort((left, right) => {
      const leftName = left[1].name.toLowerCase();
      const rightName = right[1].name.toLowerCase();
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    });
    if (sortedProjects.length === 0) {
      ctx.ui.notify("No projects to rename", "info");
      return;
    }

    const labels = sortedProjects.map(
      ([, project]) => `${project.name} — ${project.issueIds.length} tasks`,
    );
    const projectsByLabel = new Map(
      sortedProjects.map(([key, project], index) => [
        labels[index],
        { key, project },
      ]),
    );
    const selectedLabel = await ctx.ui.select("Rename project", labels);
    if (selectedLabel === undefined) return;

    const selected = projectsByLabel.get(selectedLabel);
    if (!selected) return;

    const renamed = await ctx.ui.input(
      "New project name",
      selected.project.name,
    );
    if (renamed === undefined) return;

    const validatedName = validateProjectName(renamed);
    if (!validatedName.ok) {
      ctx.ui.notify(validatedName.message, "warning");
      return;
    }

    const next = validatedName.value;
    const nextKey = next.toLowerCase();
    if (nextKey !== selected.key && projects.has(nextKey)) {
      ctx.ui.notify(`Project ${next} already exists`, "warning");
      return;
    }

    const preflightRegistry = await client.getProjectRenameRegistry();
    if (!preflightRegistry.ok) {
      ctx.ui.notify(
        "Project rename unavailable because session migrations cannot be prepared",
        "warning",
      );
      return;
    }

    const confirmed = await ctx.ui.confirm(
      "Rename project",
      `${selected.project.name} → ${next} across ${selected.project.issueIds.length} tasks`,
    );
    if (!confirmed) return;

    const removeLabels = [...selected.project.variants].map(
      (name) => `${WORKSTREAM_LABEL_PREFIX}${name}`,
    );
    const removeLabelSet = new Set(removeLabels);
    const targetLabel = `${WORKSTREAM_LABEL_PREFIX}${next}`;
    const expectedLabelsByIssueId = new Map(
      selected.project.issueIds.map((issueId) => {
        const issue = listed.value.find(
          (candidate) => candidate.id === issueId,
        );
        const expectedLabels = normalizeLabelSet([
          ...(issue?.labels ?? []).filter(
            (label) => !removeLabelSet.has(label),
          ),
          targetLabel,
        ]);
        return [issueId, expectedLabels] as const;
      }),
    );

    await client.updateIssueLabels(selected.project.issueIds, {
      removeLabels,
      addLabels: [targetLabel],
    });
    const relisted = await client.listIssues(ALL_ISSUE_STATUSES);
    if (!relisted.ok) {
      ctx.ui.notify(
        `Project rename could not be verified for ${next}`,
        "warning",
      );
      return;
    }

    const relistedById = new Map(
      relisted.value.map((issue) => [issue.id, issue] as const),
    );
    const verified = selected.project.issueIds.every((issueId) => {
      const expectedLabels = expectedLabelsByIssueId.get(issueId);
      const issue = relistedById.get(issueId);
      if (!expectedLabels || !issue) return false;
      return sameLabelSet(normalizeLabelSet(issue.labels), expectedLabels);
    });
    if (!verified) {
      ctx.ui.notify(
        `Project rename could not be verified for ${next}`,
        "warning",
      );
      return;
    }

    const current = resolveSessionProject(ctx.sessionManager);
    if (
      current.workstream !== undefined &&
      current.workstream.toLowerCase() === selected.key
    ) {
      persistSessionProject(projectWriter, next);
      pi.setSessionName(generateSessionProjectName(ctx.sessionManager, next));
    }

    const latestRegistry = await client.getProjectRenameRegistry();
    if (latestRegistry.ok) {
      const recorded = recordProjectRename(
        latestRegistry.value,
        selected.project.name,
        next,
      );
      const saved = await client.setProjectRenameRegistry(recorded);
      if (saved.ok) {
        const verifiedRegistry = await client.getProjectRenameRegistry();
        if (
          verifiedRegistry.ok &&
          resolveProjectRename(
            verifiedRegistry.value,
            selected.project.name,
          ) === next
        ) {
          ctx.ui.notify(
            `Renamed project ${selected.project.name} → ${next} across ${selected.project.issueIds.length} tasks`,
            "info",
          );
          return;
        }
      }
    }

    ctx.ui.notify(
      `Renamed project ${selected.project.name} → ${next}, but other sessions cannot migrate automatically`,
      "warning",
    );
  }

  async function switchProject(ctx: ExtensionContext): Promise<void> {
    const issues = await getIssues(undefined, ALL_ISSUE_STATUSES);
    if (!issues) {
      ctx.ui.notify("Projects unavailable", "warning");
      return;
    }

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

    const selected = await selectProject(ctx, "Switch project", labels);
    if (selected === undefined) return;

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
    description: "Switch project task scope or rename a project",
    handler: async (args, ctx) =>
      args.trim().toLowerCase() === "rename"
        ? renameProject(ctx)
        : switchProject(ctx),
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
