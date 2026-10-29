import { legacyLifecycle } from "./task-lifecycle/legacy-test-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { BeadsIssue } from "./beads.js";
import { resolveWorkingIdentity } from "./session-identity.js";
import {
  A,
  B,
  P,
  Q,
  NEW,
  catalogFixture,
} from "./work-catalog/test-fixtures.js";

const SESSION = "11111111-1111-4111-8111-1111580c8e67";
const PAST = "2020-01-01T00:00:00.000Z";
function owned(
  id = "zz-owned",
  projectId = P,
  sessionId = SESSION,
): BeadsIssue {
  return {
    id,
    title: "Owned work",
    status: "in_progress",
    labels: [],
    description: "Private mission must not enter the identity DTO",
    projectReference: { kind: "valid", projectId },
    lifecycle: {
      version: 1,
      phase: "active",
      waiting: null,
      stateEnteredAt: PAST,
      lastProgressAt: PAST,
      execution: {
        sessionId,
        claimedAt: PAST,
        lastActivityAt: PAST,
        expiresAt: PAST,
        resourceSnapshot: { observedAt: PAST, resourceIds: [] },
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

test("identity follows the unique owned task across projects without copying mission data", () => {
  const c = catalogFixture();
  c.projects[Q].areaId = B;
  for (const projectId of [P, Q]) {
    const rows = [
      owned("zz-foreign", P, "other-session"),
      owned("zz-owned", projectId),
    ];
    const before = structuredClone({ c, rows });
    const project = c.projects[projectId];
    const area = c.areas[project.areaId!];
    assert.deepEqual(resolveWorkingIdentity(rows, c, SESSION), {
      kind: "assigned",
      taskId: "zz-owned",
      taskTitle: "Owned work",
      projectId,
      projectName: project.name,
      areaId: area.id,
      areaName: area.name,
    });
    assert.deepEqual({ c, rows }, before);
  }
});

test("past compatibility expiry does not end durable ownership", () => {
  assert.equal(
    resolveWorkingIdentity([owned()], catalogFixture(), SESSION).kind,
    "assigned",
  );
});

test("verified empty ownership is unassigned, including a new session ID", () => {
  const c = catalogFixture();
  assert.deepEqual(resolveWorkingIdentity([], c, SESSION), {
    kind: "unassigned",
  });
  assert.deepEqual(resolveWorkingIdentity([owned()], c, "new-session"), {
    kind: "unassigned",
  });
  const finished = owned();
  finished.status = "closed";
  finished.lifecycle!.phase = "done";
  legacyLifecycle(finished.lifecycle)!.execution = null;
  assert.deepEqual(resolveWorkingIdentity([finished], c, SESSION), {
    kind: "unassigned",
  });
});

test("duplicate owners and malformed active metadata are unavailable, not unassigned", () => {
  const c = catalogFixture();
  const malformed = {
    ...owned(),
    lifecycle: null,
    lifecycleWarning: "invalid lifecycle",
  };
  const missingExecution = owned();
  legacyLifecycle(missingExecution.lifecycle)!.execution = null;
  for (const rows of [
    [owned(), owned("zz-second", Q)],
    [malformed],
    [owned(), malformed],
    [missingExecution],
  ]) {
    assert.equal(resolveWorkingIdentity(rows, c, SESSION).kind, "unavailable");
  }
});

test("contradictory native status cannot silently end an active ownership", () => {
  const row = owned();
  row.status = "open";
  assert.equal(
    resolveWorkingIdentity([row], catalogFixture(), SESSION).kind,
    "unavailable",
  );
});

test("missing session ID or inactive catalog is unavailable", () => {
  const c = catalogFixture();
  assert.equal(resolveWorkingIdentity([], c, "").kind, "unavailable");
  c.state = "prepared";
  assert.equal(resolveWorkingIdentity([], c, SESSION).kind, "unavailable");
});

test("invalid, conflicting and unscoped membership never infers a working project", () => {
  const c = catalogFixture();
  for (const patch of [
    { projectReference: { kind: "invalid" as const, reason: "broken" } },
    { projectReference: { kind: "valid" as const, projectId: NEW } },
    { labels: ["workstream:maintenance"] },
    { projectReference: { kind: "absent" as const } },
  ]) {
    assert.equal(
      resolveWorkingIdentity([{ ...owned(), ...patch }], c, SESSION).kind,
      "unavailable",
    );
  }
  c.projects[P].areaId = null;
  assert.equal(
    resolveWorkingIdentity([owned()], c, SESSION).kind,
    "unavailable",
  );
});

test("registered legacy membership remains usable but display identity is never an input", () => {
  const row = owned();
  delete row.projectReference;
  row.labels = ["workstream:api"];
  assert.equal(
    resolveWorkingIdentity([row], catalogFixture(), SESSION).kind,
    "assigned",
  );
});

test("catalog renames and area moves change display only, including archived owned work", () => {
  const c = catalogFixture();
  c.projects[P].name = "Renamed API";
  c.projects[P].areaId = B;
  c.projects[P].archived = true;
  c.areas[B].archived = true;
  const row = owned();
  const before = structuredClone(row);
  const result = resolveWorkingIdentity([row], c, SESSION);
  assert.equal(result.kind, "assigned");
  if (result.kind !== "assigned") return;
  assert.equal(result.projectName, "Renamed API");
  assert.equal(result.areaName, c.areas[B].name);
  assert.notEqual(result.areaId, A);
  assert.deepEqual(row, before);
});
