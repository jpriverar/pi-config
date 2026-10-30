import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionableLifecycle } from "./model.js";
import { ownerOf } from "./ownership.js";
import { NOW, OWNER, state } from "./v2-test-fixtures.js";

test("v2 ownership survives every work phase", () => {
  for (const phase of [
    "active",
    "actionable",
    "waiting",
    "deferred",
    "done",
  ] as const) {
    assert.deepEqual(ownerOf(state({ phase, owner: OWNER })), OWNER);
  }
});

test("legacy ownership ignores lease expiry but rejects contradictory phases", () => {
  const legacy = createActionableLifecycle(NOW);
  const execution = {
    ...OWNER,
    expiresAt: "2020-01-01T00:00:00.000Z",
    resourceSnapshot: { observedAt: NOW, resourceIds: [] },
  };
  assert.deepEqual(ownerOf({ ...legacy, phase: "active", execution }), OWNER);
  assert.throws(
    () => ownerOf({ ...legacy, phase: "waiting", execution }),
    /owner|execution/,
  );
  assert.throws(
    () => ownerOf({ ...legacy, phase: "active" }),
    /owner|execution/,
  );
});

test("absence is distinct from contradictory active ownership", () => {
  assert.equal(ownerOf(null), null);
  assert.equal(ownerOf(undefined), null);
  assert.equal(ownerOf(state()), null);
  assert.throws(() => ownerOf(state({ phase: "active" })), /owner/);
});
