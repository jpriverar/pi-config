import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RpcProcess,
  baselineExitCode,
  buildMinimalEnvironment,
  copyCredentialFiles,
  evaluateScenario,
  loadScenario,
  persistAndEvaluateScenario,
  runCommand,
  type ScenarioSummary,
} from "./skill-behavior.js";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const scenariosDirectory = join(testsDirectory, "skill-scenarios");

async function eventuallyMissing(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} survived process-group termination`);
}

test("behavior evaluator requires two relevant questions and rejects concrete advice", async () => {
  const grill = await loadScenario("grill-me", scenariosDirectory);
  const thinking = await loadScenario("thinking-partner", scenariosDirectory);

  assert.equal(
    evaluateScenario(
      grill,
      "Why now? Are you ready? Use Kafka; it will solve this.",
    ).passed,
    false,
  );
  assert.equal(
    evaluateScenario(
      grill,
      "Excellent idea. What failure mode does the queue address? Which delivery assumption can fail?",
    ).passed,
    false,
  );
  assert.equal(
    evaluateScenario(
      grill,
      "What failure mode does queueing recover from rather than defer? Which delivery-semantics assumption covers duplicate work?",
    ).passed,
    true,
  );
  assert.equal(
    evaluateScenario(
      grill,
      "What throughput do you need to support? Which failure modes could you tolerate?",
    ).passed,
    true,
  );
  assert.equal(
    evaluateScenario(
      grill,
      "- You should use Kafka. What failure mode does that address? Which delivery assumption can fail?",
    ).passed,
    false,
  );

  assert.equal(
    evaluateScenario(
      thinking,
      "What worries you? Is timing important? Staging minimizes blast radius.",
    ).passed,
    false,
  );
  assert.equal(
    evaluateScenario(
      thinking,
      "Which failure would make either option unacceptable? What assumption about rollback would settle the tradeoff?",
    ).passed,
    true,
  );
  assert.equal(
    evaluateScenario(
      thinking,
      "What evidence do you need to settle the decision? Do you think you could roll back safely?",
    ).passed,
    true,
  );
  assert.equal(
    evaluateScenario(
      thinking,
      "What evidence supports your assumption that staging reduces risk? Which rollback constraint would settle the decision?",
    ).passed,
    true,
  );
  for (const advocacy of [
    "- Staging reduces risk.",
    "1. Staging reduces risk.",
  ]) {
    assert.equal(
      evaluateScenario(
        thinking,
        `${advocacy} Which failure would make it unacceptable? What rollback constraint matters?`,
      ).passed,
      false,
    );
  }
});

test("runScenario awaits final persistence before deadline cleanup", async () => {
  const source = await readFile(
    join(testsDirectory, "skill-behavior.ts"),
    "utf8",
  );

  assert.match(source, /return await persistAndEvaluateScenario\(/);
});

test("final transcript write cannot return a passing summary after timeout", async () => {
  const scenario = await loadScenario("grill-me", scenariosDirectory);
  const controller = new AbortController();
  let releaseWrite!: () => void;
  let reportWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    reportWriteStarted = resolve;
  });
  const writePending = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const operation = persistAndEvaluateScenario(
    scenario,
    "What throughput must this handle? Which failure mode can the design tolerate?",
    "/external/transcript.txt",
    controller.signal,
    async () => {
      reportWriteStarted();
      await writePending;
    },
  );

  await writeStarted;
  const timeoutReason = new Error("final write timeout");
  controller.abort(timeoutReason);
  releaseWrite();

  await assert.rejects(operation, (error) => error === timeoutReason);
});

test("baseline exit contract distinguishes expected absence from unexpected discovery", () => {
  const absent = ["grill-me", "thinking-partner", "handoff"].map(
    (skill): ScenarioSummary => ({
      skill: skill as ScenarioSummary["skill"],
      discovered: false,
      passed: true,
      required: [],
      forbidden: [],
    }),
  );
  assert.equal(baselineExitCode(absent), 1);
  assert.equal(
    baselineExitCode(
      absent.map((summary, index) =>
        index === 1 ? { ...summary, discovered: true } : summary,
      ),
    ),
    0,
  );
});

test("minimal subprocess environment excludes unrelated secrets", () => {
  const environment = buildMinimalEnvironment(
    {
      HOME: "/fixture/home",
      PATH: "/fixture/bin",
      LANG: "C",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      UNRELATED_SECRET: "must-not-leak",
    },
    { BEADS_DIR: "/fixture/beads" },
  );
  assert.deepEqual(environment, {
    HOME: "/fixture/home",
    PATH: "/fixture/bin",
    LANG: "C",
    BEADS_DIR: "/fixture/beads",
  });
});

test("credential fixture copies only auth and models files with mode 0600", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await Promise.all([mkdir(source), mkdir(destination)]);
  await Promise.all([
    writeFile(join(source, "auth.json"), '{"secret":"auth"}\n', {
      mode: 0o644,
    }),
    writeFile(join(source, "models.json"), '{"secret":"models"}\n', {
      mode: 0o644,
    }),
    writeFile(join(source, "models-store.json"), '{"secret":"store"}\n', {
      mode: 0o644,
    }),
  ]);

  await copyCredentialFiles(source, destination);

  for (const name of ["auth.json", "models.json"]) {
    const path = join(destination, name);
    assert.equal((await lstat(path)).isSymbolicLink(), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      await readFile(path, "utf8"),
      await readFile(join(source, name), "utf8"),
    );
  }
  await assert.rejects(lstat(join(destination, "models-store.json")), {
    code: "ENOENT",
  });
});

test("aborting a fixture command terminates its process group before rejecting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-command-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "linger.sh");
  const pidFile = join(root, "child.pid");
  await writeFile(script, `#!/bin/sh\nsleep 30 &\necho $! > "$1"\nwait\n`);
  await chmod(script, 0o755);
  const controller = new AbortController();
  const running = runCommand(
    script,
    [pidFile],
    root,
    { PATH: process.env.PATH ?? "" },
    controller.signal,
  );
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await stat(pidFile);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  controller.abort(new Error("fixture timeout"));
  await assert.rejects(running, /fixture timeout/);
  await eventuallyMissing(childPid);
});

test("RPC abort rejects requests and waiters and confirms descendant exit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-rpc-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-pi.sh");
  const pidFile = join(root, "child.pid");
  await writeFile(
    executable,
    `#!/bin/sh\nsleep 30 &\necho $! > "$CHILD_PID_FILE"\nwait\n`,
  );
  await chmod(executable, 0o755);
  const controller = new AbortController();
  const rpc = new RpcProcess(
    [],
    root,
    { PATH: process.env.PATH ?? "", CHILD_PID_FILE: pidFile },
    {
      executable,
      signal: controller.signal,
    },
  );
  const request = rpc.request("never");
  const waiter = rpc.waitFor("never");
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await stat(pidFile);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  controller.abort(new Error("scenario timeout"));
  await assert.rejects(request, /scenario timeout/);
  await assert.rejects(waiter, /scenario timeout/);
  await rpc.stop(new Error("scenario timeout"));
  await eventuallyMissing(childPid);
});
