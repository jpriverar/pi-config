import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeTaskUpdate } from "./service.js";

function update(nextStep: unknown) {
  return normalizeTaskUpdate({
    addLabels: [],
    removeLabels: [],
    nextStep: nextStep as string | null,
  });
}

test("normalizes a current action without requiring label changes", () => {
  assert.deepEqual(update("  Check staging for abc123  "), {
    addLabels: [],
    removeLabels: [],
    nextStep: "Check staging for abc123",
  });
});

test("distinguishes clearing an action from an omitted update", () => {
  assert.deepEqual(update(null), {
    addLabels: [],
    removeLabels: [],
    nextStep: null,
  });
  assert.throws(() => update(undefined), /at least one change/);
  assert.deepEqual(
    normalizeTaskUpdate({ addLabels: ["needs:jp"], removeLabels: [] }),
    { addLabels: ["needs:jp"], removeLabels: [] },
  );
});

for (const [name, value] of [
  ["empty", ""],
  ["blank", "   "],
  ["newline", "Check\nstaging"],
  ["leading newline", "\nCheck staging"],
  ["terminal escape", "Check\u001b[2J"],
  ["C1 control", "Check\u009bstaging"],
  ["number", 1],
  ["object", { action: "Check staging" }],
  ["array", ["Check staging"]],
  ["oversized", "a".repeat(2001)],
] as const) {
  test(`rejects ${name} next steps before storage`, () => {
    assert.throws(() => update(value), /next_step/);
  });
}

test("counts Unicode code points rather than UTF-16 units", () => {
  const value = "🔎".repeat(2000);
  assert.equal(update(value).nextStep, value);
  assert.throws(() => update(value + "x"), /next_step/);
});

for (const description of ["", " ", "Goal\nFinish", 42]) {
  test(`rejects invalid description ${JSON.stringify(description)}`, () => {
    assert.throws(
      () =>
        normalizeTaskUpdate({
          addLabels: [],
          removeLabels: [],
          description: description as string,
        }),
      /description/,
    );
  });
}
