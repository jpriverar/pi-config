import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { waitingTask } from "../lib/task-reconciler/test-fixtures.js";
import { runReadonlyProbe } from "./task-reconciler-readonly-probe.js";

test("read-only probe requires an explicit store and rejects execution flags", async () => {
  await assert.rejects(runReadonlyProbe([]), /--db/);
  await assert.rejects(
    runReadonlyProbe([
      "--db",
      "/tmp/store",
      "--bd",
      process.execPath,
      "--execute",
    ]),
    /unsupported/,
  );
});
test("read-only probe counts bulk selection without changing lifecycle data", async (t) => {
  const root = await fs.mkdtemp("/tmp/pi-recs-probe-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bd = join(root, "bd.mjs");
  const source = await fs.readFile(
    new URL("./fixtures/task-reconciler/store.mjs", import.meta.url),
    "utf8",
  );
  await fs.writeFile(bd, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const blocker = waitingTask("dependent");
  blocker.lifecycle!.waiting = { kind: "dependency" };
  blocker.lifecycle!.activeCheck = null;
  const before = JSON.stringify([
    waitingTask("due"),
    {
      ...blocker,
      dependencies: [
        { id: "missing", status: "open", dependency_type: "blocks" },
      ],
    },
  ]);
  await fs.writeFile(join(root, "rows.json"), before);
  const result = await runReadonlyProbe(["--db", root, "--bd", bd]);
  assert.equal(result.examined, 2);
  assert.equal(result.selected, 1);
  assert.equal(result.commands.total, 2);
  assert.equal(result.diagnostics.blocker_unavailable, 1);
  assert.deepEqual(result.reasons, { check: 1 });
  assert.equal(await fs.readFile(join(root, "rows.json"), "utf8"), before);
  const calls = (await fs.readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["list", "show"],
  );
});
