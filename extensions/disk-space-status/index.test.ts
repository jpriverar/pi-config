import assert from "node:assert/strict";
import test from "node:test";

import diskSpaceStatus from "./index.js";

const GiB = 1024n ** 3n;

function createHarness(initialFreeBytes: bigint) {
  const handlers = new Map<string, Function>();
  const statuses: Array<[string, string | undefined]> = [];
  const intervals: Array<{ callback: () => void; milliseconds: number }> = [];
  const cleared: unknown[] = [];
  const timer = { unref() {} };
  let freeBytes = initialFreeBytes;
  let statfsCalls = 0;
  let statfsError: Error | undefined;
  let statfsWait: Promise<void> | undefined;
  const pi = {
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
  };
  const deps = {
    homePath: "/home/test",
    async statfs(path: string) {
      statfsCalls += 1;
      assert.equal(path, "/home/test");
      await statfsWait;
      if (statfsError) throw statfsError;
      return { bavail: freeBytes, bsize: 1n };
    },
    setInterval(callback: () => void, milliseconds: number) {
      intervals.push({ callback, milliseconds });
      return timer;
    },
    clearInterval(handle: unknown) {
      cleared.push(handle);
    },
  };
  const ctx = {
    mode: "tui",
    ui: {
      theme: { fg: (color: string, text: string) => `${color}:${text}` },
      setStatus(key: string, value: string | undefined) {
        statuses.push([key, value]);
      },
    },
  };

  diskSpaceStatus(pi as never, deps as never);

  return {
    cleared,
    handlers,
    intervals,
    statuses,
    timer,
    ctx,
    get statfsCalls() {
      return statfsCalls;
    },
    setFreeBytes(value: bigint) {
      freeBytes = value;
    },
    setStatfsError(error: Error | undefined) {
      statfsError = error;
    },
    setStatfsWait(wait: Promise<void> | undefined) {
      statfsWait = wait;
    },
  };
}

test("publishes healthy free space and schedules refresh", async () => {
  const harness = createHarness(200n * GiB);
  const sessionStart = harness.handlers.get("session_start");
  assert.equal(typeof sessionStart, "function");

  await sessionStart!({}, harness.ctx);

  assert.deepEqual(harness.statuses, [["disk-space", "dim:disk 200G"]]);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].milliseconds, 60_000);
});

test("uses the old low-space colors", async () => {
  const cases = [
    { freeBytes: 150n * GiB, expected: "dim:disk 150G" },
    { freeBytes: 149n * GiB + GiB / 2n, expected: "warning:disk 149.5G" },
    { freeBytes: 80n * GiB, expected: "warning:disk 80G" },
    { freeBytes: 79n * GiB + GiB / 2n, expected: "error:disk 79.5G" },
  ];

  for (const { freeBytes, expected } of cases) {
    const harness = createHarness(freeBytes);
    await harness.handlers.get("session_start")!({}, harness.ctx);
    assert.deepEqual(harness.statuses, [["disk-space", expected]]);
  }
});

test("shows an unknown value when sampling fails", async () => {
  const harness = createHarness(200n * GiB);
  harness.setStatfsError(new Error("statfs unavailable"));

  await harness.handlers.get("session_start")!({}, harness.ctx);

  assert.deepEqual(harness.statuses, [["disk-space", "error:disk ?"]]);
  assert.equal(harness.intervals.length, 1);
});

test("clears its timer and footer status on shutdown", async () => {
  const harness = createHarness(200n * GiB);
  await harness.handlers.get("session_start")!({}, harness.ctx);
  const sessionShutdown = harness.handlers.get("session_shutdown");
  assert.equal(typeof sessionShutdown, "function");

  await sessionShutdown!({}, harness.ctx);

  assert.deepEqual(harness.cleared, [harness.timer]);
  assert.deepEqual(harness.statuses.at(-1), ["disk-space", undefined]);
});

test("does not run outside the interactive footer", async () => {
  const harness = createHarness(200n * GiB);
  harness.ctx.mode = "print";

  await harness.handlers.get("session_start")!({}, harness.ctx);

  assert.equal(harness.statfsCalls, 0);
  assert.deepEqual(harness.statuses, []);
  assert.deepEqual(harness.intervals, []);
});

test("replaces the polling timer when a session restarts", async () => {
  const harness = createHarness(200n * GiB);
  const sessionStart = harness.handlers.get("session_start")!;

  await sessionStart({}, harness.ctx);
  await sessionStart({}, harness.ctx);

  assert.deepEqual(harness.cleared, [harness.timer]);
  assert.equal(harness.intervals.length, 2);
});

test("does not install a timer after shutdown wins an initial sample race", async () => {
  const harness = createHarness(200n * GiB);
  let releaseSample!: () => void;
  harness.setStatfsWait(
    new Promise<void>((resolve) => {
      releaseSample = resolve;
    }),
  );

  const start = harness.handlers.get("session_start")!({}, harness.ctx);
  await Promise.resolve();
  assert.equal(harness.statfsCalls, 1);
  await harness.handlers.get("session_shutdown")!({}, harness.ctx);
  releaseSample();
  await start;

  assert.deepEqual(harness.intervals, []);
  assert.deepEqual(harness.statuses, [["disk-space", undefined]]);
});
