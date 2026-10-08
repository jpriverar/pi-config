import { summarizeWorkManagement } from "./model.js";
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
    { ...state, remote: { id: "x", url: "https://github.com/unsafe" } },
  ]) {
    assert.throws(() => decodeWorkManagement(invalid));
  }
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
