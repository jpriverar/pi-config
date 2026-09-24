import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test, { type TestContext } from "node:test";

import { terminateProcessGroup } from "./pi-smoke.js";

type Signal = NodeJS.Signals | number | undefined;
const PID = 424242;
const errorWithCode = (code: string) =>
  Object.assign(new Error(`fixture kill ${code}`), { code });

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const calls: Array<{ time: number; signal: Signal }> = [];
  let kill = (_signal: Signal): boolean => true;
  let resolveExit!: (value: { code: number; signal: null }) => void;
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    resolveExit = resolve;
  });
  t.mock.method(process, "kill", (target: number, signal: Signal) => {
    assert.equal(target, -PID);
    calls.push({ time: Date.now(), signal });
    return kill(signal);
  });

  return {
    calls,
    setKill(fn: typeof kill) {
      kill = fn;
    },
    exit() {
      resolveExit({ code: 0, signal: null });
    },
    signals() {
      return calls
        .filter((call) => call.signal !== 0)
        .map((call) => call.signal);
    },
    async run() {
      let settled = false;
      let error: unknown;
      const result = terminateProcessGroup(
        { pid: PID } as ChildProcess,
        exited,
        50,
        200,
      ).then(
        () => {
          settled = true;
        },
        (caught) => {
          error = caught;
          settled = true;
        },
      );
      for (let tick = 0; tick < 100 && !settled; tick++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(10);
      }
      assert.ok(settled, "teardown must settle within its bounded deadlines");
      await result;
      const count = calls.length;
      t.mock.timers.tick(5000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        calls.length,
        count,
        "no probes or signals after settlement",
      );
      return error;
    },
  };
}

test("smoke waits for a reaping EPERM to become ESRCH without sending signals", async (t) => {
  const f = fixture(t);
  f.exit();
  f.setKill((signal) => {
    assert.equal(signal, 0);
    throw errorWithCode(Date.now() < 20 ? "EPERM" : "ESRCH");
  });

  assert.equal(await f.run(), undefined);
  assert.deepEqual(f.signals(), []);
  assert.ok(f.calls.some((call) => call.time >= 20));
});

test("smoke does not treat persistent permission denial as successful exit", async (t) => {
  const f = fixture(t);
  f.exit();
  f.setKill(() => {
    throw errorWithCode("EPERM");
  });

  const error = await f.run();
  assert.equal((error as NodeJS.ErrnoException).code, "EPERM");
  assert.deepEqual(f.signals(), ["SIGTERM"]);
  assert.ok(f.calls.at(-1)!.time >= 50);
});

test("smoke preserves a permission error from SIGKILL", async (t) => {
  const f = fixture(t);
  f.exit();
  f.setKill((signal) => {
    if (signal === "SIGKILL") throw errorWithCode("EPERM");
    return true;
  });

  const error = await f.run();
  assert.equal((error as NodeJS.ErrnoException).code, "EPERM");
  assert.deepEqual(f.signals(), ["SIGTERM", "SIGKILL"]);
});

test("smoke waits for zombie reaping after SIGKILL and an observed exit", async (t) => {
  const f = fixture(t);
  let reapedAt: number | undefined;
  f.setKill((signal) => {
    if (signal === "SIGKILL") {
      reapedAt = Date.now() + 20;
      f.exit();
    } else if (signal === 0 && reapedAt !== undefined) {
      throw errorWithCode(Date.now() < reapedAt ? "EPERM" : "ESRCH");
    }
    return true;
  });

  assert.equal(await f.run(), undefined);
  assert.deepEqual(f.signals(), ["SIGTERM", "SIGKILL"]);
  assert.ok(reapedAt !== undefined);
  assert.ok(f.calls.at(-1)!.time >= reapedAt);
});

test("smoke fails within its deadline when a killed group never disappears", async (t) => {
  const f = fixture(t);
  let killed = false;
  f.setKill((signal) => {
    if (signal === "SIGKILL") {
      killed = true;
      f.exit();
    } else if (signal === 0 && killed) {
      throw errorWithCode("EPERM");
    }
    return true;
  });

  assert.match(String(await f.run()), /survived SIGKILL/);
  assert.deepEqual(f.signals(), ["SIGTERM", "SIGKILL"]);
});
