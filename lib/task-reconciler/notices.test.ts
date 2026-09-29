import assert from "node:assert/strict";
import { test } from "node:test";
import type { BeadsIssue } from "../beads.js";
import type { DaemonHealth } from "./health.js";
import { waitingTask } from "./test-fixtures.js";
import { selectReconciliationNotices, readNoticeCursor } from "./notices.js";
const health: DaemonHealth = {
  state: "available",
  protocolVersion: 1,
  runtimeVersion: "fixture",
  pid: 1,
  startedAt: "2026-01-01T00:00:00Z",
  heartbeatAt: "2026-01-01T00:00:00Z",
  queue: {
    lastScanAttemptAt: null,
    lastScanSuccessAt: null,
    queued: 0,
    localRunning: 0,
    externalRunning: 0,
    diagnostics: [],
  },
};
function issue(id = "jp-1"): BeadsIssue {
  const task = waitingTask(id);
  return {
    id,
    title: "untrusted title",
    status: "blocked",
    labels: [],
    lifecycle: task.lifecycle,
  };
}

test("baseline suppresses historical transitions but shows unresolved attention once", () => {
  const task = issue();
  task.lifecycle!.phase = "actionable";
  task.lifecycle!.activeCheck!.state = "action_required";
  const first = selectReconciliationNotices([task], health, null);
  assert.equal(first.notices.length, 1);
  assert.equal(first.notices[0].level, "warning");
  assert.equal(
    selectReconciliationNotices([task], health, first.cursor).notices.length,
    0,
  );
  task.lifecycle!.activeCheck = null;
  assert.equal(
    selectReconciliationNotices([task], health, null).notices.length,
    0,
  );
});
test("important transitions, errors and recovery do not replay routine polls", () => {
  const task = issue();
  let selected = selectReconciliationNotices([task], health, null);
  task.lifecycle!.activeCheck!.lastCheckedAt = "2026-01-02T00:00:00Z";
  assert.equal(
    selectReconciliationNotices([task], health, selected.cursor).notices.length,
    0,
  );
  task.lifecycle!.activeCheck!.state = "error";
  task.lifecycle!.activeCheck!.errorCount = 3;
  task.lifecycle!.activeCheck!.lastObservation = "private failure details";
  selected = selectReconciliationNotices([task], health, selected.cursor);
  assert.equal(selected.notices.length, 1);
  assert.ok(!selected.notices[0].message.includes("private failure"));
  task.lifecycle!.activeCheck!.errorCount = 4;
  assert.equal(
    selectReconciliationNotices([task], health, selected.cursor).notices.length,
    0,
  );
  task.lifecycle!.activeCheck!.state = "pending";
  task.lifecycle!.activeCheck!.errorCount = 0;
  selected = selectReconciliationNotices([task], health, selected.cursor);
  assert.match(selected.notices[0].message, /recover/i);
  task.lifecycle!.phase = "done";
  task.status = "closed";
  selected = selectReconciliationNotices([task], health, selected.cursor);
  assert.match(selected.notices[0].message, /completed/);
  assert.ok(!selected.cursor.knownTaskIds.includes(task.id));
});
test("wakeOn preferences suppress unrelated check results", () => {
  const task = issue();
  task.lifecycle!.activeCheck!.wakeOn = ["error"];
  const baseline = selectReconciliationNotices([task], health, null);
  task.lifecycle!.activeCheck!.state = "action_required";
  assert.equal(
    selectReconciliationNotices([task], health, baseline.cursor).notices.length,
    0,
  );
});
test("ten-notice cap leaves unseen changes unacknowledged", () => {
  const tasks = Array.from({ length: 14 }, (_, i) => issue(`jp-${i}`));
  const baseline = selectReconciliationNotices(tasks, health, null);
  tasks.forEach((task) => {
    task.lifecycle!.phase = "done";
    task.status = "closed";
  });
  const first = selectReconciliationNotices(tasks, health, baseline.cursor);
  assert.equal(first.notices.length, 10);
  assert.equal(first.cursor.knownTaskIds.length, 4);
  const second = selectReconciliationNotices(tasks, health, first.cursor);
  assert.equal(second.notices.length, 4);
  assert.equal(
    selectReconciliationNotices(tasks, health, second.cursor).notices.length,
    0,
  );
});
test("disappearance is not interpreted as completion", () => {
  const baseline = selectReconciliationNotices([issue()], health, null);
  const missing = selectReconciliationNotices([], health, baseline.cursor);
  assert.equal(missing.notices.length, 0);
  assert.deepEqual(missing.cursor.knownTaskIds, ["jp-1"]);
});
test("health warning and recovery deduplicate independently of heartbeat", () => {
  const down: DaemonHealth = {
    state: "incompatible",
    reason: "private protocol bytes",
  };
  const first = selectReconciliationNotices([], down, null);
  assert.equal(first.notices.length, 1);
  assert.ok(!first.notices[0].message.includes("private"));
  assert.equal(
    selectReconciliationNotices([], down, first.cursor).notices.length,
    0,
  );
  const recovered = selectReconciliationNotices([], health, first.cursor);
  assert.equal(recovered.notices.length, 1);
  assert.equal(
    selectReconciliationNotices(
      [],
      { ...health, heartbeatAt: "2026-01-02T00:00:00Z" },
      recovered.cursor,
    ).notices.length,
    0,
  );
});
test("oversized cursor explicitly rebaselines within 128 KiB", () => {
  const tasks = Array.from({ length: 2500 }, (_, i) =>
    issue(`jp-${i}-${"x".repeat(100)}`),
  );
  const first = selectReconciliationNotices(tasks, health, null);
  assert.ok(Buffer.byteLength(JSON.stringify(first.cursor)) <= 128 * 1024);
  assert.match(first.notices[0].message, /rebaseline|baseline/i);
  assert.equal(
    selectReconciliationNotices(tasks, health, first.cursor).notices.length,
    0,
  );
  assert.ok(readNoticeCursor(first.cursor));
  assert.equal(readNoticeCursor({ version: 2 }), null);
});

