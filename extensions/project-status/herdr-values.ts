import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { BeadsIssue } from "../../lib/beads.js";
import { resolveOwnedTask } from "../../lib/session-identity.js";
import type { LifecyclePhase } from "../../lib/task-lifecycle/types.js";
import { lifecycleStatusLabel } from "../../lib/task-lifecycle/presentation.js";

export type PaneTokens = Record<
  | "pi_model"
  | "pi_task"
  | "pi_task_state"
  | "pi_task_phase"
  | "pi_task_status"
  | "pi_task_id"
  | "pi_task_expires_at"
  | "pi_project"
  | "pi_area"
  | "pi_context_warning"
  | "pi_context_critical"
  | "pi_waiting",
  string | null
>;

export type PaneMetadata = PaneTokens & { displayAgent: string | null };

export type TaskAssignment =
  | {
      state: "assigned";
      label: string;
      taskId: string;
      phase?: LifecyclePhase;
      project?: string;
      area?: string;
    }
  | { state: "unassigned" | "unavailable"; label: string };

export function taskPaneLabel(
  assignment: TaskAssignment,
  sessionName: string | undefined,
): string {
  if (assignment.state === "assigned")
    return normalizeMetadata(`${assignment.taskId} • ${assignment.label}`);
  if (assignment.state === "unassigned")
    return normalizeMetadata(sessionName ?? "") || "Unassigned";
  return "Task unavailable";
}

export function taskTokens(
  assignment: TaskAssignment,
): Pick<
  PaneTokens,
  | "pi_task"
  | "pi_task_state"
  | "pi_task_phase"
  | "pi_task_status"
  | "pi_task_id"
  | "pi_task_expires_at"
  | "pi_project"
  | "pi_area"
> {
  return {
    pi_task: assignment.label,
    pi_task_state: assignment.state,
    pi_task_phase:
      assignment.state === "assigned" ? (assignment.phase ?? null) : null,
    pi_task_status:
      assignment.state === "assigned"
        ? lifecycleStatusLabel(assignment.phase, true)
        : null,
    pi_task_id: assignment.state === "assigned" ? assignment.taskId : null,
    // Clear the obsolete deadline left by pre-durable-ownership clients.
    pi_task_expires_at: null,
    pi_project:
      assignment.state === "assigned"
        ? normalizeMetadata(assignment.project ?? "") || null
        : null,
    pi_area:
      assignment.state === "assigned"
        ? normalizeMetadata(assignment.area ?? "") || null
        : null,
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
): TaskAssignment {
  const unavailable: TaskAssignment = {
    state: "unavailable",
    label: "Task unavailable",
  };
  if (!issues || !sessionId) return unavailable;
  const selected = resolveOwnedTask(issues, sessionId);
  if (selected.kind === "unassigned")
    return { state: "unassigned", label: "Unassigned" };
  if (selected.kind !== "owned") return unavailable;
  const issue = selected.issue;
  const lifecycle = issue.lifecycle;
  if (
    lifecycle == null ||
    !issue.id ||
    normalizeMetadata(issue.id) !== issue.id
  )
    return unavailable;
  if (
    lifecycle.version === 1 &&
    !Number.isFinite(Date.parse(lifecycle.execution!.expiresAt))
  )
    return unavailable;
  const label = normalizeMetadata(issue.title);
  return label
    ? { state: "assigned", label, taskId: issue.id, phase: lifecycle.phase }
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
