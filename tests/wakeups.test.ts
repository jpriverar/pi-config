import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { WakeupController, type WakeupRequest } from "../lib/wakeups.js";

const START = Date.UTC(2026, 1, 1);
const request: WakeupRequest = {
  delaySeconds: 60,
  reason: "The requested operation is pending",
  prompt: "Check operation run-123 and report its current state",
};

function setup(t: TestContext, now = START) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
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

test("an overdue relative alarm survives its cutoff and delivers once without renewing it", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule({ ...request, timeoutSeconds: 120 });
  h.ready(false);
  h.tick(2 * 86_400_000);
  const late = h.wakeups.inspect();
  assert.equal(late.status, "scheduled");
  assert.equal(late.pending?.id, first.pending!.id);
  assert.equal(late.deadline, first.deadline);
  assert.equal(h.notices.length, 0);
  h.wakeups.userInput();
  assert.equal(h.wakeups.inspect().deadline, first.deadline);
  h.ready(true);
  h.tick(5_000);
  assert.deepEqual(h.sent, [first.pending!.id]);
  assert.throws(() => h.wakeups.schedule(request), /expired|cutoff|user/i);
  h.tick(60_000);
  assert.equal(h.sent.length, 1);
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
  assert.throws(() => h.wakeups.schedule(request), /cutoff/i);
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

const DAY = 86_400_000;
const absolute = (at: string, timeoutSeconds?: number) => ({
  at,
  prompt: request.prompt,
  reason: request.reason,
  ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
});

test("an absolute alarm can target one week ahead with its cutoff anchored to that target", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule(absolute("2026-02-08T00:00:00Z"));
  assert.equal(first.pending?.dueAt, START + 7 * DAY);
  assert.equal(first.deadline, START + 7 * DAY + 3_600_000);
  h.tick(7 * DAY - 1);
  assert.deepEqual(h.sent, []);
  h.tick(1);
  assert.deepEqual(h.sent, [first.pending!.id]);
});

test("an absolute alarm delayed by two days remains deliverable after its follow-up cutoff", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule(absolute("2026-02-02T00:00:00Z"));
  h.ready(false);
  h.tick(3 * DAY);
  assert.equal(h.wakeups.inspect().pending?.id, first.pending!.id);
  assert.equal(h.notices.length, 0);
  h.ready(true);
  h.tick(5_000);
  assert.deepEqual(h.sent, [first.pending!.id]);
  assert.throws(() => h.wakeups.schedule(request), /expired|cutoff|user/i);
  h.wakeups.runSettled(false);
  h.wakeups.userInput();
  const next = h.wakeups.schedule(absolute("2026-02-05T00:00:00Z"));
  assert.equal(next.deadline, START + 4 * DAY + 3_600_000);
});

for (const mode of ["relative", "absolute"] as const) {
  test(`${mode} catches up after a wall-clock jump without waiting its original timer interval`, (t) => {
    const h = setup(t);
    let wall = START;
    t.mock.method(Date, "now", () => wall);
    const first = h.wakeups.schedule(
      mode === "relative"
        ? { ...request, delaySeconds: 3600, timeoutSeconds: 7200 }
        : absolute("2026-02-04T00:00:00Z"),
    );
    wall = START + 5 * DAY;
    h.tick(60_000);
    assert.deepEqual(h.sent, [first.pending!.id]);
    assert.throws(() => h.wakeups.schedule(request), /expired|cutoff|user/i);
  });

  test(`${mode} does not fire early after the wall clock moves backward`, (t) => {
    const h = setup(t);
    let wall = START;
    t.mock.method(Date, "now", () => wall);
    const first = h.wakeups.schedule(
      mode === "relative" ? request : absolute("2026-02-01T00:01:00Z"),
    );
    wall = START - 3_600_000;
    h.tick(60_000);
    assert.deepEqual(h.sent, []);
    wall = START + 60_000;
    h.tick(60_000);
    assert.deepEqual(h.sent, [first.pending!.id]);
  });
}

test("mixing absolute and relative follow-ups never renews the first cutoff", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule(absolute("2026-02-02T00:00:00Z", 180));
  h.tick(DAY);
  assert.throws(
    () => h.wakeups.schedule({ ...request, timeoutSeconds: 3600 }),
    /timeout|cutoff|deadline/i,
  );
  const second = h.wakeups.schedule(request);
  assert.equal(second.deadline, first.deadline);
  h.tick(60_000);
  const third = h.wakeups.schedule(absolute("2026-02-02T00:02:00Z"));
  assert.equal(third.deadline, first.deadline);
  h.tick(60_000);
  assert.throws(() => h.wakeups.schedule(request), /deadline|cutoff/i);
  assert.equal(h.sent.length, 3);
});

