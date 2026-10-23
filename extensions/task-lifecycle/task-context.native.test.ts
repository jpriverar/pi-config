import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  getModel,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BeadsExec } from "../../lib/beads.js";
import type { WorkScope } from "../../lib/work-catalog/model.js";
import {
  A,
  B,
  P,
  Q,
  catalogFixture,
} from "../../lib/work-catalog/test-fixtures.js";
import { createLifecycleStore } from "../../lib/task-lifecycle/beads-store.js";
import { TaskLifecycleService } from "../../lib/task-lifecycle/service.js";
import type { LifecycleMetadataV1 } from "../../lib/task-lifecycle/types.js";
import { createTaskLifecycleExtension } from "./index.js";

const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("Native task fixture forbids network");
};
after(() => {
  globalThis.fetch = previousFetch;
  assert.equal(networkAttempts, 0);
});
const model = getModel("anthropic", "claude-sonnet-4-5");
const NOW = "2026-09-17T10:00:00.000Z";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function fixture(
  options: {
    claim?: boolean;
    foreign?: boolean;
    race?: boolean;
    nextStep?: string;
    scope?: WorkScope;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-native-task-context-"));
  const storePath = join(cwd, ".beads");
  const oldBeads = process.env.BEADS_DIR;
  process.env.BEADS_DIR = storePath;
  const manager = SessionManager.inMemory(cwd);
  if (options.scope)
    manager.appendCustomEntry("jp-project-scope", {
      version: 2,
      scope: options.scope,
    });
  const lifecycle: LifecycleMetadataV1 = {
    version: 1,
    phase: options.claim ? "actionable" : "active",
    waiting: null,
    stateEnteredAt: NOW,
    lastProgressAt: NOW,
    execution: options.claim
      ? null
      : {
          sessionId: options.foreign
            ? "foreign-session"
            : manager.getSessionId(),
          claimedAt: NOW,
          lastActivityAt: NOW,
          expiresAt: NOW,
          resourceSnapshot: { observedAt: NOW, resourceIds: [] },
        },
    artifacts: [],
    activeCheck: null,
    checkHistory: [],
    transitionHistory: [],
    resources: [],
    disposition: null,
  };
  const record = {
    id: "jp-fixture",
    title: "Fixture task",
    description: "Build, validate and report the owned fixture outcome",
    status: options.claim ? "open" : "in_progress",
    labels: options.scope ? [] : ["workstream:fixture"],
    metadata: {
      ...(options.scope ? { piProject: { version: 1, projectId: P } } : {}),
      piLifecycle: lifecycle,
      next_step: "Original action",
      unrelated: { preserved: true },
    },
  };
  const calls: string[][] = [];
  const events: string[] = [];
  const exec: BeadsExec = async (command, args, execution) => {
    assert.equal(command, "bd");
    assert.deepEqual(args.slice(-2), ["--db", storePath]);
    calls.push([...args]);
    if (["show", "list", "ready"].includes(args[0]))
      assert.equal(execution?.env.BD_BACKUP_ENABLED, "false");
    if (args[0] === "update") {
      if (args.includes("--metadata"))
        record.metadata = JSON.parse(args[args.indexOf("--metadata") + 1]);
      if (args.includes("-d"))
        record.description = args[args.indexOf("-d") + 1];
      if (args.includes("-s")) record.status = args[args.indexOf("-s") + 1];
    } else
      assert.ok(
        ["show", "list", "ready"].includes(args[0]),
        `Unexpected fixture CLI operation ${args[0]}`,
      );
    const filtered =
      args[0] === "ready"
        ? record.status === "open"
        : args[0] === "list" && args.includes("-s")
          ? args[args.indexOf("-s") + 1].split(",").includes(record.status)
          : true;
    return {
      code: 0,
      stdout: JSON.stringify(filtered ? [record] : []),
      stderr: "",
    };
  };
  const store = createLifecycleStore(exec, { store: storePath });
  const service = new TaskLifecycleService({
    store,
    now: () => Date.parse(NOW),
    uuid: () => "fixture-operation",
    executionTimeoutMs: 60_000,
  });
  const requests: Message[][] = [];
  const errors: unknown[] = [];
  let session: AgentSession | undefined;
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
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Isolated native task fixture; no real work or network.",
    extensionFactories: [
      createCodemodeExtension({ models: false }),
      (pi) => {
        createTaskLifecycleExtension({
          service,
          now: () => Date.parse(NOW),
          hostname: "fixture-host",
          pid: process.pid,
          activityWriteIntervalMs: 300_000,
          sessionReconcileLimit: 10,
          sessionPrCheckLimit: 5,
          readCatalog: async () => (options.scope ? catalogFixture() : null),
          workStateHealth: async () => ({
            state: "unavailable",
            reason: "Fixture daemon is absent",
          }),
        })({
          ...pi,
          exec: async (command, args) => {
            assert.equal(command, "env");
            assert.equal(args[0], "BD_BACKUP_ENABLED=false");
            return {
              ...(await exec(args[1], args.slice(2), {
                env: { BD_BACKUP_ENABLED: "false" },
              })),
              killed: false,
            };
          },
        });
        pi.on("tool_execution_start", (event) => {
          events.push(event.toolName);
        });
        pi.on("tool_call", (event) => {
          if (options.race && event.toolName === "task_update")
            record.metadata.piLifecycle.execution!.sessionId =
              "foreign-session";
        });
        pi.registerTool({
          name: "fixture_marker",
          label: "Fixture marker",
          description: "Record same-batch ordering only.",
          parameters: Type.Object({}),
          async execute() {
            events.push("marker-executed");
            return { content: [{ type: "text", text: "Marker" }], details: {} };
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
      tools: ["codemode", "task_*", "fixture_marker"],
      sessionManager: manager,
      settingsManager: settings,
    }));
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      events.push(`provider-${requests.length}`);
      assert.ok(requests.length <= 3);
      const script = options.claim
        ? 'await tools.task_claim({ taskId: "jp-fixture" }); await tools.fixture_marker({}); text("filtered");'
        : `await tools.task_update({ taskId: "jp-fixture", next_step: ${JSON.stringify(options.nextStep ?? "Validate the current candidate")} }); text("filtered");`;
      const content: AssistantMessage["content"] =
        requests.length === 1
          ? [
              {
                type: "toolCall",
                id: "native-script",
                name: "codemode",
                arguments: { code: script },
              },
            ]
          : [{ type: "text", text: "Fixture finished." }];
      const reason = requests.length === 1 ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        stopReason: reason,
        usage: structuredClone(usage),
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason, message });
      stream.end();
      return stream;
    };
    await session.bindExtensions({
      onError: (error) => {
        errors.push(error);
      },
    });
    await session.prompt("/mission-check on");
    await session.prompt("Perform the bounded fixture action.");
    const contexts = manager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom_message" &&
        ["jp-mission-context", "jp-task-claimed"].includes(entry.customType)
          ? [{ customType: entry.customType, content: entry.content }]
          : [],
      );
    return {
      record: structuredClone(record),
      calls,
      requests,
      events,
      errors,
      contexts,
    };
  } finally {
    session?.dispose();
    if (oldBeads === undefined) delete process.env.BEADS_DIR;
    else process.env.BEADS_DIR = oldBeads;
    await rm(cwd, { recursive: true, force: true });
  }
}

