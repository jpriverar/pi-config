import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompletionReview } from "../extensions/task-lifecycle/completion-review.js";

const sdk = await import(
  process.env.PI_WAKEUP_SDK ?? "@earendil-works/pi-coding-agent"
);
const version = /^1\.(\d+)\.\d+(?:\+[\w.-]+)?$/.exec(String(sdk.VERSION));
const skip =
  !version || Number(version[1]) < 2
    ? "Requires a Pi 1.2+ SDK; set PI_WAKEUP_SDK to its module URL"
    : false;

async function start(
  t: TestContext,
  hold = false,
  review?: { enabled: boolean; beforeRead?(): Promise<void> },
  mode = "json",
  alarm: { at?: string; rearmOnWake?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "wakeup-sdk-"));
  let session: any;
  t.after(async () => {
    if (session) {
      await session.abort();
      session.dispose();
    }
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network request in wakeup fixture");
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    modelsStorePath: join(dir, "catalog.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let requests = 0;
  let contextReads = 0;
  const messageTypes: string[] = [];
  let held!: () => void;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  modelRuntime.registerProvider("wakeup-test", {
    api: "openai-completions",
    apiKey: "placeholder",
    baseUrl: "https://host:port",
    models: [
      {
        id: "local",
        name: "Local fixture",
        input: ["text"],
        reasoning: false,
        contextWindow: 100000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(
      model: { api: string; provider: string; id: string },
      _context: unknown,
      options?: { signal?: AbortSignal },
    ) {
      const current = ++requests;
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "pending",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      async function* events() {
        yield { type: "start", partial: message };
        if (current === 2 && hold) {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            held();
          });
          message.stopReason = "aborted";
          message.errorMessage = "Fixture stopped";
          yield { type: "error", reason: "aborted", error: message };
          return;
        }
        if (current === 1 || current === (alarm.rearmOnWake ? 3 : 4)) {
          const toolCall = {
            type: "toolCall",
            id: `schedule-${current}`,
            name: "schedule_wakeup",
            arguments: {
              ...(current === 1 && alarm.at !== undefined
                ? { at: alarm.at }
                : { delaySeconds: 60 }),
              reason: "Fixture pending",
              prompt: "Check operation fixture-123",
            },
          };
          message.content.push(toolCall);
          yield { type: "toolcall_start", contentIndex: 0, partial: message };
          yield {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall,
            partial: message,
          };
          message.stopReason = "toolUse";
        } else {
          message.content.push({ type: "text", text: "Fixture finished" });
          yield { type: "text_start", contentIndex: 0, partial: message };
          yield {
            type: "text_end",
            contentIndex: 0,
            content: "Fixture finished",
            partial: message,
          };
          message.stopReason = "stop";
        }
        yield { type: "done", reason: message.stopReason, message };
      }
      return Object.assign(events(), { result: async () => message });
    },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      fileURLToPath(new URL("../extensions/wakeups/index.ts", import.meta.url)),
    ],
    extensionFactories:
      review === undefined
        ? []
        : [
            (pi: ExtensionAPI) => {
              registerCompletionReview(pi, {
                runtimeVersion: sdk.VERSION,
                isChild: () => false,
                readContext: async () => {
                  contextReads++;
                  await review.beforeRead?.();
                  return {
                    kind: "none",
                    reason: "Isolated wakeup integration fixture",
                  };
                },
              });
              pi.on("before_agent_start", (event) => {
                messageTypes.push(event.messageType);
              });
            },
          ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    modelRuntime,
    resourceLoader,
    model: modelRuntime.getModel("wakeup-test", "local"),
    thinkingLevel: "off",
    tools: ["schedule_wakeup", "list_wakeups", "cancel_wakeup"],
    sessionManager: sdk.SessionManager.inMemory(dir),
  }));
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode,
    onError: (error: unknown) => errors.push(error),
  });
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2026, 1, 1),
  });
  if (review?.enabled) await session.prompt("/mission-check on");
  return {
    session,
    errors,
    holding,
    requests: () => requests,
    contextReads: () => contextReads,
    messageTypes,
  };
}

function assertArmed(session: any) {
  const result = session.messages
    .filter((message: any) => message.role === "toolResult")
    .at(-1);
  assert.ok(
    result && !result.isError,
    "the scheduling tool must actually succeed",
  );
}