test("absolute follow-ups cannot escape a relative wait's original cutoff", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule({ ...request, timeoutSeconds: 180 });
  h.tick(60_000);
  assert.throws(
    () => h.wakeups.schedule(absolute("2026-02-02T00:00:00Z")),
    /deadline|cutoff/i,
  );
  const next = h.wakeups.schedule(absolute("2026-02-01T00:02:00Z"));
  assert.equal(next.deadline, first.deadline);
});

test("timestamps normalize explicit offsets and millisecond precision", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule(absolute("2026-02-01T02:01:00.125+02:00"));
  assert.equal(first.pending?.dueAt, START + 60_125);
  h.tick(60_124);
  assert.deepEqual(h.sent, []);
  h.tick(1);
  assert.deepEqual(h.sent, [first.pending!.id]);
});

test("invalid or ambiguous calendar timestamps do not create an alarm", (t) => {
  const h = setup(t, Date.UTC(2026, 1, 27));
  for (const at of [
    "2026-02-28T09:00:00",
    "2026-02-28",
    "tomorrow at 9",
    "",
    "2026-02-29T09:00:00Z",
    "2026-02-30T09:00:00+01:00",
    "2026-02-27T24:00:00Z",
    "2026-02-28T09:60:00Z",
    "2026-02-28T09:00:60Z",
    "2026-02-28T09:00:00+24:00",
    "2026-02-28T09:00:00+00:60",
    "2026-02-28T09:00:00.1234Z",
    " 2026-02-28T09:00:00Z",
    "2026-02-28T09:00:00Z\n",
  ]) {
    assert.throws(() => h.wakeups.schedule(absolute(at)), /at|timestamp/i, at);
  }
  assert.deepEqual(h.wakeups.inspect(), { status: "ready" });
});

test("valid leap days are accepted", (t) => {
  const h = setup(t, Date.UTC(2028, 1, 27));
  const first = h.wakeups.schedule(absolute("2028-02-29T00:00:00Z"));
  assert.equal(first.pending?.dueAt, Date.UTC(2028, 1, 29));
});

test("absolute targets obey the one-minute and one-week boundaries", (t) => {
  const h = setup(t);
  for (const at of [
    "2026-01-31T23:59:00Z",
    "2026-02-01T00:00:59.999Z",
    "2026-02-08T00:00:00.001Z",
  ]) {
    assert.throws(() => h.wakeups.schedule(absolute(at)), /at|future|week/i);
  }
  assert.equal(
    h.wakeups.schedule(absolute("2026-02-01T00:01:00Z")).pending?.dueAt,
    START + 60_000,
  );
});

test("exactly one timing input is required and invalid combinations leave state untouched", (t) => {
  const h = setup(t);
  assert.throws(
    () => h.wakeups.schedule({ ...request, at: "2026-02-02T00:00:00Z" }),
    /exactly one|both|at/i,
  );
  assert.throws(
    () =>
      h.wakeups.schedule({ prompt: request.prompt, reason: request.reason }),
    /exactly one|delaySeconds|at/i,
  );
  assert.deepEqual(h.wakeups.inspect(), { status: "ready" });
});

test("cancellation still removes an overdue absolute alarm", (t) => {
  const h = setup(t);
  const first = h.wakeups.schedule(absolute("2026-02-02T00:00:00Z"));
  h.ready(false);
  h.tick(3 * DAY);
  h.wakeups.cancel(first.pending!.id);
  h.ready(true);
  h.tick(60_000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.wakeups.inspect().status, "cancelled");
});

for (const blocked of [false, true]) {
  test(`clock rollback cannot reopen a cutoff observed while ${blocked ? "pending" : "delivering"}`, (t) => {
    const h = setup(t);
    let wall = START;
    t.mock.method(Date, "now", () => wall);
    const first = h.wakeups.schedule({ ...request, timeoutSeconds: 180 });
    h.ready(!blocked);
    wall = START + DAY;
    h.tick(60_000);
    wall = START + 60_000;
    h.ready(true);
    h.tick(5_000);
    assert.deepEqual(h.sent, [first.pending!.id]);
    assert.throws(() => h.wakeups.schedule(request), /cutoff|expired|user/i);
    h.wakeups.runSettled(false);
    h.wakeups.userInput();
    assert.equal(h.wakeups.schedule(request).deadline, START + 3_660_000);
  });
}
