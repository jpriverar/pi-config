import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWorkManagement, newWorkManagementState } from "./model.js";
import { target } from "./test-fixtures.js";

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
    { ...state, remote: { id: "x", url: "https://attacker.example" } },
  ]) {
    assert.throws(() => decodeWorkManagement(invalid));
  }
});
