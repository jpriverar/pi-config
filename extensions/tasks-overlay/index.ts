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
  type ClassifiedIssue,
  type Readiness,
} from "../../lib/beads.js";

const STATUS_ICON: Record<Readiness, string> = {
  in_progress: "◐",
  blocked: "●",
  ready: "○",
  waiting: "◌",
};

function primaryWorkstream(issue: ClassifiedIssue): string | undefined {
  return issue.workstreams[0];
}

export default function tasksOverlay(pi: ExtensionAPI) {
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
    const project = pi.getSessionName() ?? undefined;
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
    for (const project of projects.values()) {
      const label = `${project.name} — In progress: ${project.counts.in_progress} • Blocked: ${project.counts.blocked} • Ready: ${project.counts.ready} • Waiting: ${project.counts.waiting}`;
      labels.push(label);
      namesByLabel.set(label, project.name);
    }

    const selected = await ctx.ui.select("Switch project", labels);
    if (selected === undefined) return;

    const current = pi.getSessionName() ?? "";
    const next = selected === global ? "" : namesByLabel.get(selected);
    if (next === undefined || next.toLowerCase() === current.toLowerCase())
      return;

    pi.setSessionName(next);
  }

  pi.registerCommand("tasks", {
    description: "Show project task list as an overlay",
    handler: async (_args, ctx) => showOverlay(ctx),
  });

  pi.registerCommand("project", {
    description: "Switch project task scope",
    handler: async (_args, ctx) => switchProject(ctx),
  });

  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Show project task list",
    handler: async (ctx) => showOverlay(ctx),
  });
}
