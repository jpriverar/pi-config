import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  LifecycleIssue,
  LockOwner,
} from "../../lib/task-lifecycle/types.js";
import {
  createTaskLifecycleExtension,
  type TaskLifecycleToolService,
} from "./index.js";

const NOW = 1_789_636_800_000;

function normalizedIssue(phase = "active"): LifecycleIssue {
  return {
    id: "jp-1",
    title: "Lifecycle task",
    status: phase === "active" ? "in_progress" : "open",
    metadata: {},
    lifecycle: {
      version: 1,
      phase: phase as "active",
      waiting: null,
      stateEnteredAt: new Date(NOW).toISOString(),
      lastProgressAt: new Date(NOW).toISOString(),
      execution: null,
      artifacts: [],
      activeCheck: null,
      checkHistory: [],
      transitionHistory: [],
      resources: [],
      disposition: null,
    },
    dependencies: [],
  };
}

type Handler = (event: any, ctx: Context) => Promise<unknown> | unknown;
type Context = {
  cwd: string;
  sessionManager: { getSessionId(): string };
};
type Tool = {
  name: string;
  description: string;
  parameters: any;
  execute(
    id: string,
    params: any,
    signal: unknown,
    update: unknown,
    ctx: Context,
  ): Promise<any>;
};

function harness() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const service: TaskLifecycleToolService = {
    async claim(...args: Parameters<TaskLifecycleToolService["claim"]>) {
      calls.push({ name: "claim", args });
      return normalizedIssue();
    },
    async attachArtifact(
      ...args: Parameters<TaskLifecycleToolService["attachArtifact"]>
    ) {
      calls.push({ name: "attachArtifact", args });
      return normalizedIssue();
    },
    async waitForDependencies(
      ...args: Parameters<TaskLifecycleToolService["waitForDependencies"]>
    ) {
      calls.push({ name: "waitForDependencies", args });
      return normalizedIssue("waiting");
    },
    async waitForCheck(
      ...args: Parameters<TaskLifecycleToolService["waitForCheck"]>
    ) {
      calls.push({ name: "waitForCheck", args });
      return normalizedIssue("waiting");
    },
    async close(...args: Parameters<TaskLifecycleToolService["close"]>) {
      calls.push({ name: "close", args });
      return normalizedIssue("done");
    },
    async reopen(...args: Parameters<TaskLifecycleToolService["reopen"]>) {
      calls.push({ name: "reopen", args });
      return normalizedIssue("actionable");
    },
    async reconcileExecutionTimeout(
      ...args: Parameters<TaskLifecycleToolService["reconcileExecutionTimeout"]>
    ) {
      calls.push({ name: "reconcileExecutionTimeout", args });
      return normalizedIssue();
    },
  };
  const pi = {
    on(name: string, handler: Handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
  };
  createTaskLifecycleExtension({
    service,
    now: () => NOW,
    pid: 4242,
    hostname: "host",
  })(pi as any);
  return {
    calls,
    handlers,
    tools,
    context: {
      cwd: "/repo",
      sessionManager: { getSessionId: () => "session-1" },
    } satisfies Context,
  };
}

test("registers strict lifecycle tools and lifecycle hooks", () => {
  const h = harness();

  assert.deepEqual(
    [...h.tools.keys()],
    [
      "task_claim",
      "task_attach_artifact",
      "task_wait",
      "task_reconcile",
      "task_close",
      "task_reopen",
    ],
  );
  assert.deepEqual(
    [...h.handlers.keys()],
    ["session_start", "session_shutdown", "turn_start", "tool_call"],
  );
  for (const tool of h.tools.values()) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.parameters.properties.taskId.minLength, 1);
    assert.ok(tool.parameters.required.includes("taskId"));
  }
  assert.equal(
    h.tools.get("task_close")?.parameters.properties.reason.minLength,
    1,
  );
});

test("claim uses the tool call ID and current session ownership", async () => {
  const h = harness();

  const result = await h.tools
    .get("task_claim")
    ?.execute("tool-call-1", { taskId: "jp-1" }, null, null, h.context);

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, "claim");
  assert.deepEqual(h.calls[0].args, [
    "jp-1",
    {
      pid: 4242,
      sessionId: "session-1",
      host: "host",
      started: NOW,
    } satisfies LockOwner,
    "tool-call-1",
  ]);
  assert.match(result.content[0].text, /jp-1: active \(in_progress\)/);
  assert.equal(result.details.id, "jp-1");
});

test("wait routes dependency and check authorities explicitly", async () => {
  const h = harness();
  const wait = h.tools.get("task_wait")!;

  await wait.execute(
    "wait-dependency",
    { taskId: "jp-1", kind: "dependency", blockerIds: ["jp-2"] },
    null,
    null,
    h.context,
  );
  await wait.execute(
    "wait-check",
    {
      taskId: "jp-1",
      kind: "check",
      check: {
        id: "check-1",
        kind: "manual",
        targetArtifactIds: [],
        predicate: { reviewAt: "2026-09-18T10:00:00.000Z" },
        onSatisfied: "actionable",
        wakeOn: ["manual"],
        state: "pending",
        createdAt: "2026-09-17T10:00:00.000Z",
        lastCheckedAt: null,
        nextCheckAt: "2026-09-18T10:00:00.000Z",
        lastObservation: null,
        errorCount: 0,
      },
    },
    null,
    null,
    h.context,
  );

  assert.deepEqual(
    h.calls.map((call) => call.name),
    ["waitForDependencies", "waitForCheck"],
  );
});

test("headless lifecycle hooks never access TUI-only context", async () => {
  const h = harness();
  const headless = {
    cwd: h.context.cwd,
    sessionManager: h.context.sessionManager,
  };

  for (const handlers of h.handlers.values()) {
    for (const handler of handlers) await handler({}, headless);
  }

  assert.equal(h.calls.length, 0);
});
