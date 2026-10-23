import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

const sdk = await import(
  process.env.PI_WAKEUP_SDK ?? "@earendil-works/pi-coding-agent"
);
const version = /^1\.(\d+)\.\d+(?:\+[\w.-]+)?$/.exec(String(sdk.VERSION));
const skip =
  !version || Number(version[1]) < 2
    ? "Requires a Pi 1.2+ SDK; set PI_WAKEUP_SDK to its module URL"
    : false;

async function start(t: TestContext, hold = false) {
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
        if (current === 1 || current === 4) {
          const toolCall = {
            type: "toolCall",
            id: `schedule-${current}`,
            name: "schedule_wakeup",
            arguments: {
              delaySeconds: 60,
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
    onError: (error: unknown) => errors.push(error),
  });
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2026, 1, 1),
  });
  return { session, errors, holding, requests: () => requests };
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
