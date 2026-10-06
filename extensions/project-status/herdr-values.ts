import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { BeadsIssue } from "../../lib/beads.js";

export type PaneTokens = Record<
  "pi_model" | "pi_task" | "pi_context_warning" | "pi_context_critical",
  string | null
>;

export interface TaskAssignment {
  label: string;
  expiresAt?: number;
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
  const unavailable = { label: "Task unavailable" };
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
  if (matching.length === 0) return { label: "Unassigned" };
  if (matching.length !== 1) return unavailable;
  const issue = matching[0];
  const expiresAt = Date.parse(issue.lifecycle!.execution!.expiresAt);
  if (issue.status !== "in_progress" || !Number.isFinite(expiresAt))
    return unavailable;
  if (expiresAt <= now) return { label: "Lease expired" };
  const label = normalizeMetadata(issue.title);
  return label ? { label, expiresAt } : unavailable;
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
