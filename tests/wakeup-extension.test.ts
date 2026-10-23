import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
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
  let footer: string | undefined;
  const ctx = {
    hasUI: true,
    cwd: "/fixture",
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, value: string | undefined) => {
        footer = value;
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
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
    const result = await tool.execute(
      "fixture-call",
      params,
      signal,
      undefined,
      ctx,
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
