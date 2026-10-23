import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerWakeupTools } from "../extensions/wakeups/index.js";
import type { WakeupState } from "../lib/wakeups.js";

async function harness(t: TestContext, version = "1.2.0") {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2026, 1, 1),
  });
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const tools = new Map<string, ToolDefinition>();
  const commands: string[] = [];
  const messages: Array<{
    content: unknown;
    customType: string;
    options: unknown;
  }> = [];
  const notices: string[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const events = new EventEmitter();
  const labels: unknown[] = [];
  events.on("pi:wakeup-waiting", (label) => labels.push(label));
  let footer: string | undefined;
  let idle = true;
  let queued = false;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/fixture",
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, value: string | undefined) => {
        footer = value;
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string) => commands.push(name),
    on(
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage(
      message: { customType: string; content: unknown },
      options: unknown,
    ) {
      messages.push({ ...message, options });
    },
    sendUserMessage() {
      assert.fail("Wakeups must not impersonate fresh user input");
    },
  } as unknown as ExtensionAPI;
  registerWakeupTools(pi, version);
  async function emit(name: string, fields = {}) {
    if (name === "before_agent_start" || name === "agent_start") idle = false;
    if (name === "agent_settled") idle = true;
    for (const handler of handlers.get(name) ?? [])
      await handler({ type: name, ...fields }, ctx);
  }
  async function call(
    name: string,
    params = {},
    signal?: AbortSignal,
  ): Promise<WakeupState> {
    const tool = tools.get(name);
    assert.ok(tool, `Missing tool ${name}`);
    const toolContext: ExtensionToolContext = {
      ...ctx,
      tools: [],
      executeTool: async () => assert.fail("Unexpected nested tool execution"),
    };
    const result = await tool.execute(
      "fixture-call",
      params,
      signal,
      undefined,
      toolContext,
    );
    return result.details as WakeupState;
  }
  await emit("session_start");
  t.after(() => emit("session_shutdown"));
  return {
    tools,
    commands,
    messages,
    notices,
    entries,
    events,
    labels,
    ctx,
    queue: (value: boolean) => {
      queued = value;
    },
    emit,
    call,
    footer: () => footer,
    tick: (ms: number) => t.mock.timers.tick(ms),
    arm: () =>
      call("schedule_wakeup", {
        delaySeconds: 60,
        prompt: "Check fixture-123",
        reason: "Pending fixture",
      }),
  };
}

test("the supported extension exposes exactly three tools and no commands", async (t) => {
  const h = await harness(t);
  assert.deepEqual([...h.tools.keys()].sort(), [
    "cancel_wakeup",
    "list_wakeups",
    "schedule_wakeup",
  ]);
  assert.deepEqual(h.commands, []);
  const pending = await h.arm();
  assert.ok(h.footer()?.includes(pending.pending!.id));
  h.tick(60_000);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]?.customType, "scheduled-wakeup");
  assert.match(String(h.messages[0]?.content), /Check fixture-123/);
  assert.deepEqual(h.messages[0]?.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  assert.equal(h.footer(), undefined);
});

for (const version of ["0.84.1", "1.1.9", "1.2.0-beta.1", "2.0.0", "unknown"]) {
  test(`runtime ${version} is not allowed to run unsafe wakeups`, async (t) => {
    const h = await harness(t, version);
    assert.equal(h.tools.size, 0);
    assert.ok(
      h.notices.some((text) => text.includes(version) && text.includes("1.2")),
    );
  });
}

test("extension-origin input cannot rearm a cancelled wait", async (t) => {
  const h = await harness(t);
  const first = await h.arm();
  await h.call("cancel_wakeup", { id: first.pending!.id });
  await h.emit("input", { source: "extension" });
  await assert.rejects(h.arm(), /cancelled|user/i);
  await h.emit("input", { source: "interactive" });
  await h.arm();
  h.tick(60_000);
  assert.equal(h.messages.length, 1);
});

for (const event of ["session_shutdown", "session_tree", "session_start"]) {
  test(`${event} prevents the old pending callback from delivering`, async (t) => {
    const h = await harness(t);
    await h.arm();
    await h.emit(event);
    h.tick(60_000);
    assert.equal(h.messages.length, 0);
    assert.equal(h.footer(), undefined);
  });
}

test("aborted settlement blocks a due timer and future automatic rearming", async (t) => {
  const h = await harness(t);
  await h.emit("before_agent_start");
  await h.arm();
  h.tick(60_000);
  await h.emit("agent_settled", { aborted: true });
  h.tick(60_000);
  assert.equal(h.messages.length, 0);
  await assert.rejects(h.arm(), /cancelled|user/i);
});

test("an already-aborted tool call cannot schedule work", async (t) => {
  const h = await harness(t);
  const signal = AbortSignal.abort();
  await assert.rejects(
    h.call(
      "schedule_wakeup",
      { delaySeconds: 60, prompt: "Check fixture", reason: "Fixture" },
      signal,
    ),
    /abort/i,
  );
  assert.deepEqual(await h.call("list_wakeups"), { status: "ready" });
});