test(
  "supported SDK resumes a custom turn and cancels the next timer on reload",
  { skip },
  async (t) => {
    const h = await start(t);
    assert.deepEqual(h.session.getActiveToolNames().sort(), [
      "cancel_wakeup",
      "list_wakeups",
      "schedule_wakeup",
    ]);
    await h.session.prompt("Wait for the fixture operation, then check it.");
    assertArmed(h.session);
    const resumed = new Promise<void>((resolve) => {
      const off = h.session.subscribe((event: { type: string }) => {
        if (event.type === "agent_settled") {
          off();
          resolve();
        }
      });
    });
    t.mock.timers.tick(60_000);
    await resumed;
    assert.equal(h.requests(), 3);
    assert.equal(
      h.session.messages.filter((message: any) => message.role === "user")
        .length,
      1,
    );
    assert.equal(
      h.session.messages.filter(
        (message: any) =>
          message.role === "custom" &&
          message.customType === "scheduled-wakeup",
      ).length,
      1,
    );
    await h.session.prompt("Start another bounded wait.");
    assertArmed(h.session);
    await h.session.reload();
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(h.requests(), 5);
    assert.deepEqual(h.errors, []);
  },
);

test(
  "supported SDK abort cannot restart a due scheduled check",
  { skip },
  async (t) => {
    const h = await start(t, true);
    const running = h.session.prompt("Wait for the fixture operation.");
    await h.holding;
    assertArmed(h.session);
    t.mock.timers.tick(60_000);
    await h.session.abort();
    await running;
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(h.requests(), 2);
    assert.equal(
      h.session.messages.filter(
        (message: any) =>
          message.role === "custom" &&
          message.customType === "scheduled-wakeup",
      ).length,
      0,
    );
    assert.deepEqual(h.errors, []);
  },
);

test(
  "TUI waiting notices are durable display entries, not model messages or extra turns",
  { skip },
  async (t) => {
    const h = await start(t, false, undefined, "tui");
    await h.session.prompt("Wait for the fixture operation, then check it.");
    assertArmed(h.session);
    const entries = h.session.sessionManager
      .getBranch()
      .filter(
        (entry: any) =>
          entry.type === "custom" && entry.customType === "wakeup-wait",
      );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data.phase, "waiting");
    assert.equal(h.requests(), 2);
    assert.ok(
      h.session.messages.every(
        (message: any) => message.customType !== "wakeup-wait",
      ),
    );
    await h.session.reload();
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(h.requests(), 2);
    assert.deepEqual(h.errors, []);
  },
);

function reviewCount(session: any): number {
  return session.messages.filter(
    (message: any) =>
      message.role === "custom" &&
      message.customType === "jp-completion-review",
  ).length;
}

async function wake(t: TestContext, session: any, milliseconds = 60_000) {
  const settled = new Promise<void>((resolve) => {
    const off = session.subscribe((event: { type: string }) => {
      if (event.type === "agent_settled") {
        off();
        resolve();
      }
    });
  });
  t.mock.timers.tick(milliseconds);
  await settled;
}

test(
  "TUI waiting notices do not add model turns or replenish completion review",
  { skip },
  async (t) => {
    const h = await start(t, false, { enabled: true }, "tui");
    await h.session.prompt("Wait for the fixture operation, then check it.");
    assertArmed(h.session);
    assert.equal(h.requests(), 3);
    assert.equal(reviewCount(h.session), 1);
    assert.ok(
      h.session.sessionManager
        .getBranch()
        .some(
          (entry: any) =>
            entry.type === "custom" && entry.customType === "wakeup-wait",
        ),
    );
    await wake(t, h.session);
    assert.equal(h.requests(), 5);
    assert.equal(reviewCount(h.session), 1);
    assert.equal(h.contextReads(), 1);
    assert.deepEqual(h.messageTypes, ["user", "custom"]);
    assert.ok(
      h.session.messages.every(
        (message: any) => message.customType !== "wakeup-wait",
      ),
    );
    assert.deepEqual(h.errors, []);
  },
);

