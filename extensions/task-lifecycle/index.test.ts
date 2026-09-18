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
  const guardState = { activeTask: false, associatedClaims: new Set<string>() };
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
    async reconcileTask(
      ...args: Parameters<TaskLifecycleToolService["reconcileTask"]>
    ) {
      calls.push({ name: "reconcileTask", args });
      return normalizedIssue();
    },
    async reconcileDue(
      ...args: Parameters<TaskLifecycleToolService["reconcileDue"]>
    ) {
      calls.push({ name: "reconcileDue", args });
      return [];
    },
    async refreshSessionActivity(
      ...args: Parameters<TaskLifecycleToolService["refreshSessionActivity"]>
    ) {
      calls.push({ name: "refreshSessionActivity", args });
      return [];
    },
    async interruptSession(
      ...args: Parameters<TaskLifecycleToolService["interruptSession"]>
    ) {
      calls.push({ name: "interruptSession", args });
      return [];
    },
    async acquireWorktree(
      ...args: Parameters<TaskLifecycleToolService["acquireWorktree"]>
    ) {
      calls.push({ name: "acquireWorktree", args });
      return normalizedIssue();
    },
    async releaseWorktree(
      ...args: Parameters<TaskLifecycleToolService["releaseWorktree"]>
    ) {
      calls.push({ name: "releaseWorktree", args });
      return normalizedIssue();
    },
    async hasActiveTask(
      ...args: Parameters<TaskLifecycleToolService["hasActiveTask"]>
    ) {
      calls.push({ name: "hasActiveTask", args });
      return guardState.activeTask;
    },
    async isClaimAssociated(
      ...args: Parameters<TaskLifecycleToolService["isClaimAssociated"]>
    ) {
      calls.push({ name: "isClaimAssociated", args });
      return guardState.associatedClaims.has(args[0]);
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
    activityWriteIntervalMs: 300_000,
    sessionReconcileLimit: 10,
    sessionPrCheckLimit: 5,
  })(pi as any);
  return {
    calls,
    guardState,
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
      "task_worktree_acquire",
      "task_worktree_release",
    ],
  );
  assert.deepEqual(
    [...h.handlers.keys()],
    [
      "session_start",
      "session_shutdown",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "before_agent_start",
      "tool_call",
    ],
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

  await h.handlers.get("before_agent_start")?.[0]({}, headless);
  await h.handlers.get("tool_call")?.[0]({}, headless);

  assert.equal(h.calls.length, 0);
});

test("task worktree tools route only task and pool coordinates", async () => {
  const h = harness();

  await h.tools.get("task_worktree_acquire")!.execute(
    "acquire-call",
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
      startPoint: "origin/main",
    },
    null,
    null,
    h.context,
  );
  await h.tools
    .get("task_worktree_release")!
    .execute(
      "release-call",
      { taskId: "jp-1", claimId: "claim-1" },
      null,
      null,
      h.context,
    );

  assert.deepEqual(
    h.calls.slice(0, 2).map((call) => call.name),
    ["acquireWorktree", "releaseWorktree"],
  );
  assert.deepEqual(h.calls[0].args[0], {
    taskId: "jp-1",
    repository: "DataDog/dd-source",
    branch: "jpriverar/topic",
    startPoint: "origin/main",
  });
  assert.equal(h.calls[0].args[2], "acquire-call");
  assert.equal(h.calls[1].args[3], "release-call");
});

test("guards raw pool mutations while preserving inspection and taskless work", async () => {
  const h = harness();
  const guard = h.handlers.get("tool_call")![0];

  h.guardState.activeTask = true;
  const blockedAcquire = await guard(
    {
      toolName: "worktree_pool",
      input: { action: "acquire", repository: "repo", branch: "topic" },
    },
    h.context,
  );
  assert.ok(blockedAcquire && typeof blockedAcquire === "object");
  assert.equal((blockedAcquire as any).block, true);
  assert.match((blockedAcquire as any).reason, /task_worktree_acquire/);
  assert.equal(
    await guard(
      { toolName: "worktree_pool", input: { action: "list" } },
      h.context,
    ),
    undefined,
  );
  assert.equal(
    await guard(
      { toolName: "worktree_pool", input: { action: "repair" } },
      h.context,
    ),
    undefined,
  );

  h.guardState.activeTask = false;
  assert.equal(
    await guard(
      { toolName: "worktree_pool", input: { action: "acquire" } },
      h.context,
    ),
    undefined,
  );
  h.guardState.associatedClaims.add("claim-1");
  const blockedRelease = await guard(
    {
      toolName: "worktree_pool",
      input: { action: "release", claimId: "claim-1" },
    },
    h.context,
  );
  assert.ok(blockedRelease && typeof blockedRelease === "object");
  assert.equal((blockedRelease as any).block, true);
  assert.match((blockedRelease as any).reason, /task_worktree_release/);
  assert.equal(
    await guard(
      {
        toolName: "worktree_pool",
        input: { action: "release", claimId: "unassociated" },
      },
      h.context,
    ),
    undefined,
  );
});

test("session and activity hooks reconcile synchronously without timers", async () => {
  const h = harness();
  const handler = (name: string) => h.handlers.get(name)![0];

  await handler("session_start")({ reason: "startup" }, h.context);
  assert.deepEqual(h.calls.at(-1), {
    name: "reconcileDue",
    args: [
      {
        pid: 4242,
        sessionId: "session-1",
        host: "host",
        started: NOW,
      },
      { taskLimit: 10, checkLimit: 5 },
    ],
  });

  await handler("turn_start")({}, h.context);
  await handler("tool_execution_start")({}, h.context);
  await handler("tool_execution_end")({}, h.context);
  assert.equal(
    h.calls.filter((call) => call.name === "refreshSessionActivity").length,
    3,
  );

  await handler("session_shutdown")({ reason: "reload" }, h.context);
  assert.equal(
    h.calls.filter((call) => call.name === "interruptSession").length,
    0,
  );
  await handler("session_shutdown")({ reason: "quit" }, h.context);
  assert.deepEqual(h.calls.at(-1), {
    name: "interruptSession",
    args: [
      {
        pid: 4242,
        sessionId: "session-1",
        host: "host",
        started: NOW,
      },
      "quit",
    ],
  });
});

test("task_reconcile passes explicit manual outcomes", async () => {
  const h = harness();

  await h.tools
    .get("task_reconcile")!
    .execute(
      "reconcile-call",
      { taskId: "jp-1", manualOutcome: "action_required" },
      null,
      null,
      h.context,
    );

  assert.deepEqual(h.calls.at(-1), {
    name: "reconcileTask",
    args: [
      "jp-1",
      {
        pid: 4242,
        sessionId: "session-1",
        host: "host",
        started: NOW,
      },
      { manualOutcome: "action_required" },
    ],
  });
});
