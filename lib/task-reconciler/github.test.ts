import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createDaemonCheckAdapters } from "./github.js";
import { loadDaemonConfig } from "./config.js";
import { configFixture } from "./test-fixtures.js";
import type { Artifact, LifecycleCheck } from "../task-lifecycle/types.js";

function input(uri = "https://github.com/Example/repo/pull/1") {
  const artifact: Artifact = {
    id: "pr",
    kind: "pull_request",
    uri,
    title: "PR",
    role: "deliverable",
    sourceArtifactIds: [],
    producedAt: "2026-01-01T00:00:00Z",
    supersededAt: null,
  };
  const check: LifecycleCheck = {
    id: "check",
    kind: "github_pull_request",
    targetArtifactIds: ["pr"],
    predicate: { mode: "all" },
    onSatisfied: "actionable",
    wakeOn: [],
    state: "pending",
    createdAt: artifact.producedAt,
    lastCheckedAt: null,
    nextCheckAt: null,
    lastObservation: null,
    errorCount: 0,
  };
  return { check, artifacts: [artifact] };
}

async function setup(t: TestContext, authFailure = false) {
  const f = await configFixture(t);
  const gh = join(f.root, "fixture-gh.mjs");
  const callsPath = join(f.root, "calls.jsonl");
  await writeFile(
    gh,
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,tokenPresent:!!process.env.GH_TOKEN,tokenMatches:process.env.GH_TOKEN==='fixture-account-one'})+'\\n');\nif(args[0]==='auth'){if(${authFailure}){console.error('private-credential-output');process.exit(1);}console.log('fixture-'+args[args.length-1]);}else{console.log(JSON.stringify({state:'MERGED',reviewDecision:'APPROVED',mergeStateStatus:'CLEAN',mergedAt:'2026-01-02T00:00:00Z'}));}\n`,
    { mode: 0o755 },
  );
  f.raw.executables = {
    node: process.execPath,
    bd: process.execPath,
    git: process.execPath,
    gh,
  };
  await f.save();
  return { ...f, config: await loadDaemonConfig(f.configPath), callsPath };
}

test("obtains the explicitly mapped account token per PR without switching accounts", async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "fixture-parent-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const f = await setup(t);
  const adapters = createDaemonCheckAdapters(f.config);
  await assert.rejects(access(f.callsPath));
  const { check, artifacts } = input();
  assert.equal((await adapters.observe(check, artifacts)).outcome, "satisfied");
  const calls = (await readFile(f.callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls[0].args, [
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "account-one",
  ]);
  assert.equal(calls[0].tokenPresent, false);
  assert.deepEqual(calls[1].args, [
    "pr",
    "view",
    artifacts[0].uri,
    "--json",
    "state,reviewDecision,mergeStateStatus,mergedAt",
  ]);
  assert.equal(calls[1].tokenMatches, true);
  assert.equal(calls.length, 2);
});

test("missing mappings and noncanonical hosts never cause credential access", async (t) => {
  const f = await setup(t);
  const adapters = createDaemonCheckAdapters(f.config);
  for (const uri of [
    "https://github.com/Unconfigured/repo/pull/1",
    "https://opensource.org/Example/repo/pull/1",
    "https://user:secret@github.com/Example/repo/pull/1",
    "https://github.com/Example/repo/pull/1?secret=value",
  ]) {
    const { check, artifacts } = input(uri);
    const result = await adapters.observe(check, artifacts);
    assert.equal(result.outcome, "error");
    assert.ok(!result.observation.includes("secret"));
  }
  await assert.rejects(access(f.callsPath));
});

test("credential errors become curated check errors rather than prompts", async (t) => {
  const f = await setup(t, true);
  const { check, artifacts } = input();
  const result = await createDaemonCheckAdapters(f.config).observe(
    check,
    artifacts,
  );
  assert.equal(result.outcome, "error");
  assert.match(result.observation, /authenticat|credential/i);
  assert.ok(!JSON.stringify(result).includes("private-credential-output"));
  const calls = (await readFile(f.callsPath, "utf8")).trim().split("\n");
  assert.equal(calls.length, 1);
});

test("aborted checks do not start auth or PR commands", async (t) => {
  const f = await setup(t);
  const { check, artifacts } = input();
  const result = await createDaemonCheckAdapters(f.config).observe(
    check,
    artifacts,
    { signal: AbortSignal.abort() },
  );
  assert.equal(result.outcome, "error");
  await assert.rejects(access(f.callsPath));
});
