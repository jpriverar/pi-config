import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsIssue } from "../../lib/beads.js";
import * as values from "./herdr-values.js";
import type { TaskAssignment } from "./herdr-values.js";
import {
  normalizeMetadata,
  runtimeTokens,
  selectTaskAssignment,
  taskTokens,
} from "./herdr-values.js";

function owned(
  sessionId = "session-1",
  expiresAt = "2026-10-06T13:00:00Z",
): BeadsIssue {
  const at = "2026-10-06T11:00:00Z";
  return {
    id: "jp-example",
    title: "Improve sidebar identity",
    status: "in_progress",
    labels: [],
    lifecycle: {
      version: 1,
      phase: "active",
      waiting: null,
      stateEnteredAt: at,
      lastProgressAt: at,
      execution: {
        sessionId,
        claimedAt: at,
        lastActivityAt: at,
        expiresAt,
        resourceSnapshot: { observedAt: at, resourceIds: [] },
      },
      artifacts: [],
      activeCheck: null,
      checkHistory: [],
      transitionHistory: [],
      resources: [],
      disposition: null,
    },
  };
}

test("shows only the current session's authoritative active claim", () => {
  assert.deepEqual(
    selectTaskAssignment([owned("other"), owned()], "session-1"),
    {
      label: "Improve sidebar identity",
      state: "assigned",
      phase: "active",
      taskId: "jp-example",
    },
  );
  assert.deepEqual(selectTaskAssignment([owned("other")], "session-1"), {
    label: "Unassigned",
    state: "unassigned",
  });
  assert.deepEqual(selectTaskAssignment([], "session-1"), {
    label: "Unassigned",
    state: "unassigned",
  });
});

test("does not turn unavailable or ambiguous ownership into Unassigned", () => {
  assert.deepEqual(selectTaskAssignment(undefined, "session-1"), {
    label: "Task unavailable",
    state: "unavailable",
  });
  assert.deepEqual(selectTaskAssignment([owned(), owned()], "session-1"), {
    label: "Task unavailable",
    state: "unavailable",
  });
  assert.deepEqual(selectTaskAssignment([owned()], ""), {
    label: "Task unavailable",
    state: "unavailable",
  });
  assert.deepEqual(
    selectTaskAssignment(
      [
        {
          ...owned(),
          lifecycle: undefined,
          lifecycleWarning: "invalid metadata",
        },
      ],
      "session-1",
    ),
    { label: "Task unavailable", state: "unavailable" },
  );
  assert.deepEqual(
    selectTaskAssignment([{ ...owned(), status: "open" }], "session-1"),
    { label: "Task unavailable", state: "unavailable" },
  );
});

test("validates legacy timestamps without expiring ownership", () => {
  assert.deepEqual(
    selectTaskAssignment(
      [owned("session-1", "2026-10-06T12:00:00Z")],
      "session-1",
    ),
    {
      label: "Improve sidebar identity",
      state: "assigned",
      phase: "active",
      taskId: "jp-example",
    },
  );
  assert.deepEqual(
    selectTaskAssignment([owned("session-1", "not-a-date")], "session-1"),
    { label: "Task unavailable", state: "unavailable" },
  );
  assert.deepEqual(
    selectTaskAssignment(
      [owned(), owned("session-1", "2026-10-06T11:00:00Z")],
      "session-1",
    ),
    { label: "Task unavailable", state: "unavailable" },
  );
});

test("normalizes display text without terminal controls or broken Unicode", () => {
  assert.equal(
    normalizeMetadata(
      "\u001b]0;secret\u0007  Review\n  auth\u001b[31m now\u001b[0m ",
    ),
    "Review auth now",
  );
  assert.equal(normalizeMetadata("😀".repeat(81)), "😀".repeat(80));
  assert.deepEqual(
    selectTaskAssignment(
      [{ ...owned(), title: "\u001b[31mFix\n auth\u001b[0m" }],
      "session-1",
    ),
    {
      label: "Fix auth",
      state: "assigned",
      phase: "active",
      taskId: "jp-example",
    },
  );
  assert.deepEqual(
    selectTaskAssignment([{ ...owned(), title: "\n " }], "session-1"),
    { label: "Task unavailable", state: "unavailable" },
  );
});