test("specific PR wakeOn reasons do not wake for unrelated attention outcomes", () => {
  const task = issue();
  task.lifecycle!.activeCheck!.kind = "github_pull_request";
  task.lifecycle!.activeCheck!.wakeOn = ["merge_conflict"];
  const baseline = selectReconciliationNotices([task], health, null);
  task.lifecycle!.activeCheck!.state = "action_required";
  task.lifecycle!.activeCheck!.lastObservation = "changes_requested";
  const quiet = selectReconciliationNotices([task], health, baseline.cursor);
  assert.equal(quiet.notices.length, 0);
  task.lifecycle!.activeCheck!.lastObservation = "merge_conflict";
  const attention = selectReconciliationNotices([task], health, quiet.cursor);
  assert.equal(attention.notices.length, 1);
});

test("claiming actionable work does not replay its archived check success", async () => {
  const { claimLifecycle, createActionableLifecycle, validateLifecycle } =
    await import("../task-lifecycle/model.js");
  const task = issue();
  const baseline = selectReconciliationNotices([task], health, null);
  const check = {
    ...task.lifecycle!.activeCheck!,
    state: "satisfied" as const,
  };
  task.lifecycle = createActionableLifecycle("2026-01-02T00:00:00Z");
  task.lifecycle.checkHistory.push(check);
  task.status = "open";
  validateLifecycle(task.lifecycle, {
    ...waitingTask(task.id),
    lifecycle: task.lifecycle,
    status: "open",
  });
  const success = selectReconciliationNotices([task], health, baseline.cursor);
  assert.equal(success.notices.length, 1);
  task.lifecycle = claimLifecycle(task.lifecycle, {
    operationId: "claim",
    sessionId: "fixture",
    now: "2026-01-02T00:00:00Z",
    expiresAt: "2026-01-03T00:00:00Z",
    resourceSnapshot: { observedAt: "2026-01-02T00:00:00Z", resourceIds: [] },
  });
  task.status = "in_progress";
  validateLifecycle(task.lifecycle, {
    ...waitingTask(task.id),
    lifecycle: task.lifecycle,
    status: "in_progress",
  });
  assert.equal(
    selectReconciliationNotices([task], health, success.cursor).notices.length,
    0,
  );
});
