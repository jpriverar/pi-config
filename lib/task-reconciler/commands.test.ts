import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { runBoundedCommand } from "./commands.js";

const fixture = fileURLToPath(
  new URL("../../tests/fixtures/task-reconciler/command.mjs", import.meta.url),
);
async function rootFor(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "reconciler-command-"));
  t.after(async () => {
    for (const name of ["pid", "pid.child"]) {
      try {
        const pid = Number(await readFile(join(root, name), "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        const command = execFileSync(
          "/bin/ps",
          ["-o", "command=", "-p", String(pid)],
          { encoding: "utf8" },
        );
        if (command.includes(root)) process.kill(pid, "SIGKILL");
      } catch {
        /* The fixture may already have exited. */
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 4000;
  while (true) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch (e) {
      if (Date.now() >= deadline) throw e;
    }
    await delay(10);
  }
}
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return !execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    })
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

test("executes one argv value without shell interpolation and retains exit status/output", async (t) => {
  const root = await rootFor(t);
  const marker = join(root, "must-not-exist");
  const payload = `$(touch ${marker}); echo unexpected`;
  const result = await runBoundedCommand(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1))); console.error('stderr'); process.exitCode=7",
      payload,
    ],
    { env: {} },
  );
  assert.equal(result.code, 7);
  assert.deepEqual(JSON.parse(result.stdout), [payload]);
  assert.equal(result.stderr, "stderr\n");
  await assert.rejects(access(marker));
});

test("times out and reaps a child that ignores SIGTERM", async (t) => {
  const root = await rootFor(t);
  const pidFile = join(root, "pid");
  await assert.rejects(
    runBoundedCommand(process.execPath, [fixture, "ignore-term", pidFile], {
      env: {},
      timeoutMs: 1000,
    }),
    (e: any) => e.reason === "timeout",
  );
  const pid = await readPid(pidFile);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("abort cancels an active command and waits for its direct child to exit", async (t) => {
  const root = await rootFor(t);
  const pidFile = join(root, "pid");
  const controller = new AbortController();
  const result = runBoundedCommand(
    process.execPath,
    [fixture, "ignore-term", pidFile],
    { env: {}, signal: controller.signal, timeoutMs: 5000 },
  ).catch((e) => e);
  const pid = await readPid(pidFile);
  controller.abort();
  assert.equal((await result).reason, "aborted");
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("an already aborted command never spawns", async (t) => {
  const root = await rootFor(t);
  const pidFile = join(root, "pid");
  await assert.rejects(
    runBoundedCommand(process.execPath, [fixture, "ignore-term", pidFile], {
      env: {},
      signal: AbortSignal.abort(),
    }),
    (e: any) => e.reason === "aborted",
  );
  await assert.rejects(access(pidFile));
});

test("output overflow terminates and reaps the writer", async (t) => {
  const root = await rootFor(t);
  const pidFile = join(root, "pid");
  await assert.rejects(
    runBoundedCommand(process.execPath, [fixture, "overflow", pidFile], {
      env: {},
      maxOutputBytes: 16,
    }),
    (e: any) => e.reason === "output_limit",
  );
  const pid = await readPid(pidFile);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("a retained output pipe cannot hang after the direct child exits", async (t) => {
  const root = await rootFor(t);
  const pidFile = join(root, "pid");
  await assert.rejects(
    runBoundedCommand(process.execPath, [fixture, "retained-pipe", pidFile], {
      env: {},
      timeoutMs: 5000,
    }),
    (e: any) => e.reason === "output_pipe_retained",
  );
  const childPid = await readPid(`${pidFile}.child`);
  const deadline = Date.now() + 4000;
  while (isRunning(childPid) && Date.now() < deadline) await delay(20);
  assert.equal(isRunning(childPid), false);
});

test("spawn errors do not expose command arguments or inherited credentials", async () => {
  await assert.rejects(
    runBoundedCommand(
      "/definitely-missing/reconciler-command",
      ["private-token-value"],
      { env: { GH_TOKEN: "private-token-value" } },
    ),
    (e: any) =>
      e.reason === "spawn_failed" && !String(e).includes("private-token-value"),
  );
});

test("invalid budgets fail before starting a process", async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(
      runBoundedCommand(process.execPath, ["-e", "process.exit(99)"], {
        env: {},
        timeoutMs,
      }),
      /timeoutMs/,
    );
  }
  await assert.rejects(
    runBoundedCommand(process.execPath, [], { env: {}, maxOutputBytes: 0 }),
    /maxOutputBytes/,
  );
});
