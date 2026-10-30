import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHerdrMetadataSender } from "./herdr-transport.js";
import type { PaneMetadata } from "./herdr-values.js";

const environment = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_SOCKET_PATH: "/tmp/test.sock",
  HERDR_BIN_PATH: "/test/herdr",
};
const values: PaneMetadata = {
  displayAgent: "jp-one • Review auth; stay safe",
  pi_waiting: null,
  pi_model: "Model $(touch nope)",
  pi_task: "Review auth; stay safe",
  pi_task_state: "assigned",
  pi_task_phase: "active",
  pi_task_status: "In progress",
  pi_task_id: "jp-one",
  pi_task_expires_at: "2000000",
  pi_project: "API",
  pi_area: "Product",
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
    "--agent",
    "pi",
    "--seq",
    "12",
    "--display-agent",
    "jp-one • Review auth; stay safe",
    "--token",
    "pi_model=Model $(touch nope)",
    "--token",
    "pi_task=Review auth; stay safe",
    "--token",
    "pi_task_state=assigned",
    "--token",
    "pi_task_phase=active",
    "--token",
    "pi_task_status=In progress",
    "--token",
    "pi_task_id=jp-one",
    "--token",
    "pi_task_expires_at=2000000",
    "--token",
    "pi_project=API",
    "--token",
    "pi_area=Product",
    "--clear-token",
    "pi_context_warning",
    "--token",
    "pi_context_critical=Context 90%",
    "--clear-token",
    "pi_waiting",
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

test("placement changes publish or clear tokens without refreshing space counts", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return replyFor(args);
  })!;
  const signal = new AbortController().signal;
  assert.equal(await send(values, 1, signal), true);
  assert.equal(await send({ ...values, pi_area: "Tools" }, 2, signal), true);
  assert.equal(calls.length, 4);
  assert.ok(calls[3].includes("pi_area=Tools"));
  assert.equal(
    await send({ ...values, pi_project: null, pi_area: null }, 3, signal),
    true,
  );
  assert.equal(calls.length, 5);
  for (const key of ["pi_project", "pi_area"]) {
    const index = calls[4].indexOf(key);
    assert.ok(index > 0);
    assert.equal(calls[4][index - 1], "--clear-token");
  }
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

test("display labels use only fallback metadata and clear only their own field", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return replyFor(args);
  })!;
  const signal = new AbortController().signal;
  await send(
    { ...values, displayAgent: " jp-one • Fix\n \u001b[31m$(touch nope) " },
    1,
    signal,
  );
  const args = calls[0];
  assert.equal(
    args[args.indexOf("--display-agent") + 1],
    "jp-one • Fix $(touch nope)",
  );
  assert.ok(!args.includes("--title") && !args.includes("--clear-title"));
  for (const displayAgent of [null, "\n "]) {
    calls.length = 0;
    await send({ ...values, displayAgent }, 2, signal);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("--clear-display-agent"));
    assert.ok(
      !calls[0].includes("--clear-title") &&
        !calls[0].includes("--display-agent"),
    );
    assert.deepEqual(calls[0].slice(0, 5), [
      "pane",
      "report-metadata",
      "w1:p2",
      "--source",
      "jp:pi-sidebar",
    ]);
  }
});

test("display metadata is scoped to Pi without claiming lifecycle authority", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return replyFor(args);
  })!;
  await send(values, 1, new AbortController().signal);
  assert.deepEqual(calls[0].slice(0, 3), ["pane", "report-metadata", "w1:p2"]);
  assert.equal(calls[0][calls[0].indexOf("--agent") + 1], "pi");
  assert.ok(
    calls.every(
      (args) =>
        !args.includes("report-agent") && !args.includes("release-agent"),
    ),
  );
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

test("waiting labels are sanitized, cleared, and do not refresh task counts", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return replyFor(args);
  })!;
  const signal = new AbortController().signal;
  await send(values, 1, signal);
  calls.length = 0;
  await send(
    { ...values, pi_waiting: "Waiting\n\x1b[31m until 15:05 UTC" },
    2,
    signal,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("pi_waiting=Waiting until 15:05 UTC"));
  await send({ ...values, pi_waiting: null }, 3, signal);
  assert.equal(calls.length, 2);
  const index = calls[1].indexOf("pi_waiting");
  assert.ok(index > 0);
  assert.equal(calls[1][index - 1], "--clear-token");
});

test("phase-only updates publish status without conflating ownership or triggering new space polling", async () => {
  const calls: string[][] = [];
  const send = createHerdrMetadataSender(environment, async (_file, args) => {
    calls.push([...args]);
    return replyFor(args);
  })!;
  const signal = new AbortController().signal;
  await send(
    { ...values, pi_task_phase: "active", pi_task_status: "In progress" },
    1,
    signal,
  );
  await send(
    {
      ...values,
      pi_task_phase: "waiting",
      pi_task_status: "Blocked",
      pi_waiting: "Waiting until 15:05",
    },
    2,
    signal,
  );
  assert.equal(calls.length, 4);
  assert.ok(calls[3].includes("pi_task_phase=waiting"));
  assert.ok(calls[3].includes("pi_task_status=Blocked"));
  assert.ok(calls[3].includes("pi_task_state=assigned"));
  assert.ok(calls[3].includes("pi_waiting=Waiting until 15:05"));
});
