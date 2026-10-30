import type { LifecycleMetadata, LifecyclePhase } from "./types.js";

export function requiresCompletionCleanup(
  lifecycle: LifecycleMetadata | null | undefined,
): boolean {
  return (
    lifecycle?.version === 2 &&
    lifecycle.phase === "actionable" &&
    lifecycle.activeCheck?.state === "satisfied" &&
    lifecycle.activeCheck.onSatisfied === "close" &&
    lifecycle.resources.some((resource) => resource.cleanupState !== "released")
  );
}

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
  cleanupRequired = false,
): string | null {
  if (phase === undefined) return null;
  if (phase === "actionable" && cleanupRequired)
    return "Ready — cleanup required";
  return phase === "actionable" && owned
    ? "Ready to resume"
    : PHASE_LABELS[phase];
}