for (const [percent, warning, critical] of [
  [74.99, null, null],
  [75, "Context 75%", null],
  [89.99, "Context 89%", null],
  [90, null, "Context 90%"],
  [101, null, "Context 101%"],
  [null, null, null],
  [NaN, null, null],
  [Infinity, null, null],
] as const) {
  test(`projects pressure at ${percent} without leaving the opposite severity set`, () => {
    assert.deepEqual(runtimeTokens({ id: "gpt-5.4" }, { percent }), {
      pi_model: "gpt-5.4",
      pi_context_warning: warning,
      pi_context_critical: critical,
    });
  });
}

test("uses the actual model name or ID and clears unknown session values", () => {
  assert.equal(
    runtimeTokens(
      { id: "claude-opus-4-6", name: "Claude Opus 4.6 (AI Gateway)" },
      undefined,
    ).pi_model,
    "Opus 4.6",
  );
  assert.equal(
    runtimeTokens({ id: "gpt-5.4-mini", name: " " }, undefined).pi_model,
    "gpt-5.4-mini",
  );
  assert.equal(runtimeTokens({ id: "gpt-5.4" }, undefined).pi_model, "gpt-5.4");
  assert.deepEqual(runtimeTokens(undefined, undefined), {
    pi_model: null,
    pi_context_warning: null,
    pi_context_critical: null,
  });
});

test("carries claim identity independently of task-title sentinel text", () => {
  for (const title of ["Unassigned", "Task unavailable", "Lease expired"]) {
    assert.deepEqual(
      selectTaskAssignment([{ ...owned(), title }], "session-1"),
      {
        label: title,
        state: "assigned",
        phase: "active",
        taskId: "jp-example",
      },
    );
  }
});

test("does not publish a normalized or truncated task identity", () => {
  for (const id of ["", " task ", "task\nname", "x".repeat(81)]) {
    assert.deepEqual(selectTaskAssignment([{ ...owned(), id }], "session-1"), {
      label: "Task unavailable",
      state: "unavailable",
    });
  }
});

for (const legacyExpiry of ["2026-10-06T12:00:00Z", "2026-09-29T12:00:00Z"]) {
  test(`durable typed assignment survives legacy expiry ${legacyExpiry}`, () => {
    assert.deepEqual(
      selectTaskAssignment([owned("session-1", legacyExpiry)], "session-1"),
      {
        state: "assigned",
        phase: "active",
        label: "Improve sidebar identity",
        taskId: "jp-example",
      },
    );
  });
}

for (const [assignment, sessionName, expected] of [
  [
    { state: "assigned", phase: "active", taskId: "jp-one", label: "Fix auth" },
    "api-12345678",
    "jp-one • Fix auth",
  ],
  [
    {
      state: "assigned",
      phase: "active",
      taskId: "jp-one",
      label: "Unassigned",
    },
    "api-12345678",
    "jp-one • Unassigned",
  ],
  [
    { state: "unassigned", label: "Unassigned" },
    "unassigned-12345678",
    "unassigned-12345678",
  ],
  [{ state: "unassigned", label: "Unassigned" }, undefined, "Unassigned"],
  [{ state: "unassigned", label: "Unassigned" }, "\u001b[31m \n", "Unassigned"],
  [
    { state: "unavailable", label: "Task unavailable" },
    "api-12345678",
    "Task unavailable",
  ],
] satisfies [TaskAssignment, string | undefined, string][]) {
  test(`native pane label distinguishes ${assignment.state}: ${expected}`, () => {
    assert.equal(typeof values.taskPaneLabel, "function");
    assert.equal(values.taskPaneLabel(assignment, sessionName), expected);
  });
}

test("native pane label strips controls and bounds the whole ID/title without breaking Unicode", () => {
  assert.equal(typeof values.taskPaneLabel, "function");
  assert.equal(
    values.taskPaneLabel(
      {
        state: "assigned",
        phase: "active",
        taskId: "jp-one",
        label: "\u001b[31mFix\n auth\u001b[0m",
      },
      undefined,
    ),
    "jp-one • Fix auth",
  );
  assert.equal(
    values.taskPaneLabel(
      {
        state: "assigned",
        phase: "active",
        taskId: "jp-one",
        label: "😀".repeat(90),
      },
      undefined,
    ),
    "jp-one • " + "😀".repeat(71),
  );
});

