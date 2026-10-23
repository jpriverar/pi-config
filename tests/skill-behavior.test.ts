import * as runner from "./skill-behavior.js";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
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

test("correctness review can be selected independently of structural review", async () => {
  const options = runner.parseArguments([
    "--mode",
    "package",
    "--package",
    "/fixture/package",
    "--output",
    "/fixture/output",
    "--scenario",
    "correctness-review",
  ]);
  assert.deepEqual(runner.selectedScenarioIds(options), ["correctness-review"]);
  const scenario = await loadScenario("correctness-review", scenariosDirectory);
  assert.equal(scenario.name, "correctness-review");
  assert.ok(scenario.prompt.length > 0);
});

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

test("explanation scenario distinguishes behavior from symbols and unsupported claims", async () => {
  const scenario = await loadScenario(
    "explaining-technical-work",
    scenariosDirectory,
  );
  const explanation =
    "The caller needs a total, not detailed records. " +
    "Before: eligible records + examples -> count locally. " +
    "After: same eligibility filter -> total directly. " +
    "Check that both paths count the same eligible records. " +
    "Performance is not measured and production behavior is unverified.";

  assert.equal(evaluateScenario(scenario, explanation).passed, true);
  for (const inadequate of [
    "`getTotal` calls `countEligible` instead of `listIssues`.",
    "`getTotal` was changed. " + explanation,
    explanation.replace("records + examples", "records"),
    explanation + " It is 10x faster.",
    explanation + " I deployed the change.",
  ]) {
    assert.equal(evaluateScenario(scenario, inadequate).passed, false);
  }
});

test("workflow scenario rejects lost verification and unauthorized handoffs", async () => {
  const scenario = await loadScenario(
    "development-workflow",
    scenariosDirectory,
  );
  const handoff =
    "The PR merged, but production behavior is unverified. " +
    "Confirm deployment and observe qualifying traffic for the expected behavior. " +
    "Keep the commitment in the current task, or obtain approval for an explicit handoff.";

  assert.equal(evaluateScenario(scenario, handoff).passed, true);
  for (const inadequate of [
    "The PR merged. Everything is complete.",
    handoff + " I created the verification task.",
    handoff + " I'll create the verification task.",
    handoff + " The merge proves production works.",
    handoff + " I deployed the change.",
  ]) {
    assert.equal(evaluateScenario(scenario, inadequate).passed, false);
  }
});

