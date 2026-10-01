import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  LifecycleIssue,
  LockOwner,
} from "../../lib/task-lifecycle/types.js";
import {
  createTaskLifecycleExtension,
  type TaskLifecycleToolService,
  type TaskLifecycleExtensionDependencies,
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

function activeIssue(id: string): LifecycleIssue {
  const result = normalizedIssue();
  result.id = id;
  result.lifecycle!.execution = {
    sessionId: "session-1",
    claimedAt: new Date(NOW).toISOString(),
    lastActivityAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    resourceSnapshot: {
      observedAt: new Date(NOW).toISOString(),
      resourceIds: [],
    },
  };
  return result;
}

type Handler = (event: any, ctx: Context) => Promise<unknown> | unknown;
type Context = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getBranch(): unknown[];
    getEntries(): unknown[];
    getSessionName(): undefined;
  };
  ui?: { notify(message: string, level: string): void };
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

function harness(overrides: Partial<TaskLifecycleExtensionDependencies> = {}) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const entryRenderers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const execCalls: Array<{
    executable: string;
    args: readonly string[];
    options: unknown;
  }> = [];
  const guardState = {
    activeTasks: [] as LifecycleIssue[],
    activeTaskLookupError: null as Error | null,
    associatedTasks: [] as LifecycleIssue[],
    associationLookupError: null as Error | null,
    finalizationError: null as Error | null,
  };
  const service = {
    async create(...args: any[]) {
      calls.push({ name: "create", args });
      return normalizedIssue("actionable");
    },
    async updateLabels(...args: any[]) {
      calls.push({ name: "updateLabels", args });
      return normalizedIssue("actionable");
    },
    async log(...args: any[]) {
      calls.push({ name: "log", args });
      return normalizedIssue();
    },
    async defer(...args: any[]) {
      calls.push({ name: "defer", args });
      return normalizedIssue("deferred");
    },
    async waitOnExistingCondition(...args: any[]) {
      calls.push({ name: "waitOnExistingCondition", args });
      return normalizedIssue("waiting");
    },
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
    async preflightWorktreeAcquire(...args: any[]) {
      calls.push({ name: "preflightWorktreeAcquire", args });
    },
    async recordWorktreeAcquire(...args: any[]) {
      calls.push({ name: "recordWorktreeAcquire", args });
      if (guardState.finalizationError !== null) {
        throw guardState.finalizationError;
      }
      return normalizedIssue();
    },
    async recordObservedArtifacts(...args: any[]) {
      calls.push({ name: "recordObservedArtifacts", args });
      return normalizedIssue();
    },
    async associatedTasksForClaim(...args: any[]) {
      calls.push({ name: "associatedTasksForClaim", args });
      if (guardState.associationLookupError !== null) {
        throw guardState.associationLookupError;
      }
      return guardState.associatedTasks;
    },
    async prepareWorktreeRelease(...args: any[]) {
      calls.push({ name: "prepareWorktreeRelease", args });
      return {
        version: 1,
        mode: "release",
        taskId: args[0],
        operationId: args[3],
        claimId: args[1],
        repository: "repo",
      } as const;
    },
    async finalizeWorktreeRelease(...args: any[]) {
      calls.push({ name: "finalizeWorktreeRelease", args });
      if (guardState.finalizationError !== null) {
        throw guardState.finalizationError;
      }
      return normalizedIssue();
    },
    async activeTasksForSession(
      ...args: Parameters<TaskLifecycleToolService["activeTasksForSession"]>
    ) {
      calls.push({ name: "activeTasksForSession", args });
      if (guardState.activeTaskLookupError !== null) {
        throw guardState.activeTaskLookupError;
      }
      return guardState.activeTasks;
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
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    appendEntry() {},
    sendMessage() {},
    registerEntryRenderer(type: string, renderer: Function) {
      entryRenderers.set(type, renderer);
    },
    exec: async (
      executable: string,
      args: readonly string[],
      options?: unknown,
    ) => {
      execCalls.push({ executable, args: [...args], options });
      const command = args.join(" ");
      const stdout =
        command === "rev-parse --show-toplevel"
          ? "/repo\n"
          : command === "config --get remote.origin.url"
            ? "https://github.com/DataDog/example.git\n"
            : command === "rev-parse --symbolic-full-name --verify HEAD"
              ? "refs/heads/topic\n"
              : command === "symbolic-ref --quiet --short HEAD"
                ? "topic\n"
                : command === "rev-parse --verify HEAD^{commit}"
                  ? `${"a".repeat(40)}\n`
                  : "[]";
      return { code: 0, stdout, stderr: "" };
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
    ...overrides,
  })(pi as any);
  return {
    calls,
    execCalls,
    guardState,
    handlers,
    tools,
    entryRenderers,
    commands,
    context: {
      cwd: "/repo",
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => [{ type: "message" }],
        getEntries: () => [],
        getSessionName: () => undefined,
      },
      ui: { notify() {} },
    } satisfies Context,
  };
}