test("task placement tokens normalize labels and clear absent catalog identity", () => {
  const assignment = {
    state: "assigned" as const,
    phase: "active" as const,
    label: "Owned",
    taskId: "jp-one",
    project: "\u001b[31mAPI\n v2\u001b[0m",
    area: "🧰".repeat(90),
  };
  assert.equal(taskTokens(assignment).pi_project, "API v2");
  assert.equal(taskTokens(assignment).pi_area, "🧰".repeat(80));
  const missing = taskTokens({ ...assignment, project: " ", area: undefined });
  assert.equal(missing.pi_project, null);
  assert.equal(missing.pi_area, null);
});

test("durable task tokens clear obsolete deadline metadata", () => {
  const assignment = {
    state: "assigned" as const,
    phase: "active" as const,
    label: "Owned",
    taskId: "jp-one",
    expiresAt: 2000,
  };
  assert.equal(taskTokens(assignment).pi_task_expires_at, null);
});

test("completed v2 work keeps its assignment until explicit release", async () => {
  const { state, OWNER, NOW } = await import(
    "../../lib/task-lifecycle/v2-test-fixtures.js"
  );
  const lifecycle = state({
    phase: "done",
    owner: OWNER,
    disposition: {
      kind: "completed",
      reason: "Delivered",
      at: NOW,
      evidenceArtifactIds: [],
    },
  });
  const result = selectTaskAssignment(
    [
      {
        id: "jp-held",
        title: "Retained ownership",
        status: "closed",
        labels: [],
        lifecycle,
      },
    ],
    OWNER.sessionId,
  );
  assert.equal(result.state, "assigned");
  assert.equal(taskTokens(result).pi_task_phase, "done");
  assert.equal(taskTokens(result).pi_task_status, "Done");
});

for (const [phase, status] of [
  ["active", "In progress"],
  ["actionable", "Ready to resume"],
  ["waiting", "Blocked"],
  ["deferred", "Deferred"],
  ["done", "Done"],
] as const) {
  test(`v2 assignment and display phase are independent for ${phase}`, async () => {
    const { state, withCheck, OWNER, NOW } = await import(
      "../../lib/task-lifecycle/v2-test-fixtures.js"
    );
    const { blockLifecycleV2, fingerprintConditionV2, nativeStatusV2 } =
      await import("../../lib/task-lifecycle/v2-model.js");
    const current = withCheck();
    const lifecycle =
      phase === "waiting"
        ? blockLifecycleV2(current, {
            operationId: "pause",
            sessionId: OWNER.sessionId,
            now: NOW,
            reason: "Wait",
            conditionFingerprint: fingerprintConditionV2(current, [])!,
          })
        : state({
            phase,
            owner: OWNER,
            disposition:
              phase === "done"
                ? {
                    kind: "completed",
                    reason: "Done",
                    at: NOW,
                    evidenceArtifactIds: [],
                  }
                : null,
          });
    const issue: BeadsIssue = {
      id: "jp-held",
      title: "Owned mission",
      status: nativeStatusV2(lifecycle),
      labels: [],
      lifecycle,
    };
    const assignment = selectTaskAssignment([issue], OWNER.sessionId);
    assert.equal(assignment.state, "assigned");
    const paneValues = taskTokens(assignment);
    assert.equal(paneValues.pi_task_id, "jp-held");
    assert.equal(paneValues.pi_task, "Owned mission");
    assert.equal(paneValues.pi_task_phase, phase);
    assert.equal(paneValues.pi_task_status, status);
    if (phase !== "active") {
      const released = selectTaskAssignment(
        [{ ...issue, lifecycle: { ...lifecycle, owner: null } }],
        OWNER.sessionId,
      );
      assert.equal(released.state, "unassigned");
      assert.equal(taskTokens(released).pi_task_phase, null);
      assert.equal(taskTokens(released).pi_task_status, null);
    }
  });
}

test("assignment availability alone does not invent a lifecycle phase", () => {
  const paneValues = taskTokens({
    state: "assigned",
    taskId: "jp-held",
    label: "Known owner",
  });
  assert.equal(paneValues.pi_task_state, "assigned");
  assert.equal(paneValues.pi_task_phase, null);
  assert.equal(paneValues.pi_task_status, null);
});
