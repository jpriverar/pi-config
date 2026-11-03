import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import * as runner from "./skill-behavior.js";
import { createProposalReadOperations } from "./fixtures/project-selection-guard.js";

const scenarios = join(
  dirname(fileURLToPath(import.meta.url)),
  "skill-scenarios",
);

test("artifact review is independently selectable with guarded ordinary-language input", async () => {
  const scenario = await runner.loadScenario("review/evidence", scenarios);
  assert.equal(scenario.name, "correctness-review");
  assert.ok(scenario.context);
  assert.equal(Object.keys(scenario.files ?? {}).length, 9);
  assert.equal(runner.buildScenarioPrompt(scenario), scenario.prompt);
  for (const mode of ["control", "package"]) {
    const options = runner.parseArguments([
      "--mode",
      mode,
      "--scenario",
      scenario.id,
      "--output",
      "/fixture/output",
      ...(mode === "package" ? ["--package", "/fixture/package"] : []),
    ]);
    const args = runner.buildRpcArguments(
      options,
      scenario,
      "fixture/model",
      undefined,
      "/fixture/guard.ts",
    );
    assert.equal(args[args.indexOf("--tools") + 1], "read");
    assert.ok(args.includes("--no-mcp"));
    assert.ok(args.includes("--no-context-files"));
    assert.equal(args.includes("--skill"), mode === "package");
    if (mode === "package")
      assert.equal(
        args[args.indexOf("--skill") + 1],
        "/fixture/package/skills/correctness-review",
      );
  }
});

test("artifact loading rejects symlinks before a model can see their contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "review", "evidence");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(root, "review/evidence.md"),
    await readFile(join(scenarios, "review/evidence.md")),
  );
  const scenario = await runner.loadScenario("review/evidence", scenarios);
  for (const [name, content] of Object.entries(scenario.files!)) {
    if (name !== "intent.md") await writeFile(join(source, name), content);
  }
  const outside = join(root, "outside.md");
  await writeFile(outside, "Outside the fixture artifact source.");
  await symlink(outside, join(source, "intent.md"));
  await assert.rejects(runner.loadScenario("review/evidence", root), {
    code: "ELOOP",
  });
});

test("artifact source directories cannot redirect reads outside the scenario tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "scenarios"),
    outside = join(root, "outside");
  await mkdir(join(source, "review"), { recursive: true });
  await mkdir(outside);
  await writeFile(
    join(source, "review/evidence.md"),
    await readFile(join(scenarios, "review/evidence.md")),
  );
  const scenario = await runner.loadScenario("review/evidence", scenarios);
  for (const [name, content] of Object.entries(scenario.files!))
    await writeFile(join(outside, name), content);
  await symlink(outside, join(source, "review/evidence"));
  await assert.rejects(
    runner.loadScenario("review/evidence", source),
    /escape/,
  );
});

test("materialized evidence stays inside the fixture and cannot replace context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "fixture");
  await mkdir(fixture);
  const scenario = await runner.loadScenario("review/evidence", scenarios);
  await runner.materializeScenario(scenario, fixture);
  assert.equal(
    await readFile(join(fixture, "context.md"), "utf8"),
    scenario.context,
  );
  assert.match(
    await readFile(join(fixture, "retry-ci.md"), "utf8"),
    /SKIP scheduler restarts/,
  );
  for (const name of [
    "../outside.md",
    "/outside.md",
    "AGENTS.md",
    "context.md",
  ]) {
    await assert.rejects(
      runner.materializeScenario(
        { ...scenario, context: undefined, files: { [name]: "untrusted" } },
        fixture,
      ),
    );
  }
  await assert.rejects(readFile(join(root, "outside.md")));
  assert.equal(
    await readFile(join(fixture, "context.md"), "utf8"),
    scenario.context,
  );
});

test("claiming to inspect artifacts cannot substitute for successful read observations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scenario = await runner.loadScenario("review/evidence", scenarios);
  await runner.materializeScenario(scenario, root);
  const missing = await runner.scenarioReadCoverage(
    scenario,
    { successfulReads: [], failedTools: [] },
    root,
  );
  assert.equal(missing.length, 9);
  assert.ok(missing.every((r) => !r.read));
  const read = await runner.scenarioReadCoverage(
    scenario,
    {
      successfulReads: Object.keys(scenario.files!).map((name) =>
        join(root, name),
      ),
      failedTools: [],
    },
    root,
  );
  assert.ok(read.every((r) => r.read));
});

test("review reads allow only the selected skill and two shared evidence references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "fixture"),
    pkg = join(root, "package");
  const paths = [
    "skills/correctness-review/SKILL.md",
    "skills/development-workflow/references/pull-requests.md",
    "skills/development-workflow/references/verification.md",
    "skills/development-workflow/references/delivery.md",
  ];
  await mkdir(fixture);
  for (const path of paths) {
    await mkdir(dirname(join(pkg, path)), { recursive: true });
    await writeFile(join(pkg, path), "Fixture guidance.");
  }
  const scenario = await runner.loadScenario("review/evidence", scenarios);
  for (const mode of ["control", "package"]) {
    const options = runner.parseArguments([
      "--mode",
      mode,
      "--scenario",
      scenario.id,
      "--output",
      join(root, "output"),
      ...(mode === "package" ? ["--package", pkg] : []),
    ]);
    const reader = createReadTool(fixture, {
      operations: createProposalReadOperations(
        runner.scenarioReadPaths(options, scenario, fixture),
      ),
    });
    for (const path of paths.slice(0, 3)) {
      const reading = reader.execute("fixture-read", { path: join(pkg, path) });
      if (mode === "package") await reading;
      else await assert.rejects(reading);
    }
    await assert.rejects(
      reader.execute("outside-reference", { path: join(pkg, paths[3]) }),
    );
  }
});

test("review scoring rejects missing material gaps and invented execution", async () => {
  const scenario = await runner.loadScenario("review/evidence", scenarios);
  const response =
    "LIMIT limit-123 is supported within its pure-function scope. " +
    "CACHE cache-456 leaks cross-tenant invoices: warm the cache as tenant A, then read the same ID as tenant B; the hit bypasses authorization. " +
    "RETRY retry-789 is not established: its stub does not exercise implementation, restart is skipped, and retry-700 is old proof. " +
    "403 means inaccessible evidence, not fabrication. Production is deferred until after deployment. " +
    "I inspected artifact files; no commands were executed. Coordinate the missing live check without overwriting the reviewer's environment.";
  assert.equal(runner.evaluateScenario(scenario, response).passed, true);
  const paraphrase = response
    .replace(
      "stub does not exercise implementation",
      "test asserts a constant without calling the implementation",
    )
    .replace(
      "Production is deferred until after deployment",
      "Missing production observation is not a pre-merge blocker",
    );
  assert.equal(runner.evaluateScenario(scenario, paraphrase).passed, true);
  for (const bad of [
    response.replace("restart is skipped", "restart passed"),
    response.replace("retry-700", "candidate"),
    response.replace("403", "the artifact"),
    response + " I ran the tests.",
    response + " The 403 proves fabrication.",
    response + " I deleted review-retry.",
  ])
    assert.equal(runner.evaluateScenario(scenario, bad).passed, false);
});