function contextPayload(
  result: Awaited<ReturnType<typeof fixture>>,
  kind = "jp-mission-context",
) {
  const entry = result.contexts.find((item) => item.customType === kind);
  assert.ok(entry, `Missing native ${kind} entry`);
  const match =
    /<untrusted-task-context>\n([\s\S]+)\n<\/untrusted-task-context>/.exec(
      String(entry.content),
    );
  assert.ok(match);
  return JSON.parse(match[1]);
}

test("native codemode updates owned metadata and the stop reader sees it", async () => {
  const r = await fixture();
  assert.deepEqual(r.errors, []);
  assert.equal(r.record.metadata.next_step, "Validate the current candidate");
  assert.equal(r.requests.length, 3);
  assert.equal(contextPayload(r).next_step, "Validate the current candidate");
  assert.deepEqual(r.record.metadata.unrelated, { preserved: true });
});

test("native codemode cannot update a foreign session's task", async () => {
  const r = await fixture({ foreign: true });
  assert.equal(r.record.metadata.next_step, "Original action");
  assert.equal(r.calls.filter((call) => call[0] === "update").length, 0);
});

test("native codemode still checks ownership when it changes after the outer guard", async () => {
  const r = await fixture({ race: true });
  assert.ok(r.events.includes("task_update"));
  assert.equal(r.record.metadata.next_step, "Original action");
  assert.match(
    JSON.stringify(r.requests[1]),
    /owned by active session foreign-session/,
  );
  assert.equal(r.calls.filter((call) => call[0] === "update").length, 0);
});

