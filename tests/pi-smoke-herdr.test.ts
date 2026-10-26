import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));

test("Pi smoke never sends fixture metadata to the caller's Herdr pane", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-smoke-herdr-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "herdr");
  const callsPath = join(directory, "calls.jsonl");
  await writeFile(callsPath, "");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "plugin") console.log(JSON.stringify({ result: { plugins: [] } }));
`,
    { mode: 0o700 },
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
  );
  const result = await execute(
    process.execPath,
    ["--import", "tsx", join(repository, "tests/pi-smoke.ts")],
    {
      cwd: repository,
      env: {
        ...environment,
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p2",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t1",
        HERDR_SESSION: "smoke-sentinel",
        HERDR_SOCKET_PATH: join(directory, "not-live.sock"),
        HERDR_CLIENT_SOCKET_PATH: join(directory, "not-live-client.sock"),
        HERDR_BIN_PATH: executable,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.match(result.stdout, /Pi package smoke verified/);
  const calls = (await readFile(callsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls, [], "smoke must not invoke the caller's Herdr");
});