test("waiting notices appear once after settlement, not while work is active", async (t) => {
  const h = await harness(t);
  await h.emit("before_agent_start");
  await h.arm();
  assert.equal(h.entries.length, 0);
  assert.ok(h.labels.every((value) => value === null));
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].customType, "wakeup-wait");
  assert.match(JSON.stringify(h.entries[0].data), /Pending fixture/);
  assert.match(String(h.labels.at(-1)), /Waiting.*until/);
  assert.equal(h.messages.length, 0, "UI must not send model messages");
  await h.emit("agent_settled", { aborted: false });
  await h.call("list_wakeups");
  assert.equal(h.entries.length, 1);
  await h.emit("before_agent_start");
  assert.equal(h.labels.at(-1), null);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, 1, "same wakeup is not announced twice");
  h.tick(60_000);
  assert.equal(h.labels.at(-1), null);
  assert.equal(h.messages.length, 1);
});

test("human-input blockers suppress the waiting label without cancelling the timer", async (t) => {
  const h = await harness(t);
  await h.arm();
  assert.match(String(h.labels.at(-1)), /Waiting/);
  h.events.emit("herdr:blocked", { active: true, label: "Approval" });
  h.events.emit("herdr:blocked", { active: true, label: "Second approval" });
  assert.equal(h.labels.at(-1), null);
  h.events.emit("herdr:blocked", { active: false });
  assert.equal(h.labels.at(-1), null);
  h.events.emit("herdr:blocked", { active: false });
  assert.match(String(h.labels.at(-1)), /Waiting/);
  assert.equal(h.entries.length, 1);
  assert.equal((await h.call("list_wakeups")).status, "scheduled");
});

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} wakeups do not create UI notices or a waiting label`, async (t) => {
    const h = await harness(t);
    Object.assign(h.ctx, { mode });
    await h.arm();
    assert.equal(h.entries.length, 0);
    assert.ok(h.labels.every((value) => value === null));
    h.tick(60_000);
    assert.equal(h.messages.length, 1);
  });
}

for (const event of [
  "session_shutdown",
  "session_tree",
  "session_start",
] as const) {
  test(`${event} clears the waiting label`, async (t) => {
    const h = await harness(t);
    await h.arm();
    assert.match(String(h.labels.at(-1)), /Waiting/);
    await h.emit(event);
    assert.equal(h.labels.at(-1), null);
    h.tick(60_000);
    assert.equal(h.messages.length, 0);
  });
}

test("cancellation closes the notice and clears the live label", async (t) => {
  const h = await harness(t);
  const first = await h.arm();
  await h.call("cancel_wakeup", { id: first.pending!.id });
  assert.equal(h.labels.at(-1), null);
  assert.match(JSON.stringify(h.entries.at(-1)), /cancelled/i);
  h.tick(3_600_000);
  assert.equal(h.messages.length, 0);
});

test("an overdue check waits behind queued input without an expiry notice", async (t) => {
  const h = await harness(t);
  const first = await h.arm();
  h.queue(true);
  await h.emit("before_agent_start");
  h.tick(3 * 86_400_000);
  assert.equal(h.labels.at(-1), null);
  assert.equal((await h.call("list_wakeups")).pending?.id, first.pending!.id);
  assert.equal(h.entries.length, 1);
  assert.equal(h.messages.length, 0);
  h.queue(false);
  await h.emit("agent_settled", { aborted: false });
  assert.match(String(h.labels.at(-1)), /overdue/i);
  h.tick(0);
  assert.equal(h.messages.length, 1);
  assert.equal(h.entries.length, 1);
  assert.equal(h.labels.at(-1), null);
  assert.match(String(h.messages[0].content), /2026-02-01T00:01:00.000Z/);
  await assert.rejects(h.arm(), /cutoff|expired|user/i);
});

test("absolute alarms share listing and cancellation and display a multi-day footer", async (t) => {
  const h = await harness(t);
  const first = await h.call("schedule_wakeup", {
    at: "2026-02-08T00:00:00Z",
    reason: "Check next week",
    prompt: "Inspect fixture-123",
  });
  assert.equal(first.pending?.dueAt, Date.UTC(2026, 1, 8));
  assert.match(h.footer()!, /Feb/);
  assert.equal((await h.call("list_wakeups")).pending?.id, first.pending!.id);
  await assert.rejects(h.arm(), /already pending/i);
  await h.call("cancel_wakeup", { id: first.pending!.id });
  h.tick(7 * 86_400_000);
  assert.equal(h.messages.length, 0);
});

test("invalid timing combinations are rejected without arming the adapter", async (t) => {
  const h = await harness(t);
  for (const timing of [{}, { delaySeconds: 60, at: "2026-02-02T00:00:00Z" }]) {
    await assert.rejects(
      h.call("schedule_wakeup", {
        ...timing,
        prompt: "Check fixture-123",
        reason: "Fixture",
      }),
      /exactly one/i,
    );
  }
  assert.equal((await h.call("list_wakeups")).status, "ready");
  assert.equal(h.entries.length, 0);
});

test("abort never announces a wait while cancelling it", async (t) => {
  const h = await harness(t);
  await h.emit("before_agent_start");
  await h.arm();
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.entries.length, 0);
  assert.equal(h.labels.at(-1), null);
});