test("registers strict lifecycle tools and lifecycle hooks", () => {
  const h = harness();

  assert.deepEqual(
    [...h.tools.keys()],
    [
      "task_create",
      "task_update",
      "task_log",
      "task_claim",
      "task_attach_artifact",
      "task_wait",
      "task_defer",
      "task_reconcile",
      "task_close",
      "task_reopen",
      "task_worktree_repair_preview",
      "task_worktree_repair_apply",
    ],
  );
  assert.deepEqual(
    [...h.handlers.keys()],
    [
      "session_shutdown",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "session_start",
      "session_compact",
    ],
  );
  assert.equal(h.entryRenderers.has("jp-work-startup"), true);
  for (const tool of h.tools.values()) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
  }
  for (const name of [...h.tools.keys()].filter(
    (name) => name !== "task_create",
  )) {
    const parameters = h.tools.get(name)!.parameters;
    assert.equal(parameters.properties.taskId.minLength, 1);
    assert.ok(parameters.required.includes("taskId"));
  }
  assert.equal(
    h.tools.get("task_update")?.parameters.properties.status,
    undefined,
  );
  assert.equal(
    h.tools.get("task_log")?.parameters.properties.message.minLength,
    1,
  );
  assert.deepEqual(h.tools.get("task_wait")?.parameters.required, ["taskId"]);
  assert.equal(
    h.tools.get("task_close")?.parameters.properties.reason.minLength,
    1,
  );
});

test("wires passive Git observation through argv-only Pi execution", async () => {
  const h = harness();
  h.guardState.activeTasks = [activeIssue("jp-1")];
  const emit = async (event: "tool_call" | "tool_result", value: any) => {
    for (const handler of h.handlers.get(event) ?? []) {
      assert.equal(await handler(value, h.context), undefined);
    }
  };

  await emit("tool_call", {
    toolName: "bash",
    toolCallId: "unrelated",
    input: { command: "git status --short" },
  });
  await emit("tool_result", {
    toolName: "bash",
    toolCallId: "unrelated",
    isError: false,
  });
  assert.deepEqual(h.execCalls, []);

  await emit("tool_call", {
    toolName: "bash",
    toolCallId: "commit-1",
    input: { command: "git commit -m ship" },
  });
  await emit("tool_result", {
    toolName: "bash",
    toolCallId: "commit-1",
    isError: false,
  });

  assert.equal(h.execCalls.length, 5);
  for (const { executable, options } of h.execCalls) {
    assert.equal(executable, "git");
    assert.deepEqual(options, { cwd: "/repo", timeout: 10_000 });
  }
  assert.equal(
    h.calls.filter(({ name }) => name === "recordObservedArtifacts").length,
    1,
  );
});

test("routes safe task mutations with strict field mappings", async () => {
  const h = harness();
  const owner = {
    pid: 4242,
    sessionId: "session-1",
    host: "host",
    started: NOW,
  } satisfies LockOwner;

  await h.tools.get("task_create")!.execute(
    "create-call",
    {
      title: "Do the work",
      why: "It matters",
      workstream: "lifecycle",
      needs_jp: true,
    },
    null,
    null,
    h.context,
  );
  await h.tools
    .get("task_update")!
    .execute(
      "update-call",
      { taskId: "jp-1", add_labels: ["one"], remove_labels: ["two"] },
      null,
      null,
      h.context,
    );
  await h.tools
    .get("task_log")!
    .execute(
      "log-call",
      { taskId: "jp-1", message: "Implemented the service." },
      null,
      null,
      h.context,
    );
  await h.tools
    .get("task_defer")!
    .execute(
      "defer-call",
      { taskId: "jp-1", reason: "Pause this." },
      null,
      null,
      h.context,
    );

  assert.deepEqual(h.calls, [
    {
      name: "create",
      args: [
        {
          title: "Do the work",
          why: "It matters",
          workstream: "lifecycle",
          needsJp: true,
        },
        owner,
      ],
    },
    {
      name: "updateLabels",
      args: ["jp-1", { addLabels: ["one"], removeLabels: ["two"] }, owner],
    },
    {
      name: "log",
      args: ["jp-1", "Implemented the service.", owner],
    },
    {
      name: "defer",
      args: ["jp-1", "Pause this.", owner, "defer-call"],
    },
  ]);
});