test("review scenario preserves structural rigor and scope context", async () => {
  const scenario = await loadScenario(
    "thermo-nuclear-code-quality-review",
    scenariosDirectory,
  );
  const review =
    "Request changes for structural simplification. " +
    "Before, one router owned handler selection; now feature branches scatter that decision. " +
    "Crossing 1,000 lines, optional booleans, an any cast, and a pass-through wrapper increase that cost. " +
    "The unchanged legacy timeout stays deferred absent new evidence. " +
    "The reviewed revision is unavailable in this hypothetical.";

  assert.equal(evaluateScenario(scenario, review).passed, true);
  assert.equal(
    evaluateScenario(scenario, review + " Approve because tests pass.").passed,
    false,
  );
  assert.equal(
    evaluateScenario(
      scenario,
      "Structural simplification: 1,000 lines, optional booleans, any casts, branches, and wrappers.",
    ).passed,
    false,
  );
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
      [["AWS", "SEC" + "RET", "ACCESS", "KEY"].join("_")]: "must" + "-not-leak",
      [["OPENAI", "API", "KEY"].join("_")]: "must" + "-not-leak",
      [["UNRELATED", "SEC" + "RET"].join("_")]: "must" + "-not-leak",
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
    writeFile(join(source, "auth.json"), '{"sec' + 'ret":"auth"}\n', {
      mode: 0o644,
    }),
    writeFile(join(source, "models.json"), '{"sec' + 'ret":"models"}\n', {
      mode: 0o644,
    }),
    writeFile(join(source, "models-store.json"), '{"sec' + 'ret":"store"}\n', {
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

test("selects a placement scenario independently of its skill and rejects unsafe options", () => {
  const args = [
    "--mode",
    "package",
    "--package",
    "/fixture/package",
    "--output",
    "/fixture/results",
  ];
  const parsed = runner.parseArguments([
    ...args,
    "--scenario",
    "project-selection/current",
    "--append-policy",
    "/fixture/policy with spaces.md",
  ]);
  assert.equal(parsed.scenario, "project-selection/current");
  assert.equal(parsed.appendPolicy, "/fixture/policy with spaces.md");
  assert.deepEqual(runner.selectedScenarioIds(parsed), [
    "project-selection/current",
  ]);
  assert.ok(
    runner
      .selectedScenarioIds(runner.parseArguments(args))
      .includes("development-workflow"),
  );
  assert.ok(
    !runner
      .selectedScenarioIds(runner.parseArguments(args))
      .includes("project-selection/current"),
  );
  for (const suffix of [
    ["--scenario", "../escape"],
    ["--scenario", "/absolute"],
    ["--scenario", "unknown"],
    [
      "--scenario",
      "project-selection/current",
      "--scenario",
      "project-selection/ambiguous",
    ],
    ["--append-policy", "relative.md"],
    ["--append-policy", "/tmp/a\u0000.md"],
    ["--append-policy", "/tmp/a", "--append-policy", "/tmp/b"],
  ])
    assert.throws(() => runner.parseArguments([...args, ...suffix]));
});

test("two placement cases load one skill with distinct transcript names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skill-cases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project-selection"));
  const markdown =
    "# Case\n\n## Prompt\n\nA fictional proposal.\n\n## Required observations\n\n- `contains:proposal`\n\n## Forbidden observations\n\n- `contains:created`\n";
  for (const id of ["current", "ambiguous"])
    await writeFile(join(root, "project-selection", `${id}.md`), markdown);
  const current = await loadScenario("project-selection/current", root);
  const ambiguous = await loadScenario("project-selection/ambiguous", root);
  assert.equal(current.name, "development-workflow");
  assert.equal(ambiguous.name, current.name);
  assert.equal(current.id, "project-selection/current");
  assert.notEqual(
    runner.scenarioTranscriptName(current),
    runner.scenarioTranscriptName(ambiguous),
  );
  assert.equal(
    runner.scenarioTranscriptName(current),
    "project-selection-current.txt",
  );
  assert.equal(evaluateScenario(current, "proposal").scenario, current.id);
  await assert.rejects(loadScenario("../escape", root));
});

test("policy fixtures are bounded private copies rather than literal fallback prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skill-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source.md"),
    fixture = join(root, "fixture");
  await mkdir(fixture);
  await writeFile(source, "Fixture-only policy.\n", { mode: 0o600 });
  const copied = await runner.copyPolicyFile(source, fixture);
  assert.notEqual(copied, source);
  assert.equal(await readFile(copied!, "utf8"), "Fixture-only policy.\n");
  assert.equal((await stat(copied!)).mode & 0o777, 0o600);
  assert.equal(await runner.copyPolicyFile(undefined, fixture), undefined);
  await assert.rejects(runner.copyPolicyFile(join(root, "missing"), fixture));
  await assert.rejects(runner.copyPolicyFile(root, fixture));
  await assert.rejects(runner.copyPolicyFile("relative.md", fixture));
  await writeFile(source, "x".repeat(64 * 1024 + 1));
  await assert.rejects(
    runner.copyPolicyFile(source, fixture),
    /size|large|limit|bound/i,
  );
});

