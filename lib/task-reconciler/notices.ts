import { createHash } from "node:crypto";
import { normalizeMetadata, type BeadsIssue } from "../beads.js";
import type { LifecycleCheck } from "../task-lifecycle/types.js";
import type { DaemonHealth } from "./health.js";

export const MAX_NOTICE_CURSOR_BYTES = 128 * 1024;
export interface NoticeCursor {
  version: 1;
  knownTaskIds: readonly string[];
  lastSeen: Readonly<Record<string, string>>;
  healthSignature: string | null;
}
export interface ReconciliationNotice {
  key: string;
  taskId?: string;
  level: "info" | "warning";
  message: string;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function readNoticeCursor(value: unknown): NoticeCursor | null {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_NOTICE_CURSOR_BYTES
    )
      return null;
    const c = value as NoticeCursor;
    const id = (v: unknown): v is string =>
      typeof v === "string" &&
      v.length > 0 &&
      v.length <= 256 &&
      normalizeMetadata(v, 256) === v;
    if (
      c.version !== 1 ||
      !Array.isArray(c.knownTaskIds) ||
      !c.knownTaskIds.every(id) ||
      !c.lastSeen ||
      typeof c.lastSeen !== "object" ||
      Array.isArray(c.lastSeen) ||
      !(
        c.healthSignature === null ||
        (typeof c.healthSignature === "string" &&
          c.healthSignature.length < 128)
      )
    )
      return null;
    if (
      !Object.entries(c.lastSeen).every(
        ([key, signature]) =>
          id(key) &&
          typeof signature === "string" &&
          /^[a-z_]+:[a-f0-9]{64}$/.test(signature),
      )
    )
      return null;
    return c;
  } catch {
    return null;
  }
}
function wakes(
  check: LifecycleCheck | null | undefined,
  kind: string,
): boolean {
  if (!check || check.wakeOn.length === 0) return true;
  if (check.wakeOn.includes(kind)) return true;
  if (check.kind === "manual" && check.wakeOn.includes("manual")) return true;
  if (check.kind !== "github_pull_request") return false;
  if (kind === "satisfied") return check.wakeOn.includes("merged");
  if (kind !== "action_required") return false;
  const reasons: Record<string, string[]> = {
    changes_requested: ["changes_requested"],
    merge_conflict: ["merge_conflict", "conflict"],
    closed_unmerged: ["closed_unmerged", "closed"],
  };
  return (reasons[check.lastObservation ?? ""] ?? []).some((name) =>
    check.wakeOn.includes(name),
  );
}
function observation(issue: BeadsIssue) {
  const l = issue.lifecycle!;
  const check = l.activeCheck ?? l.checkHistory.at(-1);
  const pending = l.resources
    .filter((r) => r.cleanupState === "release_pending")
    .map((r) => r.id);
  let kind = l.phase as string;
  if (pending.length) kind = "cleanup";
  else if (check?.state === "error" && check.errorCount >= 3) kind = "error";
  else if (check?.state === "action_required") kind = "action_required";
  else if (
    l.activeCheck?.kind === "manual" &&
    typeof l.activeCheck.predicate.reviewAt === "string" &&
    Date.parse(l.activeCheck.predicate.reviewAt) <= Date.now()
  )
    kind = "manual";
  else if (l.phase === "done") kind = "done";
  else if (check?.state === "satisfied") kind = "satisfied";
  else if (l.phase === "waiting") kind = "pending";
  const signature = `${kind}:${hash([l.phase, issue.status, check?.id, kind, pending, kind === "error" || kind === "action_required" ? check?.lastObservation : null])}`;
  return { kind, signature, check };
}
export function selectReconciliationNotices(
  issues: readonly BeadsIssue[],
  health: DaemonHealth,
  previous: NoticeCursor | null,
): { notices: readonly ReconciliationNotice[]; cursor: NoticeCursor } {
  const notices: ReconciliationNotice[] = [];
  const rows = [
    ...new Map(
      issues.filter((i) => i.lifecycle).map((i) => [i.id, i]),
    ).values(),
  ];
  const known = new Set(previous?.knownTaskIds ?? []);
  const lastSeen: Record<string, string> = Object.assign(
    Object.create(null),
    previous?.lastSeen,
  );
  const currentIds = new Set(rows.map((row) => row.id));
  for (const id of Object.keys(lastSeen))
    if (!id.startsWith("$") && !known.has(id) && !currentIds.has(id))
      delete lastSeen[id];
  const healthy =
    health.state === "available" && health.queue.diagnostics.length === 0;
  const healthSignature = `${healthy ? "healthy" : health.state}:${hash([health.state, "runtimeVersion" in health ? health.runtimeVersion : null, "queue" in health ? health.queue.diagnostics.map((d) => [d.taskId, d.code]).sort() : health.reason])}`;
  if (healthSignature !== previous?.healthSignature) {
    if (!healthy)
      notices.push({
        key: "health",
        level: "warning",
        message:
          health.state === "incompatible"
            ? "Task reconciler protocol is incompatible; explicit runtime update is required. Use /task-reconciler status."
            : "Task reconciler needs attention or setup. Use /task-reconciler status; installation and activation are explicit.",
      });
    else if (
      previous?.healthSignature &&
      !previous.healthSignature.startsWith("healthy:")
    )
      notices.push({
        key: "health",
        level: "info",
        message: "Task reconciler recovered and is available.",
      });
  }
  for (const issue of rows) {
    const { kind, signature, check } = observation(issue);
    const prior = lastSeen[issue.id];
    const id = normalizeMetadata(issue.id, 128);
    let message: string | undefined;
    let level: "info" | "warning" = "info";
    if (
      ["cleanup", "error", "action_required", "manual"].includes(kind) &&
      (kind === "cleanup" || wakes(check, kind))
    ) {
      level = "warning";
      message =
        kind === "cleanup"
          ? `${id}: worktree cleanup remains pending.`
          : kind === "error"
            ? `${id}: reconciliation check has repeated errors.`
            : kind === "manual"
              ? `${id}: manual review is overdue.`
              : `${id}: reconciliation check needs attention.`;
    } else if (prior !== undefined) {
      if (
        (kind === "done" || kind === "satisfied") &&
        wakes(check, "satisfied")
      )
        message =
          kind === "done"
            ? `${id}: task completed.`
            : `${id}: check satisfied.`;
      else if (kind === "actionable" && wakes(check, "satisfied"))
        message = `${id}: task became actionable.`;
      else if (
        prior.startsWith("error:") &&
        kind !== "error" &&
        wakes(check, "recovery")
      )
        message = `${id}: reconciliation check recovered.`;
    }
    if (prior !== signature && message !== undefined) {
      if (notices.length >= 10) {
        known.add(issue.id);
        continue;
      }
      notices.push({
        key: `${issue.id}:${signature}`,
        taskId: issue.id,
        level,
        message,
      });
    }
    lastSeen[issue.id] = signature;
    if (issue.status === "closed" || issue.lifecycle!.phase === "done")
      known.delete(issue.id);
    else known.add(issue.id);
  }
  let cursor: NoticeCursor = {
    version: 1,
    knownTaskIds: [...known],
    lastSeen,
    healthSignature,
  };
  if (Buffer.byteLength(JSON.stringify(cursor)) > MAX_NOTICE_CURSOR_BYTES) {
    const overflow = `baseline:${hash(rows.map((r) => r.id))}`;
    const bounded: Record<string, string> = Object.create(null);
    bounded.$overflow = overflow;
    const ids: string[] = [];
    let bytes = 512;
    for (const row of rows) {
      const cost = Buffer.byteLength(JSON.stringify(row.id)) * 2 + 140;
      if (bytes + cost > MAX_NOTICE_CURSOR_BYTES) break;
      bytes += cost;
      bounded[row.id] = observation(row).signature;
      if (row.status !== "closed") ids.push(row.id);
    }
    cursor = {
      version: 1,
      knownTaskIds: ids,
      lastSeen: bounded,
      healthSignature,
    };
    return {
      cursor,
      notices:
        previous?.lastSeen.$overflow === overflow
          ? []
          : [
              {
                key: "cursor_overflow",
                level: "warning",
                message:
                  "Reconciliation notice history exceeded 128 KiB and was rebaselined. Narrow project scope; historical outcomes were not inferred.",
              },
            ],
    };
  }
  return { notices, cursor };
}
