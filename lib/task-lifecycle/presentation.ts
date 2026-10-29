import type { LifecyclePhase } from "./types.js";

const PHASE_LABELS: Record<LifecyclePhase, string> = {
  actionable: "Ready",
  active: "In progress",
  waiting: "Blocked",
  deferred: "Deferred",
  done: "Done",
};

export function lifecycleStatusLabel(
  phase: LifecyclePhase | undefined,
  owned = false,
): string | null {
  if (phase === undefined) return null;
  return phase === "actionable" && owned
    ? "Ready to resume"
    : PHASE_LABELS[phase];
}
