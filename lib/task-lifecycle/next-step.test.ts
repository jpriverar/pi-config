import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeTaskUpdate } from "./service.js";
import { readNextStep } from "./next-step.js";

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

test("reads missing, cleared and valid metadata without changing it", () => {
  assert.deepEqual(readNextStep({}), { value: null });
  assert.deepEqual(readNextStep({ next_step: null }), { value: null });
  const metadata = { next_step: "  Verify the outcome  " };
  assert.deepEqual(readNextStep(metadata), { value: "Verify the outcome" });
  assert.equal(metadata.next_step, "  Verify the outcome  ");
  assert.deepEqual(readNextStep(Object.create({ next_step: "inherited" })), {
    value: null,
  });
});

for (const value of [42, {}, [], "", "\ncheck", "x".repeat(2001)]) {
  test(`reports invalid stored next_step of type ${typeof value}`, () => {
    const result = readNextStep({ next_step: value });
    assert.equal(result.value, null);
    assert.match(result.warning ?? "", /next_step/);
  });
}
