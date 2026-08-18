import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { terminateProcessGroup } from "./pi-smoke.js";

test("Pi smoke shutdown tolerates delayed exit observation after SIGKILL", async (t) => {
  const child = spawn(
    "sh",
    ["-c", 'trap "" TERM; sleep 30 & printf ready; wait'],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  assert.notEqual(child.pid, undefined);
  const pid = child.pid as number;
  t.after(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
  assert.notEqual(child.stdout, null);
  await once(child.stdout, "data");

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("close", (code, signal) => {
      setTimeout(() => resolveExit({ code, signal }), 100);
    });
  });

  await terminateProcessGroup(child, exited, 50);
  assert.throws(
    () => process.kill(-pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
});
