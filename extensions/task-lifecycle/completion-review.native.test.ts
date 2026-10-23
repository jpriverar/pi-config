import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  getModel,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  COMPLETION_REVIEW_CUE,
  registerCompletionReview,
} from "./completion-review.js";
import type { TaskContextResult } from "./task-context.js";

const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("Native fixture forbids network");
};
after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkAttempts, 0);
});
const model = getModel("anthropic", "claude-sonnet-4-5");
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(
  kind: "stop" | "error" | "toolUse" = "stop",
  content: AssistantMessage["content"] = [
    { type: "text", text: "Fixture finished." },
  ],
): AssistantMessage & { stopReason: "stop" | "error" | "toolUse" } {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: kind,
    usage: structuredClone(usage),
    timestamp: Date.now(),
    ...(kind === "error" ? { errorMessage: "Fixture provider failure" } : {}),
  };
}

async function fixture(
  options: {
    enabled?: boolean;
    runs?: number;
    tool?: "error" | "terminate" | "denied" | "bookkeeping";
    providerError?: boolean;
    abortAfterTurn?: boolean;
    queueFollowup?: boolean;
    lookup?: "abort" | "queue";
    context?: TaskContextResult;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-completion-review-"));
  let session!: AgentSession;
  let lookupInterrupted = false;
  const requests: Message[][] = [];
  const events: Array<[string, unknown]> = [];
  const errors: unknown[] = [];
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: "Isolated scripted-provider test. No real work or network.",
    extensionFactories: [
      (pi) => {
        pi.on("agent_before_settle", (event) => {
          events.push(["boundary", event.outcome]);
        });
        pi.on("agent_settled", (event) => {
          events.push(["settled", event.aborted]);
        });
        if (options.abortAfterTurn)
          pi.on("turn_end", () => {
            void session.abort();
          });
        if (options.tool === "denied")
          pi.on("tool_call", () => ({
            block: true,
            reason: "Fixture denied",
            terminate: true,
          }));
        if (options.queueFollowup)
          pi.on("agent_end", () => {
            if (requests.length === 1)
              pi.sendMessage(
                {
                  customType: "fixture-followup",
                  content: "Queued evidence.",
                  display: false,
                },
                { deliverAs: "followUp" },
              );
          });
        registerCompletionReview(pi, {
          runtimeVersion: "1.2.0",
          isChild: () => false,
          readContext: async () => {
            if (!lookupInterrupted && options.lookup) {
              lookupInterrupted = true;
              if (options.lookup === "abort") void session.abort();
              else await session.followUp("Evidence queued during lookup.");
            }
            return options.context ?? { kind: "none", reason: "No task" };
          },
        });
        if (options.tool)
          pi.registerTool({
            name: "fixture_action",
            label: "Fixture action",
            description: "In-memory fixture only.",
            parameters: Type.Object({}),
            async execute() {
              if (options.tool === "error")
                throw new Error("Fixture tool failure");
              return {
                content: [{ type: "text", text: "Fixture result" }],
                details: {},
                ...(options.tool === "terminate" ? { terminate: true } : {}),
              };
            },
          });
      },
    ],
  });
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: join(cwd, "models.json"),
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "fixture-not-a-real-key");
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      noTools: "builtin",
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: settings,
    }));
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      assert.ok(requests.length <= 6, "Continuation exceeded fixture bound");
      const first = requests.length === 1;
      const hasCue = JSON.stringify(context.messages).includes(
        COMPLETION_REVIEW_CUE,
      );
      const shouldBookkeep =
        options.tool === "bookkeeping" && hasCue && requests.length === 2;
      const message =
        (first && options.tool && options.tool !== "bookkeeping") ||
        shouldBookkeep
          ? response("toolUse", [
              {
                type: "toolCall",
                id: `fixture-${requests.length}`,
                name: "fixture_action",
                arguments: {},
              },
            ])
          : response(first && options.providerError ? "error" : "stop");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error")
        stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    };
    await session.bindExtensions({
      onError: (error) => {
        errors.push(error);
      },
    });
    if (options.enabled !== false) await session.prompt("/mission-check on");
    assert.equal(
      requests.length,
      0,
      "Enabling review must not wake an idle agent",
    );
    for (let i = 0; i < (options.runs ?? 1); i++)
      await session.prompt("Perform the bounded fixture task.");
    const nudges = session.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "jp-completion-review",
      );
    return { requests, events, errors, nudges };
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("native boundary adds one cue as user-role data and settles", async () => {
  const r = await fixture();
  assert.equal(r.requests.length, 2);
  assert.equal(r.nudges.length, 1);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.events.at(-1), ["settled", false]);
  const cue = r.requests[1].at(-1)!;
  assert.equal(cue.role, "user");
  assert.deepEqual(cue.content, [
    { type: "text", text: COMPLETION_REVIEW_CUE },
  ]);
});

test("native default-off does not add a provider request", async () => {
  const r = await fixture({ enabled: false });
  assert.equal(r.requests.length, 1);
  assert.equal(r.nudges.length, 0);
});

for (const options of [
  { abortAfterTurn: true },
  { providerError: true },
  { tool: "terminate" as const },
  { tool: "denied" as const },
]) {
  test(`native boundary does not revive ${JSON.stringify(options)}`, async () => {
    const r = await fixture(options);
    assert.equal(r.requests.length, 1);
    assert.equal(r.nudges.length, 0);
    assert.deepEqual(r.errors, []);
  });
}

test("native recovered tool error conservatively suppresses review", async () => {
  const r = await fixture({ tool: "error" });
  assert.equal(r.requests.length, 2);
  assert.equal(r.nudges.length, 0);
});

test("new submitted runs get a budget; review-time bookkeeping does not", async () => {
  const fresh = await fixture({ runs: 2 });
  assert.equal(fresh.requests.length, 4);
  assert.equal(fresh.nudges.length, 2);
  const bookkeeping = await fixture({ tool: "bookkeeping" });
  assert.equal(bookkeeping.requests.length, 3);
  assert.equal(bookkeeping.nudges.length, 1);
});

test("native queued follow-up precedes review", async () => {
  const r = await fixture({ queueFollowup: true });
  assert.equal(r.requests.length, 3);
  assert.equal(r.nudges.length, 1);
  assert.match(JSON.stringify(r.requests[1]), /Queued evidence/);
  assert.ok(!JSON.stringify(r.requests[1]).includes(COMPLETION_REVIEW_CUE));
});

for (const lookup of ["abort", "queue"] as const) {
  test(`native ${lookup} during lookup prevents automatic continuation`, async () => {
    const r = await fixture({ lookup });
    assert.equal(r.requests.length, lookup === "abort" ? 1 : 2);
    assert.deepEqual(r.events.at(-1), ["settled", lookup === "abort"]);
    // The SDK commits boundary entries before honoring an in-boundary abort.
    assert.ok(r.nudges.length <= (lookup === "abort" ? 1 : 0));
    if (lookup === "queue")
      assert.match(
        JSON.stringify(r.requests[1]),
        /Evidence queued during lookup/,
      );
  });
}

test("native context without an owned task still receives the conversation cue", async () => {
  const r = await fixture({
    context: { kind: "unavailable", reason: "Fixture store unavailable" },
  });
  assert.equal(r.nudges.length, 1);
  assert.match(JSON.stringify(r.requests[1]), /Fixture store unavailable/);
  assert.equal(r.requests[1].at(-1)?.role, "user");
});
