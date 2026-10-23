import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { WakeupState } from "../../lib/wakeups.js";

interface WaitNotice {
  phase: "waiting" | "cancelled" | "expired";
  reason: string;
  dueAt: number;
  recordedAt: number;
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? stripTerminalSequences(value)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

export function wakeupTime(dueAt: number, now = Date.now()): string {
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return "unknown time";
  const sameDay = due.toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
  }).format(due);
}

export function createWakeupPresentation(pi: ExtensionAPI) {
  let state: WakeupState = { status: "ready" };
  let context: ExtensionContext | undefined;
  let announcedId: string | undefined;
  let lastLabel: string | null | undefined;
  let blockers = 0;

  pi.registerEntryRenderer<WaitNotice>(
    "wakeup-wait",
    (entry, _options, theme) => {
      const data = entry.data;
      if (!data) return new Text("Wait status unavailable", 0, 0);
      const remaining = data.dueAt - data.recordedAt;
      const title =
        data.phase === "waiting"
          ? remaining > 0
            ? `◷ Waiting ${Math.ceil(remaining / 60_000)} min · next check at ${wakeupTime(data.dueAt, data.recordedAt)}`
            : "◷ Waiting · next check due now"
          : `◷ Wait ${data.phase === "expired" ? "expired" : "cancelled"}`;
      return new Text(
        `${theme.fg("warning", title)}\n${theme.fg("muted", clean(data.reason))}`,
        0,
        0,
      );
    },
  );

  function append(data: WaitNotice): void {
    try {
      pi.appendEntry("wakeup-wait", data);
    } catch {
      // Display persistence must never change whether a timer runs or stops.
    }
  }

  function refresh(): void {
    const pending = state.pending;
    const waiting =
      context?.mode === "tui" &&
      pending &&
      blockers === 0 &&
      context.isIdle() &&
      !context.hasPendingMessages();
    const label = waiting
      ? `Waiting · until ${wakeupTime(pending.dueAt)}`
      : null;
    if (label !== lastLabel) {
      try {
        pi.events.emit("pi:wakeup-waiting", label);
        lastLabel = label;
      } catch {
        // An optional sidebar consumer cannot become a scheduler prerequisite.
      }
    }
    if (waiting && announcedId !== pending.id) {
      announcedId = pending.id;
      append({
        phase: "waiting",
        reason: pending.reason,
        dueAt: pending.dueAt,
        recordedAt: Date.now(),
      });
    }
  }

  pi.events.on("herdr:blocked", (data: unknown) => {
    if (
      !data ||
      typeof data !== "object" ||
      !("active" in data) ||
      typeof data.active !== "boolean"
    )
      return;
    blockers = data.active ? blockers + 1 : Math.max(0, blockers - 1);
    refresh();
  });

  return {
    update(next: WakeupState, ctx: ExtensionContext | undefined): void {
      const previous = state.pending;
      context = ctx;
      state = next;
      if (
        previous &&
        !next.pending &&
        announcedId === previous.id &&
        context?.mode === "tui" &&
        ["ready", "cancelled", "expired"].includes(next.status)
      ) {
        append({
          phase: next.status === "expired" ? "expired" : "cancelled",
          reason: previous.reason,
          dueAt: previous.dueAt,
          recordedAt: Date.now(),
        });
      }
      if (!next.pending) announcedId = undefined;
      if (next.status === "ready") blockers = 0;
      refresh();
    },
  };
}