test("native claim context survives filtered results without preempting the same batch", async () => {
  const r = await fixture({ claim: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.record.status, "in_progress");
  assert.match(
    JSON.stringify(r.requests[1]),
    /Build, validate and report the owned fixture outcome/,
  );
  assert.ok(
    r.events.indexOf("marker-executed") < r.events.indexOf("provider-2"),
  );
  const lastTool = r.requests[1]
    .filter((message) => message.role === "toolResult")
    .at(-1);
  assert.match(JSON.stringify(lastTool), /filtered/);
  assert.doesNotMatch(JSON.stringify(lastTool), /Build, validate and report/);
});

for (const size of [2000, 2001]) {
  test(`native schema and backend agree on ${size} Unicode code points`, async () => {
    const nextStep = "😀".repeat(size);
    const r = await fixture({ nextStep });
    assert.equal(
      r.record.metadata.next_step,
      size === 2000 ? nextStep : "Original action",
    );
  });
}

for (const [name, scope, outside] of [
  ["global", { kind: "global" }, false],
  ["area", { kind: "area", areaId: A }, false],
  ["project", { kind: "project", projectId: P }, false],
  ["other-area", { kind: "area", areaId: B }, true],
  ["other-project", { kind: "project", projectId: Q }, true],
] as const) {
  test(`native catalog ${name} review reads the updated owned mission through the default factory`, async () => {
    const r = await fixture({ scope });
    assert.deepEqual(r.errors, []);
    assert.equal(r.requests.length, 3);
    const payload = contextPayload(r);
    assert.equal(payload.task_id, "jp-fixture");
    assert.equal(
      payload.description,
      "Build, validate and report the owned fixture outcome",
    );
    assert.equal(payload.next_step, "Validate the current candidate");
    const reviewed = JSON.stringify(payload);
    assert.deepEqual(r.record.metadata.piProject, { version: 1, projectId: P });
    assert.deepEqual(r.record.metadata.unrelated, { preserved: true });
    if (outside) assert.match(reviewed, /outside the selected view/);
    else assert.doesNotMatch(reviewed, /outside the selected view/);
  });
}

test("native catalog claim outside the view delivers context after the same batch", async () => {
  const r = await fixture({
    claim: true,
    scope: { kind: "project", projectId: Q },
  });
  assert.deepEqual(r.errors, []);
  assert.match(
    JSON.stringify(r.requests[1]),
    /Build, validate and report the owned fixture outcome/,
  );
  assert.match(
    JSON.stringify(contextPayload(r, "jp-task-claimed")),
    /outside the selected view/,
  );
  assert.ok(
    r.events.indexOf("marker-executed") < r.events.indexOf("provider-2"),
  );
});

test("native catalog view never supplies a foreign session's mission", async () => {
  const r = await fixture({
    foreign: true,
    scope: { kind: "project", projectId: P },
  });
  assert.equal(r.record.metadata.next_step, "Original action");
  assert.equal(r.calls.filter((call) => call[0] === "update").length, 0);
  assert.doesNotMatch(
    JSON.stringify(r.requests),
    /Build, validate and report the owned fixture outcome/,
  );
});
