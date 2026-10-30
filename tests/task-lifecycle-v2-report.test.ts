import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import {
  createActionableLifecycle,
  claimLifecycle,
} from "../lib/task-lifecycle/model.js";
import { NOW } from "../lib/task-lifecycle/v2-test-fixtures.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-v2-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = [
    {
      id: "zz-one",
      title: "Owned",
      status: "in_progress",
      dependencies: [],
      metadata: {
        piLifecycle: claimLifecycle(createActionableLifecycle(NOW), {
          operationId: "claim",
          sessionId: "existing-session",
          now: NOW,
          expiresAt: NOW,
          resourceSnapshot: { observedAt: NOW, resourceIds: [] },
        }),
      },
    },
  ];
  const data = join(root, "source.json"),
    calls = join(root, "calls.jsonl"),
    output = join(root, "report.json");
  await writeFile(data, JSON.stringify(source));
  await writeFile(
    join(root, "bd"),
    `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({args:a,backup:process.env.BD_BACKUP_ENABLED,store:process.env.BEADS_DIR})+'\\n');if(!['list','show'].includes(a[0]))throw new Error('mutation forbidden');let rows=JSON.parse(fs.readFileSync(process.env.TEST_DATA));if(a[0]==='show'&&process.env.TEST_INCOMPLETE==='1')rows=[];console.log(JSON.stringify(rows));\n`,
  );
  await chmod(join(root, "bd"), 0o700);
  async function run(args: string[], extra: Record<string, string> = {}) {
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/report-task-lifecycle-v2.ts"),
          ...args,
        ],
        {
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            BEADS_DIR: "/must-not-use",
            BEADS_DB: "/must-not-use",
            TEST_DATA: data,
            TEST_CALLS: calls,
            ...extra,
          },
          timeout: 20_000,
          maxBuffer: 1_000_000,
        },
      );
      return { code: 0, ...result };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }
  return {
    root,
    source,
    data,
    calls,
    output,
    run,
    args: ["--store", root, "--output", output],
  };
}

test("report runs only native reads against the explicit isolated store and writes a private review artifact", async (t) => {
  const h = await fixture(t);
  const result = await h.run(h.args);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(h.output, "utf8"));
  assert.equal(
    report.proposals[0].lifecycle.owner.sessionId,
    "existing-session",
  );
  assert.deepEqual(report.diagnostics, []);
  const calls = (await readFile(h.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ["list", "show"],
  );
  for (const flag of [
    "--all",
    "--include-gates",
    "--include-infra",
    "--include-templates",
  ])
    assert.ok(calls[0].args.includes(flag));
  assert.equal(calls[0].args[calls[0].args.indexOf("-n") + 1], "0");
  assert.ok(
    calls.every((c) => c.args[c.args.indexOf("--db") + 1] === report.storePath),
  );
  assert.ok(
    calls.every(
      (c) =>
        c.backup === "false" &&
        c.store !== "/must-not-use" &&
        c.args.includes("--db"),
    ),
  );
  assert.deepEqual(JSON.parse(await readFile(h.data, "utf8")), h.source);
  assert.equal((await stat(h.output)).mode & 0o777, 0o600);
});

for (const invalid of ["apply", "implicit-store", "incomplete"] as const) {
  test(`report refuses ${invalid} rather than silently converting or omitting tasks`, async (t) => {
    const h = await fixture(t);
    const args =
      invalid === "apply"
        ? [...h.args, "--apply"]
        : invalid === "implicit-store"
          ? ["--output", h.output]
          : h.args;
    const result = await h.run(
      args,
      invalid === "incomplete" ? { TEST_INCOMPLETE: "1" } : {},
    );
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      invalid === "incomplete" ? /incomplete/ : /Usage:/,
    );
    await assert.rejects(readFile(h.output), { code: "ENOENT" });
    if (invalid !== "incomplete")
      await assert.rejects(readFile(h.calls), { code: "ENOENT" });
  });
}

