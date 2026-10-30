import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as runner from "./skill-behavior.js";

test("invalid criteria are rejected before starting a paid model sample", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-criteria-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workflow"));
  await writeFile(
    join(root, "workflow/plan.md"),
    "# Case\n\n## Prompt\n\nWhat next?\n\n## Context\n\nFixture.\n\n## Required observations\n\n- `regex:unmatched)`\n\n## Forbidden observations\n\n- `contains:deployed`\n",
  );
  await assert.rejects(
    runner.loadScenario("workflow/plan", root),
    /regular expression/,
  );
});

test("every workflow scenario loads and can be scored before model execution", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "skill-scenarios");
  for (const name of ["intent", "design", "plan", "validation", "deploy"]) {
    const fixture = await runner.loadScenario(`workflow/${name}`, root);
    assert.ok(fixture.context);
    assert.equal(runner.evaluateScenario(fixture, "").passed, false);
  }
});

test("skill-read evidence recognizes a successful read through a symlinked checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-read-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = join(root, "actual"),
    alias = join(root, "alias");
  await mkdir(actual);
  await writeFile(join(actual, "SKILL.md"), "Fixture skill");
  await symlink(actual, alias);
  assert.equal(
    await runner.hasSuccessfulRead(
      { successfulReads: [join(alias, "SKILL.md")], failedTools: [] },
      join(actual, "SKILL.md"),
    ),
    true,
  );
  assert.equal(
    await runner.hasSuccessfulRead(
      { successfulReads: [join(root, "missing.md")], failedTools: ["read"] },
      join(actual, "SKILL.md"),
    ),
    false,
  );
});

test("cancellation during read-evidence collection cannot produce success", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-read-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "SKILL.md");
  await writeFile(path, "Fixture skill");
  const controller = new AbortController();
  const reading = runner.hasSuccessfulRead(
    { successfulReads: [path], failedTools: [] },
    path,
    controller.signal,
  );
  const reason = new Error("Fixture deadline elapsed");
  controller.abort(reason);
  await assert.rejects(reading, (error) => error === reason);
});

const scenario = {
  id: "workflow/intent",
  name: "development-workflow" as const,
  prompt: "I want to build a service. What is next?",
  required: ["contains:intent"],
  forbidden: ["contains:I deployed"],
};

function options(mode: string) {
  return runner.parseArguments([
    "--mode",
    mode,
    ...(mode === "package" ? ["--package", "/fixture/package"] : []),
    "--scenario",
    scenario.id,
    "--output",
    "/fixture/output",
  ]);
}

test("workflow samples submit ordinary requests, while legacy samples remain explicit", () => {
  assert.equal(options("package").scenario, "workflow/intent");
  assert.equal(runner.buildScenarioPrompt(scenario), scenario.prompt);
  assert.equal(
    runner.buildScenarioPrompt({ ...scenario, id: "development-workflow" }),
    "/skill:development-workflow I want to build a service. What is next?",
  );
});

test("control samples cannot expose package code, MCP, or mutation tools", () => {
  const control = options("control");
  const args = runner.buildRpcArguments(
    control,
    scenario,
    "fixture/model",
    undefined,
    "/fixture/guard.ts",
  );
  for (const flag of [
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
  ])
    assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], "read");
  assert.equal(args[args.indexOf("-e") + 1], "/fixture/guard.ts");
  assert.ok(!args.includes("--skill"));
  assert.throws(
    () => runner.buildRpcArguments(control, scenario, "fixture/model"),
    /guard/,
  );
  assert.throws(() =>
    runner.parseArguments(["--mode", "control", "--output", "/fixture/output"]),
  );
  assert.throws(() =>
    runner.parseArguments([
      "--mode",
      "control",
      "--output",
      "/fixture/output",
      "--scenario",
      "grill-me",
    ]),
  );
  assert.throws(() =>
    runner.parseArguments([
      "--mode",
      "control",
      "--output",
      "/fixture/output",
      "--scenario",
      "workflow/intent",
      "--package",
      "/fixture/package",
    ]),
  );
});

test("workflow package samples load only the selected skill under the read guard", () => {
  const args = runner.buildRpcArguments(
    options("package"),
    scenario,
    "fixture/model",
    undefined,
    "/fixture/guard.ts",
  );
  assert.equal(
    args[args.indexOf("--skill") + 1],
    "/fixture/package/skills/development-workflow",
  );
  assert.equal(args[args.indexOf("-e") + 1], "/fixture/guard.ts");
  assert.equal(args[args.indexOf("--tools") + 1], "read");
  assert.ok(!args.includes("/fixture/package"));
});

test("read evidence requires a successful matching tool result, not prose or an attempted read", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "I read /not-read/SKILL.md" },
        {
          type: "toolCall",
          id: "good",
          name: "read",
          arguments: { path: "./skills/../SKILL.md" },
        },
        {
          type: "toolCall",
          id: "bad",
          name: "read",
          arguments: { path: "/not-allowed/secret" },
        },
        {
          type: "toolCall",
          id: "pending",
          name: "read",
          arguments: { path: "pending.md" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "good",
      toolName: "read",
      isError: false,
    },
    { role: "toolResult", toolCallId: "bad", toolName: "read", isError: true },
    {
      role: "toolResult",
      toolCallId: "unmatched",
      toolName: "read",
      isError: false,
    },
  ];
  assert.deepEqual(runner.collectReadEvidence(messages, "/fixture"), {
    successfulReads: ["/fixture/SKILL.md"],
    failedTools: ["read"],
  });
  assert.throws(
    () => runner.collectReadEvidence(undefined, "/fixture"),
    /messages/,
  );
});
