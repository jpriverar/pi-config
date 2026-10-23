import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { WakeupController, type WakeupRequest } from "../lib/wakeups.js";

const START = Date.UTC(2026, 1, 1);
const request: WakeupRequest = {
  delaySeconds: 60,
  reason: "The requested operation is pending",
  prompt: "Check operation run-123 and report its current state",
};

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const sent: string[] = [];
  const notices: string[] = [];
  let ready = true;
  let rejectDelivery = false;
  const wakeups = new WakeupController({
    canDeliver: () => ready,
    deliver: (item) => {
      sent.push(item.id);
      if (rejectDelivery) throw new Error("delivery rejected");
    },
    changed: () => {},
    notify: (message) => notices.push(message),
  });
  t.after(() => wakeups.reset());
  return {
    wakeups,
    sent,
    notices,
    ready: (value: boolean) => {
      ready = value;
    },
    rejectDelivery: () => {
      rejectDelivery = true;
    },
    tick: (ms: number) => t.mock.timers.tick(ms),
  };
}

test("one-shot delivery waits until due and consumes the pending entry", (t) => {
  const h = setup(t);
  const armed = h.wakeups.schedule(request);
  assert.equal(armed.pending?.dueAt, START + 60_000);
  assert.equal(armed.deadline, START + 3_600_000);
  h.tick(59_999);
  assert.deepEqual(h.sent, []);
  h.tick(1);
  assert.deepEqual(h.sent, [armed.pending!.id]);
  assert.equal(h.wakeups.inspect().pending, undefined);
  h.tick(120_000);
  assert.equal(h.sent.length, 1);
});

test("only final settlement permits a due continuation", (t) => {
  const h = setup(t);
  h.wakeups.runStarted();
  h.wakeups.schedule(request);
  h.tick(60_000);
  assert.equal(h.sent.length, 0);
  h.wakeups.runSettled(false);
  h.tick(0);
  assert.equal(h.sent.length, 1);
});

test("pending input or compaction defers a due check", (t) => {
  const h = setup(t);
  h.wakeups.schedule(request);
  h.ready(false);
  h.tick(65_000);
  assert.equal(h.sent.length, 0);
  h.ready(true);
  h.tick(5_000);
  assert.equal(h.sent.length, 1);
});

test("busy time cannot extend the deadline", (t) => {
  const h = setup(t);
  h.wakeups.schedule({ ...request, timeoutSeconds: 120 });
  h.ready(false);
  h.tick(120_000);
  assert.equal(h.wakeups.inspect().status, "expired");
  h.ready(true);
  h.tick(60_000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.notices.length, 1);
  assert.throws(() => h.wakeups.schedule(request), /expired|user/i);
});

test("rescheduling never renews the original budget", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule({ ...request, timeoutSeconds: 180 });
  h.tick(60_000);
  assert.throws(
    () => h.wakeups.schedule({ ...request, timeoutSeconds: 3600 }),
    /timeout|deadline/i,
  );
  const second = h.wakeups.schedule({
    ...request,
    prompt: "A changed check",
    timeoutSeconds: 180,
  });
  assert.equal(second.deadline, first.deadline);
  h.tick(60_000);
  assert.throws(() => h.wakeups.schedule(request), /deadline/i);
  assert.equal(h.sent.length, 2);
});

test("duplicate scheduling leaves the original timer intact", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule(request);
  assert.throws(() => h.wakeups.schedule(request), /pending|already/i);
  assert.equal(h.wakeups.inspect().pending?.id, first.pending?.id);
  h.tick(60_000);
  assert.deepEqual(h.sent, [first.pending!.id]);
});

test("cancellation preserves other state and forbids automatic rearming", (t) => {
  const h = setup(t);
  const armed = h.wakeups.schedule(request);
  assert.throws(() => h.wakeups.cancel("not-the-id"), /not-the-id/);
  h.wakeups.cancel(armed.pending!.id);
  h.tick(60_000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.wakeups.inspect().deadline, armed.deadline);
  assert.throws(() => h.wakeups.schedule(request), /cancelled|user/i);
  h.wakeups.userInput();
  assert.equal(
    h.wakeups.schedule(request).deadline,
    START + 60_000 + 3_600_000,
  );
});

test("input during scheduled or checking work cannot refresh its deadline", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule(request);
  h.tick(30_000);
  h.wakeups.userInput();
  assert.equal(h.wakeups.inspect().deadline, first.deadline);
  h.tick(30_000);
  h.wakeups.userInput();
  assert.equal(h.wakeups.schedule(request).deadline, first.deadline);
});

test("real input can start a fresh budget after a completed check", (t) => {
  const h = setup(t);
  h.wakeups.schedule(request);
  h.tick(60_000);
  h.wakeups.runSettled(false);
  assert.equal(h.wakeups.inspect().status, "completed");
  h.wakeups.userInput();
  assert.equal(
    h.wakeups.schedule(request).deadline,
    START + 60_000 + 3_600_000,
  );
});

test("aborted settlement cancels due work before dispatch", (t) => {
  const h = setup(t);
  h.wakeups.runStarted();
  h.wakeups.schedule(request);
  h.tick(60_000);
  h.wakeups.runSettled(true);
  h.tick(60_000);
  assert.deepEqual(h.sent, []);
  assert.throws(() => h.wakeups.schedule(request), /cancelled|user/i);
});

test("reset removes old callbacks and keeps IDs distinct", (t) => {
  const h = setup(t);
  const old = h.wakeups.schedule(request);
  h.tick(30_000);
  h.wakeups.reset();
  const current = h.wakeups.schedule(request);
  assert.notEqual(current.pending!.id, old.pending!.id);
  h.tick(30_000);
  assert.deepEqual(h.sent, []);
  h.tick(30_000);
  assert.deepEqual(h.sent, [current.pending!.id]);
});

test("delivery failures never get a second send attempt", (t) => {
  const h = setup(t);
  h.rejectDelivery();
  h.wakeups.schedule(request);
  h.tick(60_000);
  h.tick(60_000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.wakeups.inspect().status, "cancelled");
  assert.match(h.notices[0]!, /delivery rejected/);
});

test("invalid requests do not start or alter a wait budget", (t) => {
  const h = setup(t);
  for (const delaySeconds of [0, 59, 3601, 60.5, NaN, Infinity]) {
    assert.throws(
      () => h.wakeups.schedule({ ...request, delaySeconds }),
      /delay/i,
    );
  }
  for (const timeoutSeconds of [60, 86401, 61.5, NaN, Infinity]) {
    assert.throws(
      () => h.wakeups.schedule({ ...request, timeoutSeconds }),
      /timeout|deadline/i,
    );
  }
  for (const prompt of ["", " ", "a".repeat(8193)]) {
    assert.throws(() => h.wakeups.schedule({ ...request, prompt }), /prompt/i);
  }
  for (const reason of ["", " ", "a".repeat(513)]) {
    assert.throws(() => h.wakeups.schedule({ ...request, reason }), /reason/i);
  }
  assert.deepEqual(h.wakeups.inspect(), { status: "ready" });
});
