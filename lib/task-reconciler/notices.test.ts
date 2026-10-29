import { legacyLifecycle } from "../task-lifecycle/legacy-test-fixtures.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BeadsIssue } from "../beads.js";
import type { DaemonHealth } from "./health.js";
import { waitingTask } from "./test-fixtures.js";
import { selectReconciliationNotices, readNoticeCursor } from "./notices.js";
const health: DaemonHealth = {
  state: "available",
  protocolVersion: 2,
  supportedLifecycleVersions: [1, 2],
  lifecycleWriteVersion: 1,
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
    lifecycle: legacyLifecycle(task.lifecycle),
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
  task.lifecycle!.activeCheck!.lastObservation =
    "at predicate must be an RFC3339 timestamp";
  selected = selectReconciliationNotices([task], health, selected.cursor);
  assert.equal(selected.notices.length, 1);
  assert.ok(
    selected.notices[0].message.includes(
      "at predicate must be an RFC3339 timestamp",
    ),
  );
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
test("unavailable health notices retain the recorded reason", () => {
  for (const reason of [
    "setup_required",
    "health_read_timeout",
    "daemon unavailable (unsafe_path)",
  ]) {
    const result = selectReconciliationNotices(
      [],
      { state: "unavailable", reason },
      null,
    );
    assert.match(result.notices[0].message, /unavailable/);
    assert.ok(result.notices[0].message.includes(reason));
    assert.match(result.notices[0].message, /\/task-reconciler status/);
  }
});

test("running daemon notices identify queue diagnostics and affected tasks", () => {
  const task = issue();
  task.title = "Ship notification visibility";
  const unhealthy = structuredClone(health);
  unhealthy.queue.diagnostics = [
    {
      taskId: task.id,
      code: "local_reconciliation_failed",
      count: 2,
      lastSeenAt: health.heartbeatAt,
    },
    { code: "scan_failed", count: 1, lastSeenAt: health.heartbeatAt },
  ];
  const before = structuredClone({ task, unhealthy });
  const first = selectReconciliationNotices([task], unhealthy, null);
  assert.equal(first.notices.length, 1);
  const message = first.notices[0].message;
  for (const detail of [
    task.id,
    task.title,
    "local_reconciliation_failed",
    "scan_failed",
  ]) {
    assert.ok(message.includes(detail), message);
  }
  assert.deepEqual(message.split("\n").slice(1), [
    "  - jp-1 — Ship notification visibility: local_reconciliation_failed",
    "  - scan_failed",
    "",
    "Use /task-reconciler status for details.",
  ]);
  assert.doesNotMatch(message, /setup|installation|activation/);
  assert.deepEqual({ task, unhealthy }, before);
  unhealthy.queue.diagnostics[0].count++;
  unhealthy.queue.diagnostics[0].lastSeenAt = "2026-01-02T00:00:00Z";
  assert.equal(
    selectReconciliationNotices([task], unhealthy, first.cursor).notices.length,
    0,
  );
});

test("queue summaries bound the displayed entries and disclose omitted diagnostics", () => {
  const unhealthy = structuredClone(health);
  unhealthy.queue.diagnostics = Array.from({ length: 5 }, (_, i) => ({
    taskId: `jp-${i}`,
    code: "local_reconciliation_failed",
    count: 1,
    lastSeenAt: health.heartbeatAt,
  }));
  const message = selectReconciliationNotices([], unhealthy, null).notices[0]
    .message;
  assert.match(message, /jp-0/);
  assert.match(message, /jp-2/);
  assert.doesNotMatch(message, /jp-3|jp-4/);
  assert.deepEqual(
    message.split("\n").filter((line) => line.startsWith("  - ")),
    [
      "  - jp-0: local_reconciliation_failed",
      "  - jp-1: local_reconciliation_failed",
      "  - jp-2: local_reconciliation_failed",
      "  - 2 more",
    ],
  );
  assert.match(message, /\/task-reconciler status/);
});

test("stale health notices show the last heartbeat and any queue diagnostic", () => {
  const stale = { ...structuredClone(health), state: "stale" as const };
  stale.queue.diagnostics = [
    { code: "scan_failed", count: 1, lastSeenAt: health.heartbeatAt },
  ];
  const message = selectReconciliationNotices([], stale, null).notices[0]
    .message;
  assert.match(message, /heartbeat.*stale/);
  assert.ok(message.includes(health.heartbeatAt));
  assert.ok(message.split("\n").includes("  - scan_failed"));
  assert.doesNotMatch(message, /setup|installation|activation/);
});

test("attention notices show task context and the observation without changing state", () => {
  const task = issue();
  task.title = "Publish the package";
  const check = task.lifecycle!.activeCheck!;
  check.state = "action_required";
  for (const reason of [
    "merge_conflict",
    "changes_requested",
    "closed_unmerged",
    "A manual decision is required",
  ]) {
    check.lastObservation = reason;
    const before = structuredClone(task);
    const first = selectReconciliationNotices([task], health, null);
    const message = first.notices[0].message;
    for (const detail of [task.id, task.title, reason])
      assert.ok(message.includes(detail), message);
    assert.deepEqual(task, before);
    assert.equal(
      selectReconciliationNotices([task], health, first.cursor).notices.length,
      0,
    );
  }
});

test("attention notices preserve archived check reasons and disclose missing reasons", () => {
  const task = issue();
  const check = task.lifecycle!.activeCheck!;
  check.state = "action_required";
  check.lastObservation = "merge_conflict";
  task.lifecycle!.checkHistory.push(check);
  task.lifecycle!.activeCheck = null;
  assert.match(
    selectReconciliationNotices([task], health, null).notices[0].message,
    /merge_conflict/,
  );
  for (const reason of [null, "  "]) {
    check.lastObservation = reason;
    const message = selectReconciliationNotices([task], health, null).notices[0]
      .message;
    assert.match(message, /no reason recorded/i);
    assert.match(message, /\/tasks/);
  }
});

test("diagnostic text is bounded and cannot inject terminal controls", () => {
  const task = issue();
  const escape = String.fromCharCode(27);
  task.title = `${escape}[31mShip visibility${escape}[0m\n${"x".repeat(1000)}`;
  const check = task.lifecycle!.activeCheck!;
  check.state = "action_required";
  check.lastObservation = `${escape}[31mmerge_conflict${escape}[0m\n${"y".repeat(1000)}`;
  const message = selectReconciliationNotices([task], health, null).notices[0]
    .message;
  assert.match(message, /Ship visibility/);
  assert.match(message, /merge_conflict/);
  assert.ok(!message.includes(escape));
  assert.ok(!message.includes("\n"));
  assert.ok(message.length < 600);
  assert.match(message, /…/);
  const down = selectReconciliationNotices(
    [],
    { state: "unavailable", reason: check.lastObservation },
    null,
  ).notices[0].message;
  assert.match(down, /merge_conflict/);
  assert.ok(!down.includes(escape));
  assert.ok(!down.includes("\n"));
  assert.ok(down.length < 400);
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

test("login-needed notices give the target-specific stock command once per org until recovery", async () => {
  const { newWorkManagementState, summarizeWorkManagement } = await import(
    "../work-management/model.js"
  );
  const { target } = await import("../work-management/test-fixtures.js");
  const state = newWorkManagementState(
    target,
    "private title",
    "private description",
  );
  state.failure = {
    kind: "retryable",
    code: "authentication_required",
    count: 1,
    retryAt: 1,
  };
  const tasks = () =>
    [issue("jp-auth-1"), issue("jp-auth-2")].map((t) => ({
      ...t,
      workManagement: summarizeWorkManagement(
        { piWorkManagement: state },
        t.lifecycle!,
      )!,
    }));
  const first = selectReconciliationNotices(tasks(), health, null);
  assert.equal(first.notices.length, 1);
  assert.match(first.notices[0].message, /Datadog login needed/);
  assert.ok(
    first.notices[0].message.includes(
      `dd-auth --org-uuid ${target.orgUuid} --site datadoghq.com -- true`,
    ),
  );
  assert.ok(!first.notices[0].message.includes("private"));
  assert.ok(readNoticeCursor(first.cursor));
  assert.match(tasks()[0].workManagement.text, /login needed/);
  state.failure.count++;
  state.failure.retryAt = 2;
  assert.equal(
    selectReconciliationNotices(tasks(), health, first.cursor).notices.length,
    0,
  );
  state.failure = null;
  const recovered = selectReconciliationNotices(tasks(), health, first.cursor);
  state.failure = {
    kind: "retryable",
    code: "authentication_required",
    count: 1,
    retryAt: 1,
  };
  assert.equal(
    selectReconciliationNotices(tasks(), health, recovered.cursor).notices
      .length,
    1,
  );
});

test("optional manual reminders are evaluated and deduplicated without polling", () => {
  const task = issue();
  const check = task.lifecycle!.activeCheck!;
  check.kind = "manual";
  check.wakeOn = ["manual"];
  check.predicate = { description: "Await approved evidence" };
  check.nextCheckAt = null;
  check.lastCheckedAt = null;
  const baseline = selectReconciliationNotices([task], health, null);
  assert.equal(baseline.notices.length, 0);
  check.predicate.reviewAt = "2999-01-01T00:00:00Z";
  const future = selectReconciliationNotices([task], health, baseline.cursor);
  assert.equal(future.notices.length, 0);
  check.predicate.reviewAt = "2000-01-01T00:00:00Z";
  const overdue = selectReconciliationNotices([task], health, future.cursor);
  assert.equal(overdue.notices.length, 1);
  assert.match(overdue.notices[0].message, /manual review is overdue/);
  assert.equal(
    selectReconciliationNotices([task], health, overdue.cursor).notices.length,
    0,
  );
  assert.equal(check.state, "pending");
  assert.equal(check.lastCheckedAt, null);
  assert.equal(check.nextCheckAt, null);
});