test("close drops irrelevant superseding placeholders", async () => {
  const h = harness();
  const close = h.tools.get("task_close")!;

  await close.execute(
    "close-completed",
    {
      taskId: "jp-1",
      kind: "completed",
      reason: "Done",
      evidenceArtifactIds: ["commit:one"],
      supersedingTaskId: ":none",
    },
    null,
    null,
    h.context,
  );
  await close.execute(
    "close-superseded",
    {
      taskId: "jp-1",
      kind: "superseded",
      reason: "Replaced",
      evidenceArtifactIds: [],
      supersedingTaskId: "jp-2",
    },
    null,
    null,
    h.context,
  );

  assert.deepEqual(h.calls[0].args[1], {
    kind: "completed",
    reason: "Done",
    evidenceArtifactIds: ["commit:one"],
  });
  assert.deepEqual(h.calls[1].args[1], {
    kind: "superseded",
    reason: "Replaced",
    evidenceArtifactIds: [],
    supersedingTaskId: "jp-2",
  });
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

test("wait routes retained, dependency, and check authorities explicitly", async () => {
  const h = harness();
  const wait = h.tools.get("task_wait")!;

  await wait.execute(
    "wait-existing",
    { taskId: "jp-1" },
    null,
    null,
    h.context,
  );
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
    ["waitOnExistingCondition", "waitForDependencies", "waitForCheck"],
  );
  assert.deepEqual(h.calls[0].args.slice(0, 2), [
    "jp-1",
    {
      pid: 4242,
      sessionId: "session-1",
      host: "host",
      started: NOW,
    },
  ]);
  assert.equal(h.calls[0].args[2], "wait-existing");

  await assert.rejects(
    wait.execute(
      "wait-invalid",
      { taskId: "jp-1", blockerIds: ["jp-2"] },
      null,
      null,
      h.context,
    ),
    /kind is required/,
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

test("guards task-scoped execution and lifecycle targets", async () => {
  const h = harness();
  const guard = h.handlers.get("tool_call")![0];

  assert.deepEqual(
    await guard(
      {
        toolName: "subagent",
        input: { agent: "worker", task: "implement" },
      },
      h.context,
    ),
    {
      block: true,
      reason:
        "subagent execution requires an Active task; claim a task before retrying",
    },
  );
  assert.deepEqual(
    await guard(
      { toolName: "task_wait", input: { taskId: "jp-a" } },
      h.context,
    ),
    {
      block: true,
      reason: "task_wait requires active task jp-a; claim it before retrying",
    },
  );
  assert.equal(
    await guard(
      { toolName: "task_claim", input: { taskId: "jp-a" } },
      h.context,
    ),
    undefined,
  );

  h.guardState.activeTasks = [activeIssue("jp-a")];
  assert.equal(
    await guard(
      {
        toolName: "subagent",
        input: { workflow: "review", args: {} },
      },
      h.context,
    ),
    undefined,
  );
  assert.equal(
    await guard(
      { toolName: "task_wait", input: { taskId: "jp-a" } },
      h.context,
    ),
    undefined,
  );
  assert.deepEqual(
    await guard(
      { toolName: "task_wait", input: { taskId: "jp-b" } },
      h.context,
    ),
    {
      block: true,
      reason: "session owns active task jp-a, not jp-b",
    },
  );
  assert.equal(
    await guard(
      { toolName: "task_claim", input: { taskId: "jp-a" } },
      h.context,
    ),
    undefined,
  );
  assert.deepEqual(
    await guard(
      { toolName: "task_claim", input: { taskId: "jp-b" } },
      h.context,
    ),
    {
      block: true,
      reason:
        "session already owns active task jp-a; wait, close, or relinquish it before claiming jp-b",
    },
  );
});

test("leaves management and unknown tools available without ownership lookup", async () => {
  const h = harness();
  const guard = h.handlers.get("tool_call")![0];

  assert.equal(
    await guard({ toolName: "subagent", input: { action: "list" } }, h.context),
    undefined,
  );
  assert.equal(
    await guard(
      { toolName: "bash", input: { command: "git status" } },
      h.context,
    ),
    undefined,
  );
  assert.equal(
    h.calls.filter((call) => call.name === "activeTasksForSession").length,
    0,
  );
});

test("fails protected calls closed for ambiguous ownership and store errors", async () => {
  const h = harness();
  const guard = h.handlers.get("tool_call")![0];

  h.guardState.activeTasks = [activeIssue("jp-z"), activeIssue("jp-a")];
  assert.deepEqual(
    await guard(
      { toolName: "subagent", input: { agent: "worker", task: "run" } },
      h.context,
    ),
    {
      block: true,
      reason:
        "session owns multiple Active tasks: jp-a, jp-z; repair lifecycle state before retrying",
    },
  );

  h.guardState.activeTaskLookupError = new Error(
    "private task content and raw stderr",
  );
  const failed = await guard(
    { toolName: "subagent", input: { agent: "worker", task: "run" } },
    h.context,
  );
  assert.deepEqual(failed, {
    block: true,
    reason: "unable to verify Active task ownership for subagent",
  });
  assert.doesNotMatch(
    JSON.stringify(failed),
    /private task content|raw stderr/,
  );
});

test("requires an Active task and prepares ordinary pool acquisition", async () => {
  const h = harness();
  const guard = h.handlers.get("tool_call")![0];
  const input: Record<string, unknown> = {
    action: "acquire",
    repository: "repo",
    branch: "topic",
  };

  assert.deepEqual(
    await guard(
      { toolCallId: "acquire-call", toolName: "worktree_pool", input },
      h.context,
    ),
    {
      block: true,
      reason:
        "worktree_pool acquire requires an Active task; claim a task before retrying",
    },
  );

  h.guardState.activeTasks = [activeIssue("jp-a")];
  assert.equal(
    await guard(
      { toolCallId: "acquire-call", toolName: "worktree_pool", input },
      h.context,
    ),
    undefined,
  );
  assert.deepEqual(input, {
    action: "acquire",
    repository: "repo",
    branch: "topic",
  });
  assert.equal(
    h.calls.some((call) => call.name === "prepareWorktreeAcquire"),
    false,
  );
});

test("records successful acquisition against the task captured at tool_call", async () => {
  const h = harness();
  const acquire = {
    toolCallId: "acquire-call",
    toolName: "worktree_pool",
    input: {
      action: "acquire",
      repository: "repo",
      branch: "topic",
      startPoint: "origin/main",
    },
  };
  h.guardState.activeTasks = [activeIssue("jp-a")];
  await h.handlers.get("tool_call")![0](acquire, h.context);
  h.guardState.activeTasks = [activeIssue("jp-b")];

  const receipt = {
    claimId: "claim-1",
    path: "/tmp/worktree",
    branch: "topic",
    reused: false,
    head: "abc123",
    startPoint: "origin/main",
    startPointHead: "abc123",
    startPointFetched: true,
    relationship: "equal",
  };
  assert.equal(
    await h.handlers.get("tool_result")![0](
      { ...acquire, details: receipt, isError: false },
      h.context,
    ),
    undefined,
  );

  const recorded = h.calls.find(
    (call) => call.name === "recordWorktreeAcquire",
  )!;
  assert.deepEqual(recorded.args[0], {
    taskId: "jp-a",
    repository: "repo",
    branch: "topic",
    startPoint: "origin/main",
  });
  assert.deepEqual(recorded.args[1], receipt);
  assert.equal(recorded.args[3], "acquire-call");

  const count = h.calls.length;
  await h.handlers.get("tool_result")![0](
    { ...acquire, details: receipt, isError: false },
    h.context,
  );
  assert.equal(h.calls.length, count);
});

test("rejects a malformed successful acquire receipt without mutation", async () => {
  const h = harness();
  const acquire = {
    toolCallId: "acquire-call",
    toolName: "worktree_pool",
    input: { action: "acquire", repository: "repo", branch: "topic" },
  };
  h.guardState.activeTasks = [activeIssue("jp-a")];
  await h.handlers.get("tool_call")![0](acquire, h.context);
  const count = h.calls.length;

  assert.deepEqual(
    await h.handlers.get("tool_result")![0](
      {
        ...acquire,
        details: { claimId: "claim-1", path: "/tmp/worktree" },
        isError: false,
      },
      h.context,
    ),
    {
      content: [
        {
          type: "text",
          text: "unable to finalize worktree_pool acquire lifecycle state",
        },
      ],
      details: { action: "acquire" },
      isError: true,
    },
  );
  assert.equal(h.calls.length, count);
});

test("prepares associated release and preserves recovery operations", async () => {
  const h = harness();
  const guard = h.handlers.get("tool_call")![0];
  h.guardState.activeTasks = [activeIssue("jp-a")];
  h.guardState.associatedTasks = [activeIssue("jp-a")];
  const input: Record<string, unknown> = {
    action: "release",
    repository: "repo",
    claimId: "claim-1",
  };

  assert.equal(
    await guard(
      { toolCallId: "release-call", toolName: "worktree_pool", input },
      h.context,
    ),
    undefined,
  );
  assert.deepEqual(input, {
    action: "release",
    repository: "repo",
    claimId: "claim-1",
  });
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

  const recovery = harness();
  assert.equal(
    await recovery.handlers.get("tool_call")![0](
      {
        toolName: "worktree_pool",
        input: { action: "release", claimId: "unassociated" },
      },
      recovery.context,
    ),
    undefined,
  );
});

test("fails associated release closed for foreign, ambiguous, or unknown ownership", async () => {
  const release = {
    toolCallId: "release-call",
    toolName: "worktree_pool",
    input: { action: "release", repository: "repo", claimId: "claim-1" },
  };

  const foreign = harness();
  foreign.guardState.activeTasks = [activeIssue("jp-b")];
  foreign.guardState.associatedTasks = [activeIssue("jp-a")];
  assert.deepEqual(
    await foreign.handlers.get("tool_call")![0](release, foreign.context),
    { block: true, reason: "session owns active task jp-b, not jp-a" },
  );

  const ambiguous = harness();
  ambiguous.guardState.associatedTasks = [
    activeIssue("jp-z"),
    activeIssue("jp-a"),
  ];
  assert.deepEqual(
    await ambiguous.handlers.get("tool_call")![0](release, ambiguous.context),
    {
      block: true,
      reason:
        "worktree claim claim-1 is associated with multiple lifecycle tasks: jp-a, jp-z; repair lifecycle state before retrying",
    },
  );

  const unavailable = harness();
  unavailable.guardState.associationLookupError = new Error(
    "private task data and raw stderr",
  );
  const result = await unavailable.handlers.get("tool_call")![0](
    release,
    unavailable.context,
  );
  assert.deepEqual(result, {
    block: true,
    reason: "unable to verify worktree lifecycle association for release",
  });
  assert.doesNotMatch(JSON.stringify(result), /private task data|raw stderr/);
});

test("finalizes correlated release results and skips failures", async () => {
  const h = harness();
  const guard = h.handlers.get("tool_call")![0];
  const finalize = h.handlers.get("tool_result")![0];
  h.guardState.activeTasks = [activeIssue("jp-a")];
  h.guardState.associatedTasks = [activeIssue("jp-a")];
  const release = {
    toolCallId: "release-call",
    toolName: "worktree_pool",
    input: { action: "release", repository: "repo", claimId: "claim-1" },
  };
  await guard(release, h.context);
  await finalize(
    {
      ...release,
      details: { released: true, path: "/tmp/worktree" },
      isError: false,
    },
    h.context,
  );
  assert.equal(h.calls.at(-1)?.name, "finalizeWorktreeRelease");

  const acquire = {
    toolCallId: "failed-acquire",
    toolName: "worktree_pool",
    input: { action: "acquire", repository: "repo", branch: "topic" },
  };
  await guard(acquire, h.context);
  const count = h.calls.length;
  await finalize({ ...acquire, details: null, isError: true }, h.context);
  assert.equal(h.calls.length, count);

  const refused = { ...release, toolCallId: "refused-release" };
  await guard(refused, h.context);
  const preparedCount = h.calls.length;
  await finalize(
    {
      ...refused,
      details: { released: false, path: "/tmp/worktree" },
      isError: false,
    },
    h.context,
  );
  assert.equal(h.calls.length, preparedCount);
});

test("returns a curated error when pool result finalization fails", async () => {
  const h = harness();
  h.guardState.activeTasks = [activeIssue("jp-a")];
  h.guardState.associatedTasks = [activeIssue("jp-a")];
  const release = {
    toolCallId: "release-call",
    toolName: "worktree_pool",
    input: { action: "release", repository: "repo", claimId: "claim-1" },
  };
  await h.handlers.get("tool_call")![0](release, h.context);
  h.guardState.finalizationError = new Error(
    "private task data and raw stderr",
  );
  const result = await h.handlers.get("tool_result")![0](
    {
      ...release,
      details: { released: true, path: "/tmp/worktree" },
      isError: false,
    },
    h.context,
  );

  assert.deepEqual(result, {
    content: [
      {
        type: "text",
        text: "worktree_pool release completed for claim claim-1, but task jp-a lifecycle finalization failed; reconcile the task before continuing",
      },
    ],
    details: { action: "release", claimId: "claim-1", taskId: "jp-a" },
    isError: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /private task data|raw stderr/);
});

test("activity and shutdown stay local without automatic reconciliation", async () => {
  const h = harness();
  const handler = (name: string) => h.handlers.get(name)![0];

  await handler("session_start")({ reason: "startup" }, h.context);
  assert.equal(h.calls.length, 0);

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

test("task_reconcile passes explicit manual outcomes to the daemon", async () => {
  const { waitingTask } = await import(
    "../../lib/task-reconciler/test-fixtures.js"
  );
  const issue = waitingTask("jp-1", "manual");
  const { fingerprintCheck } = await import(
    "../../lib/task-lifecycle/reconciliation.js"
  );
  const requests: unknown[] = [];
  const h = harness({
    reconciliation: {
      issue: async () => issue,
      request: async (request) => {
        requests.push(request);
        return {
          requestId: request.requestId,
          outcome: "applied",
          task: { id: "jp-1", phase: "actionable", status: "open" },
        };
      },
    },
  });

  await h.tools
    .get("task_reconcile")!
    .execute(
      "reconcile-call",
      { taskId: "jp-1", manualOutcome: "action_required" },
      null,
      null,
      h.context,
    );

  assert.deepEqual(requests, [
    {
      requestId: "reconcile-call",
      taskId: "jp-1",
      manualOutcome: "action_required",
      expectedCheckFingerprint: fingerprintCheck(issue),
    },
  ]);
  assert.equal(h.calls.length, 0);
});

for (const optionalFields of [
  {},
  { manualOutcome: null, requestId: null, expectedCheckFingerprint: null },
]) {
  test(`ordinary reconciliation does not invent manual authority (${JSON.stringify(optionalFields)})`, async () => {
    const requests: unknown[] = [];
    const h = harness({
      reconciliation: {
        issue: async () => {
          throw new Error(
            "ordinary reconciliation must not capture a manual check",
          );
        },
        request: async (request) => {
          requests.push(request);
          return {
            requestId: request.requestId,
            outcome: "unchanged",
            task: { id: "jp-1", phase: "active", status: "in_progress" },
          };
        },
      },
    });
    const result = await h.tools
      .get("task_reconcile")!
      .execute(
        "ordinary",
        { taskId: "jp-1", ...optionalFields },
        undefined,
        undefined,
        h.context,
      );
    assert.deepEqual(requests, [{ requestId: "ordinary", taskId: "jp-1" }]);
    assert.equal(result.details.outcome, "unchanged");
  });
}

test("manual-check rejection throws without suggesting daemon setup", async () => {
  const { ReconciliationClientError } = await import(
    "../../lib/task-reconciler/client.js"
  );
  const h = harness({
    reconciliation: {
      issue: async () => normalizedIssue(),
      request: async () => {
        throw new ReconciliationClientError(
          "manual_check_required",
          "reconciliation rejected (manual_check_required)",
        );
      },
    },
  });
  await assert.rejects(
    h.tools.get("task_reconcile")!.execute(
      "reconcile",
      {
        taskId: "jp-1",
        manualOutcome: "action_required",
        requestId: "retry",
        expectedCheckFingerprint: "0".repeat(64),
      },
      undefined,
      undefined,
      h.context,
    ),
    (error: Error) => {
      assert.match(error.message, /no.*manual check|does not.*manual check/i);
      assert.match(error.message, /omit.*manualOutcome/i);
      assert.doesNotMatch(
        error.message,
        /install|start require|task-reconciler status/i,
      );
      return true;
    },
  );
});

test("startup and reload never reconcile or administer the service", async () => {
  const h = harness();
  for (const reason of ["startup", "reload"])
    for (const handler of h.handlers.get("session_start") ?? [])
      await handler({ reason }, h.context);
  assert.ok(
    !h.calls.some(
      (c) => c.name === "reconcileDue" || c.name === "reconcileTask",
    ),
  );
  assert.ok(
    !h.execCalls.some((c) =>
      c.args.some((arg) => arg.includes("task-reconciler")),
    ),
  );
});

test("manual timeout returns a binding and retry does not recapture a replaced check", async () => {
  const { waitingTask } = await import(
    "../../lib/task-reconciler/test-fixtures.js"
  );
  const { fingerprintCheck } = await import(
    "../../lib/task-lifecycle/reconciliation.js"
  );
  const { ReconciliationUnknownResultError } = await import(
    "../../lib/task-reconciler/client.js"
  );
  const issue = waitingTask("jp-1", "manual");
  let reads = 0;
  const requests: any[] = [];
  const fingerprint = fingerprintCheck(issue);
  const h = harness({
    reconciliation: {
      issue: async () => {
        reads += 1;
        return issue;
      },
      request: async (request) => {
        requests.push(request);
        throw new ReconciliationUnknownResultError(
          request,
          "fixture_lost_response",
        );
      },
    },
  });
  const tool = h.tools.get("task_reconcile")!;
  let retry: Record<string, unknown> = {};
  await assert.rejects(
    tool.execute(
      "first",
      { taskId: "jp-1", manualOutcome: "satisfied" },
      undefined,
      undefined,
      h.context,
    ),
    (error: Error) => {
      assert.match(error.message, /result unknown/);
      retry = JSON.parse(
        error.message.slice(
          error.message.indexOf("binding: ") + "binding: ".length,
        ),
      );
      assert.equal(retry.expectedCheckFingerprint, fingerprint);
      return true;
    },
  );
  issue.lifecycle!.activeCheck!.id = "replacement";
  await assert.rejects(
    tool.execute("second", retry, undefined, undefined, h.context),
    /result unknown/,
  );
  assert.equal(reads, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.ok(!h.calls.some((c) => c.name === "reconcileTask"));
});

test("unavailable daemon and incomplete manual retry fail without local fallback", async () => {
  const { ReconciliationClientError } = await import(
    "../../lib/task-reconciler/client.js"
  );
  const h = harness({
    reconciliation: {
      issue: async () => {
        throw new Error("must not read a replacement check");
      },
      request: async () => {
        throw new ReconciliationClientError(
          "incompatible",
          "protocol incompatible",
        );
      },
    },
  });
  const tool = h.tools.get("task_reconcile")!;
  await assert.rejects(
    tool.execute(
      "request",
      { taskId: "jp-1" },
      undefined,
      undefined,
      h.context,
    ),
    /incompatible/,
  );
  await assert.rejects(
    tool.execute(
      "retry",
      { taskId: "jp-1", requestId: "old", manualOutcome: "satisfied" },
      undefined,
      undefined,
      h.context,
    ),
    /fingerprint|binding/i,
  );
  assert.ok(!h.calls.some((c) => c.name === "reconcileTask"));
});

test("administration requires explicit allowlisted invocation and uses an absolute launcher", async () => {
  const h = harness();
  const command = h.commands.get("task-reconciler");
  assert.ok(command);
  const ctx = { ...h.context, cwd: "/unrelated", ui: { notify() {} } };
  await command.handler("status", ctx);
  const call = h.execCalls.at(-1)!;
  assert.equal(call.executable, process.execPath);
  assert.ok(call.args[0].startsWith("/"));
  assert.ok(call.args[0].endsWith("/bin/task-reconciler.mjs"));
  assert.equal(call.args[1], "status");
  assert.equal(call.args[2], "--config");
  const count = h.execCalls.length;
  await command.handler("start; echo unsafe", ctx);
  assert.equal(h.execCalls.length, count);
});