for (const classified of [false, true]) {
  test(`report ${classified ? "uses explicit classification" : "saves blocking classification diagnostics"} without mutating source`, async (t) => {
    const { check } = await import("../lib/task-lifecycle/v2-test-fixtures.js");
    const h = await fixture(t);
    const source = h.source;
    source[0].metadata.piLifecycle.waiting = { kind: "check" };
    source[0].metadata.piLifecycle.activeCheck = check();
    await writeFile(h.data, JSON.stringify(source));
    const args = [...h.args];
    if (classified) {
      const classifications = join(h.root, "classifications.json");
      await writeFile(
        classifications,
        JSON.stringify({
          "zz-one": {
            purpose: "completion",
            reason: "Keep existing requirement",
          },
        }),
        { mode: 0o600 },
      );
      args.push("--classifications", classifications);
    }
    const result = await h.run(args);
    assert.equal(result.code, classified ? 0 : 2, result.stderr);
    const report = JSON.parse(await readFile(h.output, "utf8"));
    if (classified)
      assert.equal(
        report.proposals[0].lifecycle.condition.purpose,
        "completion",
      );
    else assert.match(report.diagnostics.join("\n"), /classification/);
    assert.deepEqual(JSON.parse(await readFile(h.data, "utf8")), source);
  });
}

test("report refuses an oversized classification file before native reads", async (t) => {
  const h = await fixture(t);
  const classifications = join(h.root, "classifications.json");
  await writeFile(
    classifications,
    JSON.stringify({
      "zz-one": { purpose: "completion", reason: "x".repeat(1024 * 1024) },
    }),
    { mode: 0o600 },
  );
  const result = await h.run([...h.args, "--classifications", classifications]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bounded file/);
  await assert.rejects(readFile(h.calls), { code: "ENOENT" });
  await assert.rejects(readFile(h.output), { code: "ENOENT" });
});

test("report refuses a complete store above 16 MiB without pruning it", async (t) => {
  const h = await fixture(t);
  const source = Array.from({ length: 350 }, (_, index) => ({
    id: `zz-large-${index}`,
    title: `Task ${index}`,
    description: "evidence ".repeat(6400),
    status: "open",
    dependencies: [],
    metadata: { piLifecycle: createActionableLifecycle(NOW) },
  }));
  const original = JSON.stringify(source);
  await writeFile(h.data, original);
  const result = await h.run(h.args);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /private JSON exceeds limit/);
  await assert.rejects(readFile(h.output), { code: "ENOENT" });
  assert.equal(await readFile(h.data, "utf8"), original);
});

test("report preserves a complete store exceeding the catalog file budget", async (t) => {
  const h = await fixture(t);
  const source = Array.from({ length: 350 }, (_, index) => ({
    id: `zz-many-${index}`,
    title: `Task ${index}`,
    description: "evidence ".repeat(512),
    status: "open",
    dependencies: [],
    metadata: {
      piLifecycle: createActionableLifecycle(NOW),
      retainedEvidence: { index },
    },
  }));
  await writeFile(h.data, JSON.stringify(source));
  const result = await h.run(h.args);
  assert.equal(result.code, 0, result.stderr);
  const bytes = await readFile(h.output);
  assert.ok(bytes.length > 1024 * 1024);
  const report = JSON.parse(bytes.toString("utf8"));
  assert.equal(report.source.length, 350);
  assert.equal(report.proposals.length, 350);
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(
    report.source.map(
      ({ id, description, metadata }: (typeof source)[number]) => ({
        id,
        description,
        metadata,
      }),
    ),
    source.map(({ id, description, metadata }) => ({
      id,
      description,
      metadata,
    })),
  );
  assert.deepEqual(JSON.parse(await readFile(h.data, "utf8")), source);
  assert.equal((await stat(h.output)).mode & 0o777, 0o600);
});
