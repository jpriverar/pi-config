import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { BeadsIssue } from "../../lib/beads.js";

export type PaneTokens = Record<
  | "pi_model"
  | "pi_task"
  | "pi_task_state"
  | "pi_task_id"
  | "pi_task_expires_at"
  | "pi_context_warning"
  | "pi_context_critical",
  string | null
>;

export type TaskAssignment =
  | { state: "assigned"; label: string; taskId: string; expiresAt: number }
  | { state: "unassigned" | "unavailable" | "expired"; label: string };

export function taskTokens(
  assignment: TaskAssignment,
): Pick<
  PaneTokens,
  "pi_task" | "pi_task_state" | "pi_task_id" | "pi_task_expires_at"
> {
  return {
    pi_task: assignment.label,
    pi_task_state: assignment.state,
    pi_task_id: assignment.state === "assigned" ? assignment.taskId : null,
    pi_task_expires_at:
      assignment.state === "assigned" ? String(assignment.expiresAt) : null,
  };
}

export function normalizeMetadata(value: string): string {
  return Array.from(
    stripTerminalSequences(value)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 80)
    .join("");
}

export function selectTaskAssignment(
  issues: readonly BeadsIssue[] | undefined,
  sessionId: string,
  now: number,
): TaskAssignment {
  const unavailable: TaskAssignment = {
    state: "unavailable",
    label: "Task unavailable",
  };
  if (!issues || !sessionId || !Number.isFinite(now)) return unavailable;
  // Invalid active metadata could conceal this session's ownership.
  if (
    issues.some(
      (issue) => issue.status === "in_progress" && issue.lifecycleWarning,
    )
  )
    return unavailable;
  const matching = issues.filter(
    (issue) =>
      issue.lifecycle?.phase === "active" &&
      issue.lifecycle.execution?.sessionId === sessionId,
  );
  if (matching.length === 0)
    return { state: "unassigned", label: "Unassigned" };
  if (matching.length !== 1) return unavailable;
  const issue = matching[0];
  const expiresAt = Date.parse(issue.lifecycle!.execution!.expiresAt);
  if (
    issue.status !== "in_progress" ||
    !Number.isFinite(expiresAt) ||
    !issue.id ||
    normalizeMetadata(issue.id) !== issue.id
  )
    return unavailable;
  if (expiresAt <= now) return { state: "expired", label: "Lease expired" };
  const label = normalizeMetadata(issue.title);
  return label
    ? { state: "assigned", label, taskId: issue.id, expiresAt }
    : unavailable;
}

export function runtimeTokens(
  model: { name?: string; id: string } | undefined,
  usage: { percent: number | null } | undefined,
): Pick<PaneTokens, "pi_model" | "pi_context_warning" | "pi_context_critical"> {
  const name = model
    ? normalizeMetadata(model.name ?? "")
        .replace(/^Claude /, "")
        .replace(/\s*\(AI Gateway.*\)$/, "") || normalizeMetadata(model.id)
    : null;
  const percent = usage?.percent;
  const known = typeof percent === "number" && Number.isFinite(percent);
  const label = known ? `Context ${Math.floor(percent)}%` : null;
  return {
    pi_model: name || null,
    pi_context_warning: known && percent >= 75 && percent < 90 ? label : null,
    pi_context_critical: known && percent >= 90 ? label : null,
  };
}
