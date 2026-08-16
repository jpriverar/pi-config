import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { terminateProcessGroup } from "./pi-smoke.js";

test("Pi smoke shutdown escalates to SIGKILL for a stuck process group", async () => {
  const child = spawn("sh", ["-c", 'trap "" TERM; sleep 30 & wait'], {
    detached: true,
    stdio: "ignore",
  });
  assert.notEqual(child.pid, undefined);
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });

  const started = Date.now();
  await terminateProcessGroup(child, exited, 50);
  assert.ok(Date.now() - started < 1_000);
  assert.throws(
    () => process.kill(-(child.pid as number), 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
  );
});
