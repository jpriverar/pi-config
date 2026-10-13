import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readHistory, saveReport } from "../skills/standup/store.mjs";
import type { Coverage, RunRequest } from "../skills/standup/model.mjs";

const generated = "2026-10-13T14:05:00.000Z";
const body = "## Progress\nNo new progress.\n";
const coverage: Coverage[] = ["beads", "github", "sessions"].map((source) => ({
  source: source as Coverage["source"],
  status: "complete",
  checked: ["fixture"],
  limitations: [],
}));
const cli = fileURLToPath(
  new URL("../skills/standup/standup.mjs", import.meta.url),
);
const storeUrl = new URL("../skills/standup/store.mjs", import.meta.url).href;

function request(root: string): RunRequest {
  return {
    version: 1,
    id: randomUUID(),
    mode: "next",
    expectedHeadId: null,
    window: {
      start: "2026-10-12T14:00:00.000Z",
      end: "2026-10-13T14:00:00.000Z",
    },
    scope: {
      beadsDir: root,
      sessionsRoot: root,
      github: [{ host: "github.com", login: "example", owners: [] }],
    },
  };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "standup-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("saves complete empty reports privately and advances contiguous windows", async (t) => {
  const root = await fixture(t);
  const first = request(root);
  assert.equal((await readHistory(root)).head, null);
  const saved = await saveReport(root, first, coverage, body, generated);
  assert.equal((await readHistory(root)).head?.meta.id, first.id);
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "reports"))).mode & 0o777, 0o700);
  const next = {
    ...first,
    id: randomUUID(),
    expectedHeadId: first.id,
    window: { start: first.window.end, end: "2026-10-14T14:00:00.000Z" },
  };
  await saveReport(root, next, coverage, body, "2026-10-14T14:05:00.000Z");
  assert.equal(
    (await readHistory(root)).head?.meta.window.end,
    "2026-10-14T14:00:00.000Z",
  );
});

test("failed saves preserve existing report bytes and checkpoint", async (t) => {
  const root = await fixture(t);
  const first = request(root);
  const saved = await saveReport(root, first, coverage, body, generated);
  const original = await readFile(saved.path, "utf8");
  const next: RunRequest = {
    ...first,
    id: randomUUID(),
    expectedHeadId: first.id,
    window: { start: first.window.end, end: "2026-10-14T14:00:00.000Z" },
  };
  const later = "2026-10-14T14:05:00.000Z";
  await assert.rejects(
    saveReport(
      root,
      next,
      [...coverage.slice(0, 2), { ...coverage[2], status: "incomplete" }],
      body,
      later,
    ),
    /incomplete/i,
  );
  await assert.rejects(
    saveReport(root, next, coverage.slice(0, 2), body, later),
    /coverage/i,
  );
  await assert.rejects(
    saveReport(root, { ...next, expectedHeadId: null }, coverage, body, later),
    /stale|predecessor/i,
  );
  await assert.rejects(
    saveReport(
      root,
      {
        ...next,
        scope: {
          ...next.scope,
          github: [{ host: "github.com", login: "different", owners: [] }],
        },
      },
      coverage,
      body,
      later,
    ),
    /scope/i,
  );
  await assert.rejects(
    saveReport(root, { ...next, window: first.window }, coverage, body, later),
    /contiguous|start/i,
  );
  assert.equal((await readHistory(root)).head?.meta.id, first.id);
  assert.equal(await readFile(saved.path, "utf8"), original);
});

test("identical retry recovers after lost response without retimestamping", async (t) => {
  const root = await fixture(t);
  const run = request(root);
  const first = await saveReport(root, run, coverage, body, generated);
  await mkdir(join(root, ".lock"));
  const retry = await saveReport(
    root,
    run,
    coverage,
    body,
    "2026-10-14T14:00:00.000Z",
  );
  assert.equal(retry.alreadySaved, true);
  assert.equal(retry.path, first.path);
  assert.equal((await readHistory(root)).head?.meta.generatedAt, generated);
  await assert.rejects(
    saveReport(root, run, coverage, "different body", generated),
    /conflict|different/i,
  );
});

test("regeneration retains prior text and cannot change its interval", async (t) => {
  const root = await fixture(t);
  const first = request(root);
  const original = await saveReport(root, first, coverage, body, generated);
  const revision: RunRequest = {
    ...first,
    id: randomUUID(),
    mode: "regenerate",
    expectedHeadId: first.id,
  };
  await saveReport(
    root,
    revision,
    coverage,
    "## Progress\nRevised wording.\n",
    generated,
  );
  const history = await readHistory(root);
  assert.equal(history.reports.length, 2);
  assert.equal(history.head?.meta.revisesId, first.id);
  assert.deepEqual(history.head?.meta.window, first.window);
  assert.match(await readFile(original.path, "utf8"), /No new progress/);
  await assert.rejects(
    saveReport(
      root,
      {
        ...revision,
        id: randomUUID(),
        expectedHeadId: revision.id,
        window: { ...first.window, end: "2026-10-14T14:00:00.000Z" },
      },
      coverage,
      body,
      "2026-10-14T14:05:00.000Z",
    ),
    /interval|window/i,
  );
});

