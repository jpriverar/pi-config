import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { createPaneReporter } from "./herdr-pane.js";
import type { PaneTokens } from "./herdr-values.js";

function harness(
  options: {
    mode?: string;
    send?: (
      values: PaneTokens,
      seq: number,
      signal: AbortSignal,
    ) => Promise<boolean>;
  } = {},
) {
  const sent: Array<{ values: PaneTokens; seq: number }> = [];
  let percent: number | null = 12;
  let model = "model-one";
  const context = {
    mode: options.mode ?? "tui",
    model: { id: model },
    getContextUsage: () => ({ percent }),
  } as any;
  const reporter = createPaneReporter({
    context,
    send: async (values, seq, signal) => {
      sent.push({ values: { ...values }, seq });
      return options.send ? options.send(values, seq, signal) : true;
    },
  });
  return {
    reporter,
    context,
    sent,
    runtime: (name: string, value: number | null) => {
      model = name;
      context.model = { id: model };
      percent = value;
      reporter?.updateRuntime(context);
    },
  };
}

test("initializes current runtime without falsely claiming Unassigned", async () => {
  const h = harness();
  await setImmediate();
  assert.deepEqual(h.sent[0].values, {
    pi_model: "model-one",
    pi_task: "Task unavailable",
    pi_task_state: "unavailable",
    pi_task_id: null,
    pi_task_expires_at: null,
    pi_context_warning: null,
    pi_context_critical: null,
  });
  h.reporter!.updateTask({
    state: "assigned",
    taskId: "jp-task",
    label: "Review auth",
  });
  await setImmediate();
  assert.equal(h.sent.at(-1)!.values.pi_task, "Review auth");
  h.runtime("model-two", 90);
  await setImmediate();
  assert.equal(h.sent.at(-1)!.values.pi_model, "model-two");
  assert.equal(h.sent.at(-1)!.values.pi_context_critical, "Context 90%");
  h.runtime("model-two", null);
  await setImmediate();
  assert.equal(h.sent.at(-1)!.values.pi_context_critical, null);
  await h.reporter!.stop();
});

for (const mode of ["rpc", "json", "print"]) {
  test(`headless ${mode} cannot report or clean up its parent's pane`, async () => {
    const h = harness({ mode });
    await setImmediate();
    assert.equal(h.reporter, undefined);
    assert.deepEqual(h.sent, []);
  });
}

test("suppresses unchanged data and serializes bursts to the latest value", async () => {
  let finish!: (success: boolean) => void;
  let calls = 0;
  const h = harness({
    send: () =>
      ++calls === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(true),
  });
  h.runtime("superseded", 76);
  h.runtime("latest", 91);
  h.reporter!.updateTask({
    state: "assigned",
    taskId: "jp-task",
    label: "Current task",
  });
  assert.equal(h.sent.length, 1);
  finish(true);
  await setImmediate();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].values, {
    pi_model: "latest",
    pi_task: "Current task",
    pi_task_state: "assigned",
    pi_task_id: "jp-task",
    pi_task_expires_at: null,
    pi_context_warning: null,
    pi_context_critical: "Context 91%",
  });
  h.runtime("latest", 91);
  h.reporter!.updateTask({
    state: "assigned",
    taskId: "jp-task",
    label: "Current task",
  });
  await setImmediate();
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent[1].seq > h.sent[0].seq);
  await h.reporter!.stop();
});

test("failed delivery waits for a meaningful refresh instead of spinning", async () => {
  const h = harness({ send: async () => false });
  await setImmediate();
  assert.equal(h.sent.length, 1);
  await setImmediate();
  assert.equal(h.sent.length, 1);
  h.runtime("model-one", 12);
  await setImmediate();
  assert.equal(h.sent.length, 2);
  await h.reporter!.stop();
});

test("shutdown clears owned metadata and suppresses later updates", async () => {
  const h = harness();
  h.reporter!.updateTask({
    state: "assigned",
    taskId: "jp-one",
    label: "Owned",
  });
  await setImmediate();
  assert.equal(h.sent.at(-1)!.values.pi_task, "Owned");
  await h.reporter!.stop();
  h.reporter!.updateTask({
    state: "assigned",
    taskId: "jp-one",
    label: "Stale",
  });
  h.runtime("stale", 99);
  await setImmediate();
  assert.deepEqual(h.sent.at(-1)!.values, {
    pi_model: null,
    pi_task: null,
    pi_task_state: null,
    pi_task_id: null,
    pi_task_expires_at: null,
    pi_context_warning: null,
    pi_context_critical: null,
  });
});

test("stop cancels an in-flight send before clearing only owned keys", async () => {
  let first = true;
  const h = harness({
    send: async (_tokens, _seq, signal) => {
      if (!first) return true;
      first = false;
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(false), { once: true }),
      );
    },
  });
  await h.reporter!.stop();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(Object.keys(h.sent[1].values).sort(), [
    "pi_context_critical",
    "pi_context_warning",
    "pi_model",
    "pi_task",
    "pi_task_expires_at",
    "pi_task_id",
    "pi_task_state",
  ]);
  assert.ok(h.sent[1].seq > h.sent[0].seq);
  assert.ok(Object.values(h.sent[1].values).every((value) => value === null));
  await h.reporter!.stop();
  assert.equal(h.sent.length, 2);
});

test("clears claim identity whenever ownership becomes non-assigned", async () => {
  const h = harness();
  for (const state of ["unassigned", "unavailable"] as const) {
    h.reporter!.updateTask({
      state: "assigned",
      label: "Unassigned",
      taskId: "jp-owned",
    });
    await setImmediate();
    assert.equal(h.sent.at(-1)!.values.pi_task_id, "jp-owned");
    assert.equal(h.sent.at(-1)!.values.pi_task_expires_at, null);
    h.reporter!.updateTask({ state, label: "No active claim" });
    await setImmediate();
    assert.equal(h.sent.at(-1)!.values.pi_task_state, state);
    assert.equal(h.sent.at(-1)!.values.pi_task_id, null);
    assert.equal(h.sent.at(-1)!.values.pi_task_expires_at, null);
  }
  await h.reporter!.stop();
});

test("durable typed assignment does not arm an expiry timer", async (t) => {
  const h = harness();
  await setImmediate();
  const timers = t.mock.method(globalThis, "setTimeout");
  try {
    const assignment = {
      state: "assigned" as const,
      label: "Owned",
      taskId: "jp-one",
      expiresAt: Date.now() + 1000,
    };
    h.reporter!.updateTask(assignment);
    assert.equal(timers.mock.callCount(), 0);
    await setImmediate();
    assert.equal(h.sent.at(-1)!.values.pi_task, "Owned");
  } finally {
    await h.reporter!.stop();
  }
});
