import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  classifyReadiness,
  createBeadsClient,
  normalizeBeadsLabel,
  type ClassifiedIssue,
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

const STATUS_ICON: Record<Readiness, string> = {
  in_progress: "◐",
  blocked: "●",
  ready: "○",
  waiting: "◌",
};
const ALL_ISSUE_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
] as const;
const WORKSTREAM_LABEL_PREFIX = "workstream:";

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
  ): Promise<ClassifiedIssue[] | undefined> {
    const listed = await client.listIssues();
    if (!listed.ok) return undefined;

    const ready = await client.listReadyIssueIds();
    if (!ready.ok) return undefined;

    const issues = classifyReadiness(listed.value, ready.value);
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

    const groups: Array<{
      label: string;
      items: ClassifiedIssue[];
      color: ThemeColor;
    }> = [
      {
        label: "◐ In progress",
        items: issues.filter((issue) => issue.readiness === "in_progress"),
        color: "warning",
      },
      {
        label: "● Blocked",
        items: issues.filter((issue) => issue.readiness === "blocked"),
        color: "error",
      },
      {
        label: "○ Ready",
        items: issues.filter((issue) => issue.readiness === "ready"),
        color: "text",
      },
      {
        label: "◌ Waiting",
        items: issues.filter((issue) => issue.readiness === "waiting"),
        color: "muted",
      },
    ];
    const title = project ? `Tasks — ${project}` : "Tasks";

    function buildLines(theme: Theme): string[] {
      const lines: string[] = [];
      for (const group of groups) {
        if (group.items.length === 0) continue;
        lines.push("");
        lines.push(
          theme.fg(
            group.color,
            theme.bold(`${group.label} (${group.items.length})`),
          ),
        );
        for (const issue of group.items) {
          const marker = issue.needsJp ? theme.fg("warning", " ← you") : "";
          lines.push(
            `  ${theme.fg(group.color, STATUS_ICON[issue.readiness])} ${theme.fg("dim", issue.id)} ${issue.title}${marker}`,
          );
        }
      }
      return lines;
    }

    await ctx.ui.custom(
      (tui, theme, _kb, done) => {
        const allLines = buildLines(theme);
        let scrollOffset = 0;
        const terminalRows = process.stdout.rows || 40;
        const viewport = Math.max(8, Math.floor(terminalRows * 0.4) - 2);

        return {
          render(width: number) {
            const innerWidth = width - 4;
            const maxScroll = Math.max(0, allLines.length - viewport);
            scrollOffset = Math.min(scrollOffset, maxScroll);
            const visible = allLines.slice(
              scrollOffset,
              scrollOffset + viewport,
            );
            const side = theme.fg("border", "│");
            const body = visible.map((line) => {
              const truncated = truncateToWidth(line, innerWidth);
              const padding = Math.max(0, innerWidth - visibleWidth(truncated));
              return `${side} ${truncated}${" ".repeat(padding)} ${side}`;
            });
            while (body.length < viewport) {
              body.push(`${side} ${" ".repeat(innerWidth)} ${side}`);
            }

            const scrollInfo =
              allLines.length > viewport
                ? ` [${scrollOffset + 1}-${Math.min(scrollOffset + viewport, allLines.length)}/${allLines.length}]`
                : "";
            const helpText = `↑↓ scroll • esc close${scrollInfo}`;
            const topFill = Math.max(0, width - 5 - visibleWidth(title));
            const bottomFill = Math.max(0, width - 5 - visibleWidth(helpText));
            const topLine = `${theme.fg("border", "┌─")} ${theme.fg("accent", theme.bold(title))} ${theme.fg("border", "─".repeat(topFill) + "┐")}`;
            const bottomLine = `${theme.fg("border", "└─")} ${theme.fg("dim", helpText)} ${theme.fg("border", "─".repeat(bottomFill) + "┘")}`;
            return [topLine, ...body, bottomLine];
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
              done(null);
            } else if (matchesKey(data, Key.up)) {
              scrollOffset = Math.max(0, scrollOffset - 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.down)) {
              scrollOffset++;
              tui.requestRender();
            }
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%" },
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
    const issues = await getIssues();
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
      project.counts[issue.readiness]++;
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
      const label = `${project.name} — In progress: ${project.counts.in_progress} • Blocked: ${project.counts.blocked} • Ready: ${project.counts.ready} • Waiting: ${project.counts.waiting}`;
      labels.push(label);
      namesByLabel.set(label, project.name);
    }

    const selected = await ctx.ui.select("Switch project", labels);
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
