import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { loadDaemonConfig } from "./config.js";
import { createDaemonRuntime } from "./runtime.js";
import { configFixture, waitingTask } from "./test-fixtures.js";

test("composes the standalone runtime without running commands before start", async (t) => {
  const f = await configFixture(t);
  const bd = join(f.root, "fixture-bd.mjs");
  const calls = join(f.root, "calls.jsonl");
  const data = join(f.root, "issues.json");
  const { id, title, status, metadata, dependencies } = waitingTask("due");
  await writeFile(
    data,
    JSON.stringify([{ id, title, status, metadata, dependencies }]),
  );
  await writeFile(
    bd,
    `#!${process.execPath}\nimport {readFileSync,writeFileSync,appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2); const rows=JSON.parse(readFileSync(${JSON.stringify(data)},'utf8')); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');\nif(args[0]==='list') console.log(JSON.stringify(rows));\nelse if(args[0]==='show') console.log(JSON.stringify(rows.filter(x=>args.slice(1,args.indexOf('--long')).includes(x.id))));\nelse if(args[0]==='update'){const row=rows.find(x=>x.id===args[1]);row.status=args[args.indexOf('-s')+1];row.metadata=JSON.parse(args[args.indexOf('--metadata')+1]);writeFileSync(${JSON.stringify(data)},JSON.stringify(rows));console.log(JSON.stringify(row));}\nelse process.exit(9);\n`,
    { mode: 0o755 },
  );
  f.raw.executables = {
    node: process.execPath,
    bd,
    git: process.execPath,
    gh: process.execPath,
  };
  await f.save();
  const config = await loadDaemonConfig(f.configPath);
  const runtime = await createDaemonRuntime(config, {
    pid: process.pid,
    host: hostname(),
    sessionId: "daemon-test",
    started: Date.now(),
  });
  try {
    await assert.rejects(access(calls));
    runtime.start();
    const deadline = Date.now() + 10_000;
    while (true) {
      const saved = JSON.parse(await readFile(data, "utf8"));
      if (saved[0].metadata.piLifecycle.phase === "actionable") break;
      assert.ok(Date.now() < deadline, JSON.stringify(runtime.snapshot()));
      await delay(10);
    }
    const commands = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(commands.filter((args) => args[0] === "update").length, 1);
    assert.ok(
      commands.every(
        (args) => args.at(-2) === "--db" && args.at(-1) === config.store,
      ),
    );
  } finally {
    await runtime.stop();
  }
});
