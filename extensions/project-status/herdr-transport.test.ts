import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHerdrMetadataSender } from "./herdr-transport.js";
import type { PaneTokens } from "./herdr-values.js";

const environment = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_SOCKET_PATH: "/tmp/test.sock",
  HERDR_BIN_PATH: "/test/herdr",
};
const values: PaneTokens = {
  pi_model: "Model $(touch nope)",
  pi_task: "Review auth; stay safe",
  pi_context_warning: null,
  pi_context_critical: "Context 90%",
};

test("requires complete Herdr caller context before creating a sender", () => {
  assert.equal(createHerdrMetadataSender({}), undefined);
  assert.equal(
    createHerdrMetadataSender({ ...environment, HERDR_ENV: "0" }),
    undefined,
  );
  assert.equal(
    createHerdrMetadataSender({ ...environment, HERDR_PANE_ID: "" }),
    undefined,
  );
  assert.equal(
    createHerdrMetadataSender({ ...environment, HERDR_SOCKET_PATH: "" }),
    undefined,
  );
});

test("publishes only owned keys with argv, sequence and finite execution limits", async () => {
  const calls: any[] = [];
  const send = createHerdrMetadataSender(
    environment,
    async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: JSON.stringify({ result: { type: "pane_metadata" } }) };
    },
  )!;
  assert.equal(await send(values, 12, new AbortController().signal), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/test/herdr");
  assert.deepEqual(calls[0].args, [
    "pane",
    "report-metadata",
    "w1:p2",
    "--source",
    "jp:pi-sidebar",
    "--seq",
    "12",
    "--token",
    "pi_model=Model $(touch nope)",
    "--token",
    "pi_task=Review auth; stay safe",
    "--clear-token",
    "pi_context_warning",
    "--token",
    "pi_context_critical=Context 90%",
  ]);
  assert.equal(calls[0].options.timeout, 1500);
  assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  assert.equal(calls[0].options.env.HERDR_SOCKET_PATH, "/tmp/test.sock");
});

for (const stdout of [
  "not json",
  "{}",
  '{"result":null}',
  '{"error":{"code":"not_found"}}',
]) {
  test(`rejects non-success acknowledgment: ${stdout}`, async () => {
    const send = createHerdrMetadataSender(environment, async () => ({
      stdout,
    }))!;
    assert.equal(await send(values, 1, new AbortController().signal), false);
  });
}

test("does not retry missing executable or start cancelled work", async () => {
  let calls = 0;
  const send = createHerdrMetadataSender(environment, async () => {
    calls++;
    throw new Error("ENOENT");
  })!;
  assert.equal(await send(values, 1, new AbortController().signal), false);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await send(values, 2, cancelled.signal), false);
  assert.equal(calls, 1);
});

test("the real subprocess adapter terminates a hung command", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-transport-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, "herdr");
  await writeFile(
    executable,
    `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  const send = createHerdrMetadataSender({
    ...process.env,
    ...environment,
    HERDR_BIN_PATH: executable,
  })!;
  const start = Date.now();
  assert.equal(await send(values, 1, new AbortController().signal), false);
  assert.ok(
    Date.now() - start < 5000,
    "hung reporter exceeded its bounded timeout",
  );
});
