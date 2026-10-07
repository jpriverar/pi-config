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
  pi_task_state: "assigned",
  pi_task_id: "jp-one",
  pi_task_expires_at: "2000000",
  pi_context_warning: null,
  pi_context_critical: "Context 90%",
};

function replyFor(args: readonly string[]) {
  return {
    stdout: JSON.stringify({
      result:
        args[0] === "pane"
          ? { type: "pane_metadata" }
          : args[1] === "list"
            ? { plugins: [{ plugin_id: "jp.space-tabs", enabled: true }] }
            : { type: "plugin_action_invoked" },
    }),
  };
}

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
      return replyFor(args);
    },
  )!;
  assert.equal(await send(values, 12, new AbortController().signal), true);
  assert.equal(calls.length, 3);
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
    "--token",
    "pi_task_state=assigned",
    "--token",
    "pi_task_id=jp-one",
    "--token",
    "pi_task_expires_at=2000000",
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

test("accepts the installed Herdr CLI's silent successful metadata write", async () => {
  const send = createHerdrMetadataSender(environment, async (_file, args) =>
    args[0] === "pane" ? { stdout: "" } : replyFor(args),
  )!;
  assert.equal(await send(values, 1, new AbortController().signal), true);
});

test("refreshes space counts after ownership changes but not model-only writes", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return replyFor(args);
  })!;
  const signal = new AbortController().signal;
  assert.equal(await send(values, 1, signal), true);
  assert.deepEqual(calls.slice(1), [
    ["plugin", "list", "--json"],
    ["plugin", "action", "invoke", "jp.space-tabs.refresh"],
  ]);
  assert.equal(
    await send({ ...values, pi_model: "Another model" }, 2, signal),
    true,
  );
  assert.equal(calls.length, 4);
  assert.equal(
    await send({ ...values, pi_task_expires_at: "3000000" }, 3, signal),
    true,
  );
  assert.equal(calls.length, 5);
  assert.equal(
    await send(
      {
        ...values,
        pi_task: "Unassigned",
        pi_task_state: "unassigned",
        pi_task_id: null,
        pi_task_expires_at: null,
      },
      4,
      signal,
    ),
    true,
  );
  assert.equal(calls.length, 8);
});

for (const plugins of [[], [{ plugin_id: "jp.space-tabs", enabled: false }]]) {
  test(`keeps pane metadata usable with optional plugin state ${JSON.stringify(plugins)}`, async () => {
    const calls: string[][] = [];
    const send = createHerdrMetadataSender(environment, async (_file, args) => {
      calls.push([...args]);
      return args[0] === "pane"
        ? { stdout: "" }
        : { stdout: JSON.stringify({ result: { plugins } }) };
    })!;
    assert.equal(await send(values, 1, new AbortController().signal), true);
    assert.deepEqual(calls.slice(1), [["plugin", "list", "--json"]]);
  });
}

test("failed refresh is retried only on the next delivery, after metadata acknowledgment", async () => {
  let fail = true;
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    if (args[1] === "action" && fail) throw new Error("socket timeout");
    return replyFor(args);
  })!;
  const signal = new AbortController().signal;
  assert.equal(await send(values, 1, signal), false);
  assert.equal(calls.length, 3);
  fail = false;
  assert.equal(await send(values, 2, signal), true);
  assert.equal(calls.length, 6);
});

test("a rejected metadata write never triggers count refresh", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return { stdout: '{"error":{"code":"not_found"}}' };
  })!;
  assert.equal(await send(values, 1, new AbortController().signal), false);
  assert.equal(calls.length, 1);
});

test("obsolete deadline changes alone do not refresh task counts", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return replyFor(args);
  })!;
  const signal = new AbortController().signal;
  assert.equal(await send(values, 1, signal), true);
  assert.equal(calls.length, 3);
  assert.equal(
    await send({ ...values, pi_task_expires_at: "1" }, 2, signal),
    true,
  );
  assert.equal(calls.length, 4);
});
