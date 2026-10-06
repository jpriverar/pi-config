import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsIssue } from "../../lib/beads.js";
import {
  normalizeMetadata,
  runtimeTokens,
  selectTaskAssignment,
} from "./herdr-values.js";

const now = Date.parse("2026-10-06T12:00:00Z");
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

test("shows only the current session's authoritative unexpired claim", () => {
  assert.deepEqual(
    selectTaskAssignment([owned("other"), owned()], "session-1", now),
    {
      label: "Improve sidebar identity",
      expiresAt: Date.parse("2026-10-06T13:00:00Z"),
    },
  );
  assert.deepEqual(selectTaskAssignment([owned("other")], "session-1", now), {
    label: "Unassigned",
  });
  assert.deepEqual(selectTaskAssignment([], "session-1", now), {
    label: "Unassigned",
  });
});

test("does not turn unavailable or ambiguous ownership into Unassigned", () => {
  assert.deepEqual(selectTaskAssignment(undefined, "session-1", now), {
    label: "Task unavailable",
  });
  assert.deepEqual(selectTaskAssignment([owned(), owned()], "session-1", now), {
    label: "Task unavailable",
  });
  assert.deepEqual(selectTaskAssignment([owned()], "", now), {
    label: "Task unavailable",
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
      now,
    ),
    { label: "Task unavailable" },
  );
  assert.deepEqual(
    selectTaskAssignment([{ ...owned(), status: "open" }], "session-1", now),
    { label: "Task unavailable" },
  );
});

test("distinguishes exact expiry and invalid lease evidence", () => {
  assert.deepEqual(
    selectTaskAssignment(
      [owned("session-1", "2026-10-06T12:00:00Z")],
      "session-1",
      now,
    ),
    { label: "Lease expired" },
  );
  assert.deepEqual(
    selectTaskAssignment([owned("session-1", "not-a-date")], "session-1", now),
    { label: "Task unavailable" },
  );
  assert.deepEqual(
    selectTaskAssignment(
      [owned(), owned("session-1", "2026-10-06T11:00:00Z")],
      "session-1",
      now,
    ),
    { label: "Task unavailable" },
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
      now,
    ),
    { label: "Fix auth", expiresAt: now + 3_600_000 },
  );
  assert.deepEqual(
    selectTaskAssignment([{ ...owned(), title: "\n " }], "session-1", now),
    { label: "Task unavailable" },
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