test("existing lock refuses a new save and preserves unrelated files", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "notes.txt"), "keep");
  await mkdir(join(root, ".lock"));
  await assert.rejects(
    saveReport(root, request(root), coverage, body, generated),
    /lock/i,
  );
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "keep");
  assert.equal((await readHistory(root)).head, null);
  assert.equal((await stat(join(root, ".lock"))).isDirectory(), true);
});

test("rejects symlink roots and report files without overwriting their targets", async (t) => {
  const parent = await fixture(t);
  const target = join(parent, "target");
  await mkdir(target, { mode: 0o700 });
  const link = join(parent, "alias");
  await symlink(target, link);
  await assert.rejects(
    saveReport(link, request(parent), coverage, body, generated),
    /symlink|unsafe/i,
  );
  await mkdir(join(target, "reports"), { mode: 0o700 });
  const outside = join(parent, "private.txt");
  await writeFile(outside, "private");
  await symlink(outside, join(target, "reports", `${randomUUID()}.md`));
  await assert.rejects(readHistory(target), /symlink|unsafe/i);
  assert.equal(await readFile(outside, "utf8"), "private");
});

test("malformed or forked committed history fails closed", async (t) => {
  const root = await fixture(t);
  const first = request(root);
  const saved = await saveReport(root, first, coverage, body, generated);
  const duplicate = randomUUID();
  await writeFile(
    join(root, "reports", `${duplicate}.md`),
    (await readFile(saved.path, "utf8")).replace(first.id, duplicate),
  );
  await assert.rejects(readHistory(root), /history|root|chain/i);
  await writeFile(join(root, "reports", `${duplicate}.md`), "broken metadata");
  await assert.rejects(readHistory(root), /metadata|report/i);
});

test("two independent processes cannot both publish from the same predecessor", async (t) => {
  const root = await fixture(t);
  const launch = (run: RunRequest) =>
    new Promise<number | null>((resolve) => {
      const source = `import {saveReport} from ${JSON.stringify(storeUrl)}; await saveReport(${JSON.stringify(root)},${JSON.stringify(run)},${JSON.stringify(coverage)},${JSON.stringify(body)},${JSON.stringify(generated)});`;
      const child = spawn("node", ["--input-type=module", "-e", source], {
        stdio: "ignore",
      });
      child.on("exit", resolve);
    });
  const results = await Promise.all([
    launch(request(root)),
    launch(request(root)),
  ]);
  assert.equal(results.filter((code) => code === 0).length, 1);
  assert.equal((await readHistory(root)).reports.length, 1);
});

test("CLI works outside checkout, prepares without writes, and rejects start override", async (t) => {
  const root = await fixture(t);
  const files = await fixture(t);
  const scope = join(files, "scope.json");
  await writeFile(scope, JSON.stringify(request(files).scope));
  const run = JSON.parse(
    execFileSync(
      "node",
      [
        cli,
        "prepare",
        "--root",
        root,
        "--scope",
        scope,
        "--since",
        "2026-10-12T00:00:00Z",
      ],
      { cwd: files, encoding: "utf8" },
    ),
  ) as RunRequest;
  assert.equal(run.expectedHeadId, null);
  assert.equal((await readdir(root)).length, 0);
  const req = join(files, "request.json"),
    cov = join(files, "coverage.json"),
    md = join(files, "body.md");
  await writeFile(req, JSON.stringify(run));
  await writeFile(cov, JSON.stringify(coverage));
  await writeFile(md, body);
  const args = [
    cli,
    "save",
    "--root",
    root,
    "--request",
    req,
    "--coverage",
    cov,
    "--body",
    md,
  ];
  const saved = JSON.parse(
    execFileSync("node", args, { cwd: files, encoding: "utf8" }),
  );
  assert.equal(saved.id, run.id);
  assert.equal(
    JSON.parse(execFileSync("node", args, { cwd: files, encoding: "utf8" }))
      .alreadySaved,
    true,
  );
  assert.throws(
    () =>
      execFileSync(
        "node",
        [
          cli,
          "prepare",
          "--root",
          root,
          "--scope",
          scope,
          "--since",
          "2026-10-12",
        ],
        { cwd: files, stdio: "pipe" },
      ),
    /since|start/i,
  );
});
