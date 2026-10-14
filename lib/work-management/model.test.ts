import { summarizeWorkManagement } from "./model.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWorkManagement, newWorkManagementState } from "./model.js";
import { target } from "./test-fixtures.js";
import { createActionableLifecycle } from "../task-lifecycle/model.js";
import type { LifecycleCheck } from "../task-lifecycle/types.js";

test("state validation preserves binding and rejects malformed persisted receipts", () => {
  const state = newWorkManagementState(target, "title", "description");
  assert.deepEqual(decodeWorkManagement(state), state);
  assert.equal(decodeWorkManagement(undefined), null);
  for (const invalid of [
    null,
    {},
    { ...state, version: 2 },
    { ...state, deliveredCommentIds: ["x", "x"] },
    { ...state, inFlight: { kind: "delete" } },
    { ...state, remote: { id: "x", url: "https://github.com/unsafe" } },
  ]) {
    assert.throws(() => decodeWorkManagement(invalid));
  }
});

test("creation metadata is validated and captured without changing legacy records", () => {
  const configured = {
    ...target,
    assigneeId: "11111111-1111-1111-1111-111111111111",
    workstreamAttributeKey: "pi_workstream",
  };
  const state = newWorkManagementState(configured, "task", "why", "pi-setup");
  configured.assigneeId = "22222222-2222-2222-2222-222222222222";
  configured.workstreamAttributeKey = "changed";
  const decoded = decodeWorkManagement(state)!;
  assert.equal(
    decoded.target.assigneeId,
    "11111111-1111-1111-1111-111111111111",
  );
  assert.equal(decoded.target.workstreamAttributeKey, "pi_workstream");
  assert.equal(decoded.initial.workstream, "pi-setup");
  const legacy = decodeWorkManagement(
    newWorkManagementState(target, "task", "why"),
  )!;
  assert.equal(legacy.target.assigneeId, undefined);
  assert.equal(legacy.target.workstreamAttributeKey, undefined);
  assert.deepEqual(legacy.initial, { title: "task", description: "why" });
  for (const invalid of [
    { ...state, target: { ...state.target, assigneeId: "not-a-uuid" } },
    { ...state, target: { ...state.target, assigneeId: null } },
    { ...state, target: { ...state.target, workstreamAttributeKey: "" } },
    { ...state, initial: { ...state.initial, workstream: "" } },
    { ...state, initial: { ...state.initial, workstream: 42 } },
  ])
    assert.throws(() => decodeWorkManagement(invalid));
});

test("optional PR-wait mapping survives snapshots and validates its status", () => {
  const configured = {
    ...target,
    statuses: { ...target.statuses, waitingOnPullRequest: "In Review" },
  };
  const state = newWorkManagementState(configured, "task", "why");
  assert.equal(state.target.statuses.waitingOnPullRequest, "In Review");
  configured.statuses.waitingOnPullRequest = "Changed";
  assert.equal(
    decodeWorkManagement(state)?.target.statuses.waitingOnPullRequest,
    "In Review",
  );
  for (const invalid of [null, "", "Bad\nStatus", 42]) {
    assert.throws(() =>
      newWorkManagementState(
        {
          ...target,
          statuses: { ...target.statuses, waitingOnPullRequest: invalid },
        } as unknown as typeof target,
        "task",
        "why",
      ),
    );
  }
});

test("summary uses the PR override only for PR-check waits", () => {
  const at = "2026-10-14T10:00:00Z";
  const lifecycle = createActionableLifecycle(at);
  const check: LifecycleCheck = {
    id: "review",
    kind: "github_pull_request",
    targetArtifactIds: [],
    predicate: { mode: "all" },
    onSatisfied: "close",
    wakeOn: [],
    state: "pending",
    createdAt: at,
    lastCheckedAt: null,
    nextCheckAt: at,
    lastObservation: null,
    errorCount: 0,
  };
  const state = newWorkManagementState(
    {
      ...target,
      statuses: {
        ...target.statuses,
        waiting: "Blocked",
        waitingOnPullRequest: "In Review",
      },
    },
    "task",
    "why",
  );
  state.remote = {
    id: "case-1",
    url: "https://app.datadoghq.com/cases/case-1",
  };
  lifecycle.phase = "waiting";
  lifecycle.waiting = { kind: "check" };
  lifecycle.activeCheck = check;
  state.lastSentStatus = "Blocked";
  const summary = () =>
    summarizeWorkManagement({ piWorkManagement: state }, lifecycle)?.text;
  assert.equal(summary(), "WM pending status");
  state.lastSentStatus = "In Review";
  assert.equal(summary(), "WM linked");
  for (const kind of ["manual", "time"] as const) {
    lifecycle.activeCheck = { ...check, kind };
    state.lastSentStatus = "Blocked";
    assert.equal(summary(), "WM linked");
  }
  lifecycle.activeCheck = null;
  lifecycle.waiting = { kind: "dependency" };
  assert.equal(summary(), "WM linked");
  lifecycle.phase = "active";
  lifecycle.waiting = { kind: "check" };
  lifecycle.activeCheck = check;
  state.lastSentStatus = "In Progress";
  assert.equal(summary(), "WM linked");
  lifecycle.phase = "waiting";
  delete state.target.statuses.waitingOnPullRequest;
  state.lastSentStatus = "Blocked";
  assert.equal(summary(), "WM linked");
});

test("summary exposes pending and attention without trusting stored URLs", () => {
  assert.equal(summarizeWorkManagement({}, null), null);
  const state = newWorkManagementState(
    target,
    "private title",
    "private description",
  );
  assert.deepEqual(summarizeWorkManagement({ piWorkManagement: state }, null), {
    text: "WM pending create",
    auth: {
      command: `dd-auth --org-uuid ${target.orgUuid} --site datadoghq.com -- true`,
      required: false,
    },
  });
  state.remote = { id: "case-1", url: "https://github.com/unsafe" };
  assert.deepEqual(summarizeWorkManagement({ piWorkManagement: state }, null), {
    text: "WM attention: invalid state",
  });
  state.remote = {
    id: "case-1",
    url: "https://app.datadoghq.com/cases/case-1",
  };
  state.failure = {
    kind: "attention",
    code: "hostile <instruction>",
    count: 1,
    retryAt: null,
  };
  assert.deepEqual(summarizeWorkManagement({ piWorkManagement: state }, null), {
    text: "WM attention",
    auth: {
      command: `dd-auth --org-uuid ${target.orgUuid} --site datadoghq.com -- true`,
      required: false,
    },
    url: "https://app.datadoghq.com/cases/case-1",
  });
});