for (const enabled of [false, true]) {
  test(
    `completion review budget is not replenished by native wakeups (enabled=${enabled})`,
    { skip },
    async (t) => {
      const h = await start(t, false, { enabled });
      await h.session.prompt("Wait for the fixture operation, then check it.");
      assertArmed(h.session);
      assert.equal(h.requests(), enabled ? 3 : 2);
      assert.equal(reviewCount(h.session), enabled ? 1 : 0);
      await wake(t, h.session);
      assert.equal(h.requests(), enabled ? 5 : 3);
      assert.equal(reviewCount(h.session), enabled ? 1 : 0);
      assert.equal(h.contextReads(), enabled ? 1 : 0);
      await h.session.prompt("Continue the same approved bounded check.");
      assert.equal(h.requests(), enabled ? 7 : 5);
      assert.equal(reviewCount(h.session), enabled ? 2 : 0);
      await wake(t, h.session);
      assert.equal(h.requests(), enabled ? 8 : 6);
      assert.equal(reviewCount(h.session), enabled ? 2 : 0);
      assert.equal(h.contextReads(), enabled ? 2 : 0);
      assert.deepEqual(h.messageTypes, ["user", "custom", "user", "custom"]);
      assert.deepEqual(h.errors, []);
    },
  );
}

test(
  "completion review preserves native wakeup abort cancellation",
  { skip },
  async (t) => {
    const h = await start(t, true, { enabled: true });
    const running = h.session.prompt("Wait for the fixture operation.");
    await h.holding;
    assertArmed(h.session);
    t.mock.timers.tick(60_000);
    await h.session.abort();
    await running;
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(h.requests(), 2);
    assert.equal(reviewCount(h.session), 0);
    assert.equal(h.contextReads(), 0);
    assert.equal(
      h.session.messages.filter(
        (message: any) =>
          message.role === "custom" &&
          message.customType === "scheduled-wakeup",
      ).length,
      0,
    );
    assert.deepEqual(h.errors, []);
  },
);

test(
  "a due wakeup waits for completion review to settle",
  { skip },
  async (t) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await start(t, false, {
      enabled: true,
      beforeRead: async () => {
        entered();
        await blocked;
      },
    });
    const running = h.session.prompt("Wait for the fixture operation.");
    await started;
    try {
      t.mock.timers.tick(60_000);
      await setImmediate();
      assert.equal(h.requests(), 2);
      assert.deepEqual(h.messageTypes, ["user"]);
      assert.equal(reviewCount(h.session), 0);
    } finally {
      release();
    }
    await running;
    assert.equal(h.requests(), 3);
    assert.equal(reviewCount(h.session), 1);
    await wake(t, h.session, 0);
    assert.equal(h.requests(), 5);
    assert.equal(reviewCount(h.session), 1);
    assert.equal(h.contextReads(), 1);
    assert.deepEqual(h.messageTypes, ["user", "custom"]);
    assert.deepEqual(h.errors, []);
  },
);

for (const mode of ["relative", "absolute"] as const) {
  test(
    `supported SDK delivers a late ${mode} alarm once but rejects automatic rearming`,
    { skip },
    async (t) => {
      const h = await start(t, false, undefined, "json", {
        ...(mode === "absolute" ? { at: "2026-02-02T00:00:00Z" } : {}),
        rearmOnWake: true,
      });
      await h.session.prompt("Wait for the approved fixture operation.");
      assertArmed(h.session);
      await wake(t, h.session, 3 * 86_400_000);
      assert.equal(h.requests(), 4);
      const toolResults = h.session.messages.filter(
        (message: any) => message.role === "toolResult",
      );
      assert.equal(toolResults.length, 2);
      assert.equal(toolResults[1].isError, true);
      assert.match(JSON.stringify(toolResults[1].content), /cutoff|expired/i);
      const continuations = h.session.messages.filter(
        (message: any) =>
          message.role === "custom" &&
          message.customType === "scheduled-wakeup",
      );
      assert.equal(continuations.length, 1);
      assert.equal(
        continuations[0].details.dueAt,
        mode === "absolute" ? Date.UTC(2026, 1, 2) : Date.UTC(2026, 1, 1, 0, 1),
      );
      assert.equal(
        h.session.messages.filter((message: any) => message.role === "user")
          .length,
        1,
      );
      t.mock.timers.tick(86_400_000);
      await setImmediate();
      assert.equal(h.requests(), 4);
      assert.deepEqual(h.errors, []);
    },
  );
}
