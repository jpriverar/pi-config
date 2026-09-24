import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  hyperlink,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
  normalizeMetadata,
  type ClassifiedIssue,
  type Readiness,
} from "../../lib/beads.js";
import type { Artifact } from "../../lib/task-lifecycle/types.js";

export const TASK_TABLE_HEADERS = [
  "ID",
  "STATE",
  "TASK",
  "ARTIFACTS",
  "BLOCKERS",
] as const;

const STATUS_RANK: Record<Readiness, number> = {
  in_progress: 0,
  ready: 1,
  blocked: 2,
  waiting: 3,
};
const COLUMN_CAPS = [14, 18, 42, 56, 40] as const;

export interface RenderedTaskTable {
  lines: string[];
  headerLines: number;
  width: number;
}

export interface TaskTableCells {
  id: string[];
  state: string[];
  task: string[];
  artifacts: string[];
  blockers: string[];
}

function stateLabel(issue: ClassifiedIssue, now: number): string {
  let label: string;
  if (issue.readiness === "in_progress") label = "ACTIVE";
  else if (issue.readiness === "ready") label = "ACTIONABLE";
  else label = "WAITING";

  if (
    issue.readiness === "waiting" &&
    issue.lifecycleStateEnteredAt !== undefined
  ) {
    const elapsed = Math.max(
      0,
      now - Date.parse(issue.lifecycleStateEnteredAt),
    );
    label += ` · ${Math.floor(elapsed / 86_400_000)}d`;
  }
  return label;
}

function statusColor(readiness: Readiness): ThemeColor {
  if (readiness === "in_progress") return "warning";
  if (readiness === "ready") return "success";
  if (readiness === "blocked") return "error";
  return "muted";
}

function artifactLabel(artifact: Artifact): string {
  const kind = artifact.kind.replaceAll("_", " ");
  const title =
    normalizeMetadata(artifact.title, 2_000) || "(untitled artifact)";
  return `${kind} · ${title}${artifact.supersededAt === null ? "" : " · superseded"}`;
}

function artifactLines(issue: ClassifiedIssue, theme: Theme): string[] {
  const artifacts = issue.lifecycle?.artifacts ?? [];
  if (artifacts.length === 0) return [theme.fg("dim", "—")];

  return artifacts.map((artifact) => {
    const label = artifactLabel(artifact);
    const styled =
      artifact.supersededAt === null
        ? theme.fg("text", label)
        : theme.fg("dim", label);
    const uri = normalizeMetadata(artifact.uri, 4_000);
    return uri.length === 0 ? styled : hyperlink(styled, uri);
  });
}

function blockerLines(issue: ClassifiedIssue, now: number): string[] {
  if (issue.blockingTaskIds.length > 0) return issue.blockingTaskIds;

  const check = issue.activeCheck;
  if (check !== undefined && check !== null) {
    const lines = [
      check.lastObservation === null || check.lastObservation === "open"
        ? check.kind === "github_pull_request"
          ? "PR open"
          : "check pending"
        : normalizeMetadata(check.lastObservation, 2_000),
    ];
    if (check.nextCheckAt !== null) {
      lines.push(
        Date.parse(check.nextCheckAt) < now
          ? `overdue since ${check.nextCheckAt.slice(11, 16)}`
          : `next check ${check.nextCheckAt.slice(11, 16)}`,
      );
    }
    return [
      ...lines,
      ...issue.warnings.map((warning) => normalizeMetadata(warning, 2_000)),
    ];
  }

  const warnings = issue.warnings.map((warning) =>
    normalizeMetadata(warning, 2_000),
  );
  if (issue.readiness === "blocked") return ["blocked", ...warnings];
  return warnings.length > 0 ? warnings : ["—"];
}

export function taskTableCells(
  issue: ClassifiedIssue,
  theme: Theme,
  now: number = Date.now(),
): TaskTableCells {
  return {
    id: [theme.fg("muted", issue.id)],
    state: [
      theme.fg(
        statusColor(issue.readiness),
        theme.bold(stateLabel(issue, now)),
      ),
    ],
    task: [theme.fg("text", `${issue.title}${issue.needsJp ? " ← you" : ""}`)],
    artifacts: artifactLines(issue, theme),
    blockers: blockerLines(issue, now).map((value) => theme.fg("muted", value)),
  };
}

function cellColumns(cells: TaskTableCells): string[][] {
  return [cells.id, cells.state, cells.task, cells.artifacts, cells.blockers];
}

function columnWidths(rows: TaskTableCells[]): number[] {
  return TASK_TABLE_HEADERS.map((header, column) => {
    const contentWidth = Math.max(
      visibleWidth(header),
      ...rows.flatMap((cells) =>
        (cellColumns(cells)[column] ?? []).map(visibleWidth),
      ),
    );
    return Math.min(COLUMN_CAPS[column] ?? contentWidth, contentWidth);
  });
}

function divider(widths: number[]): string {
  return widths.map((width) => "─".repeat(width)).join("─┼─");
}

function row(cells: string[], widths: number[]): string {
  return cells
    .map((cell, index) => truncateToWidth(cell, widths[index] ?? 1, "…", true))
    .join(" │ ");
}

function wrapCells(cells: string[][], widths: number[]): string[][] {
  return cells.map((values, index) =>
    values.flatMap((value) =>
      wrapTextWithAnsi(value, Math.max(1, widths[index] ?? 1)),
    ),
  );
}

export function sortTaskTableIssues(
  issues: readonly ClassifiedIssue[],
): ClassifiedIssue[] {
  return [...issues].sort(
    (left, right) =>
      STATUS_RANK[left.readiness] - STATUS_RANK[right.readiness] ||
      left.id.localeCompare(right.id),
  );
}

export function renderTaskTable(
  issues: readonly ClassifiedIssue[],
  theme: Theme,
  now: number = Date.now(),
): RenderedTaskTable {
  const sorted = sortTaskTableIssues(issues);
  const rows = sorted.map((issue) => taskTableCells(issue, theme, now));
  const widths = columnWidths(rows);
  const lines = [
    row(
      TASK_TABLE_HEADERS.map((header) => theme.fg("dim", theme.bold(header))),
      widths,
    ),
    divider(widths),
  ];

  rows.forEach((taskCells, issueIndex) => {
    if (issueIndex > 0) lines.push(divider(widths));
    const cells = wrapCells(cellColumns(taskCells), widths);
    const height = Math.max(...cells.map((cell) => cell.length));
    for (let line = 0; line < height; line++) {
      lines.push(
        row(
          cells.map((cell) => cell[line] ?? ""),
          widths,
        ),
      );
    }
  });

  return {
    lines,
    headerLines: 2,
    width: lines.reduce(
      (maximum, line) => Math.max(maximum, visibleWidth(line)),
      0,
    ),
  };
}