test("placement RPC flags load only the requested skill and read guard without MCP or mutators", async () => {
  const options = runner.parseArguments([
    "--mode",
    "package",
    "--package",
    "/fixture/package",
    "--output",
    "/fixture/output",
    "--scenario",
    "project-selection/current",
  ]);
  const scenario = {
    id: "project-selection/current",
    name: "development-workflow" as const,
    prompt: "",
    required: [],
    forbidden: [],
  };
  const args = runner.buildRpcArguments(
    options,
    scenario,
    "fixture/model",
    "/fixture/private-policy.md",
    "/fixture/guard.ts",
  );
  for (const flag of [
    "--no-session",
    "--no-context-files",
    "--no-approve",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-mcp",
  ])
    assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], "read");
  assert.equal(
    args[args.indexOf("--skill") + 1],
    "/fixture/package/skills/development-workflow",
  );
  assert.equal(
    args[args.indexOf("--append-system-prompt") + 1],
    "/fixture/private-policy.md",
  );
  assert.equal(args[args.indexOf("-e") + 1], "/fixture/guard.ts");
  assert.ok(!args.includes("/fixture/package"));
  const legacy = runner.buildRpcArguments(
    { ...options, scenario: undefined },
    { ...scenario, id: "development-workflow" },
    "fixture/model",
  );
  assert.equal(legacy[legacy.indexOf("-e") + 1], "/fixture/package");
  assert.ok(!legacy.includes("--tools"));
});

test("proposal guard permits fixture and skill reads but blocks escapes and all writes", async (t) => {
  const { createProposalReadOperations, blockProposalMutation } = await import(
    "./fixtures/project-selection-guard.js"
  );
  const { createReadTool } = await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "skill-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed"),
    outside = join(root, "outside.md");
  await mkdir(allowed);
  await writeFile(join(allowed, "SKILL.md"), "Fixture skill.");
  await writeFile(outside, "Not permitted.");
  await symlink(outside, join(allowed, "escape.md"));
  await mkdir(join(allowed, "@.."));
  await writeFile(join(allowed, "@..", "outside.md"), "Literal fixture path.");
  const reader = createReadTool(allowed, {
    operations: createProposalReadOperations([allowed]),
  });
  const result = await reader.execute("fixture-read", { path: "SKILL.md" });
  assert.match(JSON.stringify(result), /Fixture skill/);
  assert.equal(blockProposalMutation({ toolName: "read" }), undefined);
  for (const path of [
    outside,
    "../outside.md",
    "@../outside.md",
    "escape.md",
    "missing.md",
  ])
    await assert.rejects(reader.execute("fixture-read", { path }));
  for (const toolName of [
    "bash",
    "write",
    "task_create",
    "work_catalog",
    "mcp__anything",
  ])
    assert.equal(blockProposalMutation({ toolName })?.block, true);
});

test("isolated fixture satisfies the parent-policy launcher without inheriting live policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skill-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialDirectory = join(root, "fake-credentials");
  await mkdir(credentialDirectory);
  await writeFile(join(credentialDirectory, "auth.json"), "{}");
  await writeFile(join(credentialDirectory, "models.json"), "{}");
  const controller = new AbortController();
  const fixture = await runner.createFixture(
    root,
    controller.signal,
    credentialDirectory,
  );
  const wrapper = join(root, "launcher.mjs");
  await writeFile(
    wrapper,
    `import fs from 'node:fs';import path from 'node:path';const policy=path.join(process.env.PI_CODING_AGENT_DIR,'PARENT.md');if(!fs.existsSync(policy)||!fs.readFileSync(policy,'utf8').trim())throw new Error('missing parent policy');`,
  );
  await runCommand(
    process.execPath,
    [wrapper],
    fixture.cwd,
    fixture.env,
    controller.signal,
  );
  const policy = await readFile(
    join(fixture.env.PI_CODING_AGENT_DIR!, "PARENT.md"),
    "utf8",
  );
  assert.match(policy, /isolated fixture/i);
  assert.match(policy, /--append-system-prompt/);
  assert.ok(policy.length < 200);
  assert.equal(fixture.env.PI_SKIP_PARENT_POLICY, undefined);
});
