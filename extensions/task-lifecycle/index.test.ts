import { legacyLifecycle } from "../../lib/task-lifecycle/legacy-test-fixtures.js";
import { newWorkManagementState } from "../../lib/work-management/model.js";
import { target as wmTarget } from "../../lib/work-management/test-fixtures.js";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  state as v2State,
  withCheck,
  NOW as V2_NOW,
  OWNER as V2_OWNER,
} from "../../lib/task-lifecycle/v2-test-fixtures.js";
import {
  nativeStatusV2,
  blockLifecycleV2,
  fingerprintConditionV2,
} from "../../lib/task-lifecycle/v2-model.js";
import { test } from "node:test";

import type {
  LifecycleIssue,
  LockOwner,
} from "../../lib/task-lifecycle/types.js";
import type { SessionFactsResult } from "./task-context.js";
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
  legacyLifecycle(result.lifecycle!).execution = {
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
    getSessionName(): string | undefined;
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
  const sent: Array<{ message: any; options: any }> = [];
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
    async prepareWorktreeAcquire(...args: any[]) {
      calls.push({ name: "prepareWorktreeAcquire", args });
      return {
        version: 1,
        mode: "acquire",
        taskId: args[0].taskId,
        operationId: args[2],
        repository: "repo",
        claimId: "claim",
        pathId: "path",
      } as const;
    },
    async finalizeWorktreeAcquire(...args: any[]) {
      calls.push({ name: "finalizeWorktreeAcquire", args });
      return normalizedIssue();
    },
    async ownedTasksForSession(...args: any[]) {
      calls.push({ name: "ownedTasksForSession", args });
      if (guardState.activeTaskLookupError)
        throw guardState.activeTaskLookupError;
      return guardState.activeTasks;
    },
    async block(...args: any[]) {
      calls.push({ name: "block", args });
      return normalizedIssue("waiting");
    },
    async resume(...args: any[]) {
      calls.push({ name: "resume", args });
      return normalizedIssue();
    },
    async release(...args: any[]) {
      calls.push({ name: "release", args });
      return normalizedIssue("actionable");
    },
    async updateCondition(...args: any[]) {
      calls.push({ name: "updateCondition", args });
      return normalizedIssue();
    },
    async create(...args: any[]) {
      calls.push({ name: "create", args });
      return normalizedIssue("actionable");
    },
    async updateTask(...args: any[]) {
      calls.push({ name: "updateTask", args });
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
      return overrides.lifecycleWriteVersion === 2
        ? guardState.activeTasks.filter(
            (issue) => issue.lifecycle?.phase === "active",
          )
        : guardState.activeTasks;
    },
  };
  const pi = {
    events: createEventBus(),
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
    appendEntry(_customType: string, _data: unknown) {},
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
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
    service,
    pi,
    sent,
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
        getEntries: (): unknown[] => [],
        getSessionName: (): string | undefined => undefined,
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
    ],
  );
  assert.deepEqual(
    [...h.handlers.keys()].sort(),
    [
      "session_shutdown",
      "session_before_fork",
      "agent_before_settle",
      "turn_start",
      "tool_execution_start",
      "tool_execution_end",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "session_start",
      "session_compact",
    ].sort(),
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

test("task_update exposes and forwards task content without inventing omitted fields", async () => {
  const h = harness();
  const tool = h.tools.get("task_update")!;
  await tool.execute(
    "content",
    {
      taskId: "jp-1",
      description: "Build, validate and report",
      next_step: null,
    },
    null,
    null,
    h.context,
  );
  assert.deepEqual(h.calls[0], {
    name: "updateTask",
    args: [
      "jp-1",
      {
        addLabels: [],
        removeLabels: [],
        description: "Build, validate and report",
        nextStep: null,
      },
      { pid: 4242, sessionId: "session-1", host: "host", started: NOW },
    ],
  });
  assert.ok(Object.hasOwn(tool.parameters.properties, "description"));
  assert.ok(Object.hasOwn(tool.parameters.properties, "next_step"));
  assert.deepEqual(tool.parameters.required, ["taskId"]);

  await tool.execute(
    "labels",
    { taskId: "jp-1", add_labels: ["needs:jp"] },
    null,
    null,
    h.context,
  );
  assert.deepEqual(h.calls[1].args[1], {
    addLabels: ["needs:jp"],
    removeLabels: [],
  });
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
      name: "updateTask",
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

for (const fixture of [
  {
    name: "inherits explicit scope instead of the session display name",
    scope: "pi-setup",
    displayName: "pi-setup-deadbeef",
    requested: undefined,
    expected: "pi-setup",
  },
  {
    name: "accepts a workstream matching explicit scope",
    scope: "pi-setup",
    displayName: "different-display-name",
    requested: "pi-setup",
    expected: "pi-setup",
  },
  {
    name: "matches scope case-insensitively and keeps the session spelling",
    scope: "Pi-Setup",
    displayName: undefined,
    requested: "pi-setup",
    expected: "Pi-Setup",
  },
  {
    name: "inherits legacy display-name scope",
    scope: undefined,
    displayName: "legacy-project",
    requested: undefined,
    expected: "legacy-project",
  },
  {
    name: "keeps unnamed sessions unscoped when workstream is omitted",
    scope: undefined,
    displayName: undefined,
    requested: undefined,
    expected: undefined,
  },
  {
    name: "respects explicit global scope despite a display name",
    scope: null,
    displayName: "pi-setup-deadbeef",
    requested: undefined,
    expected: undefined,
  },
  {
    name: "allows an explicit workstream in a globally scoped session",
    scope: null,
    displayName: "pi-setup-deadbeef",
    requested: "another-project",
    expected: "another-project",
  },
]) {
  test(`task_create ${fixture.name}`, async () => {
    const h = harness();
    const context: Context = {
      ...h.context,
      sessionManager: {
        ...h.context.sessionManager,
        getEntries: () =>
          fixture.scope === undefined
            ? []
            : [
                {
                  type: "custom",
                  customType: "jp-project-scope",
                  data: { version: 1, workstream: fixture.scope },
                },
              ],
        getSessionName: () => fixture.displayName,
      },
    };

    await h.tools.get("task_create")!.execute(
      "create-call",
      {
        title: "Scoped task",
        why: "Keep work in its project",
        needs_jp: false,
        ...(fixture.requested === undefined
          ? {}
          : { workstream: fixture.requested }),
      },
      null,
      null,
      context,
    );

    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].args[0], {
      title: "Scoped task",
      why: "Keep work in its project",
      needsJp: false,
      ...(fixture.expected === undefined
        ? {}
        : { workstream: fixture.expected }),
    });
  });
}

for (const explicit of [true, false]) {
  test(`task_create rejects mismatches against ${explicit ? "explicit" : "legacy"} scope before creation`, async () => {
    const h = harness();
    const context: Context = {
      ...h.context,
      sessionManager: {
        ...h.context.sessionManager,
        getEntries: () =>
          explicit
            ? [
                {
                  type: "custom",
                  customType: "jp-project-scope",
                  data: { version: 1, workstream: "pi-setup" },
                },
              ]
            : [],
        getSessionName: () => "pi-setup",
      },
    };

    await assert.rejects(
      h.tools.get("task_create")!.execute(
        "create-call",
        {
          title: "Wrong project",
          why: "Regression",
          needs_jp: false,
          workstream: "another-project",
        },
        null,
        null,
        context,
      ),
      (error: Error) => {
        assert.match(error.message, /another-project/);
        assert.match(error.message, /pi-setup/);
        assert.match(error.message, /\/project/);
        return true;
      },
    );
    assert.deepEqual(h.calls, []);
  });
}

test("task_create reads the current scope on every call", async () => {
  const h = harness();
  const entries: unknown[] = [];
  const context: Context = {
    ...h.context,
    sessionManager: { ...h.context.sessionManager, getEntries: () => entries },
  };
  for (const scope of ["pi-setup", "another-project", null]) {
    entries.push({
      type: "custom",
      customType: "jp-project-scope",
      data: { version: 1, workstream: scope },
    });
    await h.tools
      .get("task_create")!
      .execute(
        "create-call",
        { title: "Scoped task", why: "Scope can change", needs_jp: false },
        null,
        null,
        context,
      );
  }
  assert.deepEqual(
    h.calls.map(({ args }) => (args[0] as { workstream?: string }).workstream),
    ["pi-setup", "another-project", undefined],
  );
});

test("task_create rejects malformed scope rather than treating it as global", async () => {
  const h = harness();
  const context: Context = {
    ...h.context,
    sessionManager: {
      ...h.context.sessionManager,
      getEntries: () => [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 2, workstream: "pi-setup" },
        },
      ],
    },
  };
  await assert.rejects(
    h.tools.get("task_create")!.execute(
      "create-call",
      {
        title: "Unknown scope",
        why: "Regression",
        needs_jp: false,
        workstream: "another-project",
      },
      null,
      null,
      context,
    ),
    /malformed.*\/project/,
  );
  assert.deepEqual(h.calls, []);
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
    repository: "repo",
    branch: "topic",
  };

  assert.deepEqual(
    await guard(
      { toolCallId: "acquire-call", toolName: "worktree_acquire", input },
      h.context,
    ),
    {
      block: true,
      reason:
        "worktree_acquire requires an Active task; claim a task before retrying",
    },
  );

  h.guardState.activeTasks = [activeIssue("jp-a")];
  assert.equal(
    await guard(
      { toolCallId: "acquire-call", toolName: "worktree_acquire", input },
      h.context,
    ),
    undefined,
  );
  assert.deepEqual(input, {
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
    toolName: "worktree_acquire",
    input: {
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
    toolName: "worktree_acquire",
    input: { repository: "repo", branch: "topic" },
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
          text: "unable to finalize worktree_acquire lifecycle state",
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
    repository: "repo",
    claimId: "claim-1",
  };

  assert.equal(
    await guard(
      { toolCallId: "release-call", toolName: "worktree_release", input },
      h.context,
    ),
    undefined,
  );
  assert.deepEqual(input, {
    repository: "repo",
    claimId: "claim-1",
  });
  assert.equal(
    await guard({ toolName: "worktree_list", input: {} }, h.context),
    undefined,
  );
  assert.equal(
    await guard({ toolName: "worktree_repair", input: {} }, h.context),
    undefined,
  );

  const recovery = harness();
  assert.equal(
    await recovery.handlers.get("tool_call")![0](
      {
        toolName: "worktree_release",
        input: { claimId: "unassociated" },
      },
      recovery.context,
    ),
    undefined,
  );
});

test("fails associated release closed for foreign, ambiguous, or unknown ownership", async () => {
  const release = {
    toolCallId: "release-call",
    toolName: "worktree_release",
    input: { repository: "repo", claimId: "claim-1" },
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
    toolName: "worktree_release",
    input: { repository: "repo", claimId: "claim-1" },
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
    toolName: "worktree_acquire",
    input: { repository: "repo", branch: "topic" },
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
    toolName: "worktree_release",
    input: { repository: "repo", claimId: "claim-1" },
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
        text: "worktree_release completed for claim claim-1, but task jp-a lifecycle finalization failed; reconcile the task before continuing",
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

test("shutdown events never relinquish task ownership or initiate cleanup", async () => {
  const h = harness();
  for (const reason of ["quit", "new", "resume", "fork", "reload"]) {
    for (const handler of h.handlers.get("session_shutdown") ?? [])
      await handler({ reason }, h.context);
  }
  assert.deepEqual(h.calls, []);
});

test("task result includes independent work management health without changing its phase", async () => {
  const h = harness();
  const unlinked = await h.tools
    .get("task_create")!
    .execute(
      "before",
      { title: "task", why: "why", needs_jp: false },
      undefined,
      undefined,
      h.context,
    );
  const result = normalizedIssue("actionable");
  result.metadata.piWorkManagement = newWorkManagementState(
    wmTarget,
    "task",
    "why",
  );
  h.service.create = async () => result;
  const linked = await h.tools
    .get("task_create")!
    .execute(
      "after",
      { title: "task", why: "why", needs_jp: false },
      undefined,
      undefined,
      h.context,
    );
  assert.equal(
    linked.content[0].text,
    unlinked.content[0].text + " · WM pending create",
  );
});

test("catalog creation requires explicit placement in every session state", async (t) => {
  const { A, P, catalogFixture } = await import(
    "../../lib/work-catalog/test-fixtures.js"
  );
  for (const [name, scope] of [
    ["project", { kind: "project", projectId: P }],
    ["area", { kind: "area", areaId: A }],
    ["global", { kind: "global" }],
    ["malformed", { kind: "invalid" }],
    ["display name only", undefined],
  ] as const) {
    await t.test(name, async () => {
      const h = harness({ readCatalog: async () => catalogFixture() });
      h.guardState.activeTasks = [activeIssue("owned")];
      h.guardState.activeTasks[0].metadata.piProject = {
        version: 1,
        projectId: P,
      };
      h.context.sessionManager.getSessionName = () => "api";
      h.context.sessionManager.getEntries = () =>
        scope === undefined
          ? []
          : [
              {
                type: "custom",
                customType: "jp-project-scope",
                data: { version: 2, scope },
              },
            ];
      await assert.rejects(
        h.tools
          .get("task_create")!
          .execute(
            "create",
            { title: "new task", why: "goal", needs_jp: false },
            undefined,
            undefined,
            h.context,
          ),
        /explicit project/i,
      );
      assert.equal(
        h.calls.length,
        0,
        "no creation or ownership lookup without placement",
      );
      assert.equal(h.execCalls.length, 0);
    });
  }
});

test("explicit placement is independent of browsing and current work", async (t) => {
  const { B, P, Q, catalogFixture } = await import(
    "../../lib/work-catalog/test-fixtures.js"
  );
  for (const scope of [
    { kind: "project", projectId: P },
    { kind: "area", areaId: B },
    { kind: "global" },
    { kind: "invalid" },
  ]) {
    await t.test(scope.kind, async () => {
      const h = harness({ readCatalog: async () => catalogFixture() });
      h.guardState.activeTasks = [activeIssue("owned")];
      h.guardState.activeTasks[0].metadata.piProject = {
        version: 1,
        projectId: P,
      };
      const ownedBefore = structuredClone(h.guardState.activeTasks);
      const entries = [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 2, scope },
        },
      ];
      h.context.sessionManager.getEntries = () => entries;
      h.context.sessionManager.getSessionName = () => "api-580c8e67";
      const sessionWrites: unknown[] = [];
      Object.assign(h.pi, {
        appendEntry: (...args: unknown[]) => sessionWrites.push(args),
        setSessionName: (name: string) => sessionWrites.push(name),
      });
      await h.tools
        .get("task_create")!
        .execute(
          "create",
          { title: "new task", why: "goal", projectId: Q, needs_jp: false },
          undefined,
          undefined,
          h.context,
        );
      assert.deepEqual(
        h.calls.map((c) => c.name),
        ["create"],
      );
      assert.deepEqual(h.calls[0].args[0], {
        title: "new task",
        why: "goal",
        projectId: Q,
        needsJp: false,
      });
      assert.deepEqual(h.guardState.activeTasks, ownedBefore);
      assert.deepEqual(sessionWrites, []);
      assert.equal(h.execCalls.length, 0);
    });
  }
});

test("explicit catalog creation never reads session display or scope", async () => {
  const { P, catalogFixture } = await import(
    "../../lib/work-catalog/test-fixtures.js"
  );
  const h = harness({ readCatalog: async () => catalogFixture() });
  h.context.sessionManager.getEntries = () => {
    throw new Error("scope must not determine placement");
  };
  h.context.sessionManager.getSessionName = () => {
    throw new Error("display name must not determine placement");
  };
  await h.tools
    .get("task_create")!
    .execute(
      "create",
      { title: "new task", why: "goal", workstream: "API", needs_jp: false },
      undefined,
      undefined,
      h.context,
    );
  assert.deepEqual(h.calls[0].args[0], {
    title: "new task",
    why: "goal",
    projectId: P,
    workstream: "API",
    needsJp: false,
  });
});

test("missing required catalog never falls back to legacy creation", async () => {
  const { P } = await import("../../lib/work-catalog/test-fixtures.js");
  for (const selection of [{ projectId: P }, { workstream: "API" }]) {
    const h = harness({ readCatalog: async () => null });
    h.context.sessionManager.getEntries = () => [
      {
        type: "custom",
        customType: "jp-project-scope",
        data: { version: 2, scope: { kind: "project", projectId: P } },
      },
    ];
    await assert.rejects(
      h.tools
        .get("task_create")!
        .execute(
          "create",
          { title: "new task", why: "goal", needs_jp: false, ...selection },
          undefined,
          undefined,
          h.context,
        ),
      /catalog|scope/i,
    );
    assert.equal(h.calls.length, 0);
  }
});

function claimedFacts(taskId = "jp-1"): SessionFactsResult {
  return {
    kind: "available",
    catalog: null,
    issues: [
      {
        id: taskId,
        title: "Lifecycle task",
        status: "in_progress",
        labels: [],
        lifecycle: legacyLifecycle(activeIssue(taskId).lifecycle),
        description: "Build and verify the agreed outcome",
        nextStep: "Verify abc123 in staging",
      },
    ],
  };
}

test("claim queues owned context independently of the caller retaining its result", async () => {
  const h = harness({ readSessionFacts: async () => claimedFacts() });
  await h.tools
    .get("task_claim")!
    .execute("claim", { taskId: "jp-1" }, null, null, h.context);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: false });
  assert.equal(h.sent[0].message.display, false);
  assert.match(
    h.sent[0].message.content,
    /Build and verify the agreed outcome/,
  );
});

test("context lookup failure does not turn a successful claim into a failed claim", async () => {
  const h = harness({
    readSessionFacts: async () => {
      throw new Error("private failure detail");
    },
  });
  const result = await h.tools
    .get("task_claim")!
    .execute("claim", { taskId: "jp-1" }, null, null, h.context);
  assert.match(result.content[0].text, /jp-1: active/);
  assert.equal(result.isError, undefined);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /unavailable/);
  assert.doesNotMatch(JSON.stringify(h.sent), /private failure detail/);
});

test("context enqueue failure leaves a visible successful-claim diagnostic", async () => {
  const h = harness({ readSessionFacts: async () => claimedFacts() });
  h.pi.sendMessage = () => {
    throw new Error("queue unavailable");
  };
  const result = await h.tools
    .get("task_claim")!
    .execute("claim", { taskId: "jp-1" }, null, null, h.context);
  assert.match(result.content[0].text, /jp-1: active/);
  assert.equal(result.isError, undefined);
  assert.match(
    JSON.stringify(result.content),
    /context.*unavailable|context.*could not/i,
  );
});

for (const interruption of [
  "abort",
  "session",
  "project",
  "away-and-back",
  "shutdown",
] as const) {
  test(`claim context is not delivered after ${interruption} during lookup`, async () => {
    let entered!: () => void;
    let resolve!: (value: SessionFactsResult) => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const lookup = new Promise<SessionFactsResult>((done) => {
      resolve = done;
    });
    let reads = 0;
    const h = harness({
      readSessionFacts: () => {
        entered();
        return ++reads === 1 ? lookup : Promise.resolve(claimedFacts());
      },
    });
    const controller = new AbortController();
    const pending = h.tools
      .get("task_claim")!
      .execute("claim", { taskId: "jp-1" }, controller.signal, null, h.context);
    await started;
    if (interruption === "abort") controller.abort();
    else if (interruption === "shutdown") {
      for (const handler of h.handlers.get("session_shutdown") ?? [])
        await handler({}, h.context);
    } else if (interruption === "project") {
      h.context.sessionManager.getEntries = () => [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 1, workstream: "different" },
        },
      ];
    } else {
      const changed = {
        ...h.context,
        sessionManager: {
          ...h.context.sessionManager,
          getSessionId: () => "different-session",
        },
      };
      for (const handler of h.handlers.get("session_start") ?? [])
        await handler({ reason: "resume" }, changed);
      if (interruption === "away-and-back") {
        for (const handler of h.handlers.get("session_start") ?? [])
          await handler({ reason: "resume" }, h.context);
      }
    }
    resolve(claimedFacts());
    await pending;
    assert.equal(h.sent.length, 0);
  });
}

test("post-claim context cannot substitute a different owned task", async () => {
  const h = harness({
    readSessionFacts: async () => claimedFacts("jp-different"),
  });
  await h.tools
    .get("task_claim")!
    .execute("claim", { taskId: "jp-1" }, null, null, h.context);
  assert.equal(h.sent.length, 1);
  assert.doesNotMatch(
    h.sent[0].message.content,
    /jp-different|Build and verify/,
  );
  assert.match(h.sent[0].message.content, /changed|unavailable/);
});

test("factory exposes operator-only review and injectable work-state health", async () => {
  let healthReads = 0;
  const h = harness({
    workStateHealth: async () => {
      healthReads += 1;
      throw new Error("Fixture daemon unavailable");
    },
  });
  assert.equal(h.commands.has("mission-check"), true);
  assert.equal(h.tools.has("mission-check"), false);
  for (const handler of h.handlers.get("before_agent_start") ?? [])
    await handler({ messageType: "user" }, h.context);
  assert.equal(healthReads, 1);
});

async function catalogIdentityHarness(lifecycleWriteVersion: 1 | 2 = 1) {
  const { P, Q, catalogFixture } = await import(
    "../../lib/work-catalog/test-fixtures.js"
  );
  const { resolveSessionWorkScope } = await import(
    "../../lib/session-project.js"
  );
  const catalog = catalogFixture();
  let catalogResult: typeof catalog | null = catalog;
  const h = harness({
    lifecycleWriteVersion,
    readCatalog: async () => catalogResult,
    workStateHealth: async () => ({
      state: "unavailable",
      reason: "fixture daemon",
    }),
  });
  let name = "before";
  const entries: any[] = [];
  const host = Object.assign(h.pi, {
    setSessionName(value: string) {
      name = value;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  });
  h.context.sessionManager.getEntries = () => entries;
  h.context.sessionManager.getSessionName = () => name;
  const row = (id = "jp-1", projectId = P) => ({
    id,
    title: "Owned task",
    status: "in_progress",
    labels: [],
    description: "The exact owned mission",
    metadata: {
      piProject: { version: 1, projectId },
      piLifecycle: activeIssue(id).lifecycle,
    },
  });
  let rows = [row()];
  let readRows = async () => rows;
  let reads = 0;
  host.exec = async (command, originalArgs) => {
    const args = command === "env" ? originalArgs.slice(2) : originalArgs;
    if (args[0] === "list") {
      reads++;
      const statuses = args.includes("--all")
        ? null
        : args[args.indexOf("-s") + 1].split(",");
      const listed = (await readRows()).filter(
        (row) => statuses === null || statuses.includes(row.status),
      );
      return { code: 0, stdout: JSON.stringify(listed), stderr: "" };
    }
    return { code: 0, stdout: "[]", stderr: "" };
  };
  const browse = (scope: unknown) =>
    host.appendEntry("jp-project-scope", { version: 2, scope });
  const scope = () =>
    resolveSessionWorkScope(h.context.sessionManager, catalog);
  const claim = () =>
    h.tools
      .get("task_claim")!
      .execute("claim", { taskId: "jp-1" }, null, null, h.context);
  const event = async (name: string, value: unknown = {}) => {
    const results: any[] = [];
    for (const handler of h.handlers.get(name) ?? [])
      results.push(await handler(value, h.context));
    return results;
  };
  browse({ kind: "project", projectId: Q });
  return {
    ...h,
    host,
    entries,
    P,
    Q,
    catalog,
    row,
    browse,
    scope,
    claim,
    event,
    reads: () => reads,
    setCatalog(value: typeof catalog | null) {
      catalogResult = value;
    },
    setRows(value: typeof rows) {
      rows = value;
    },
    setReader(value: typeof readRows) {
      readRows = value;
    },
  };
}

test("cross-project claim derives identity and queues its exact mission from one read", async () => {
  const h = await catalogIdentityHarness();
  await h.claim();
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.deepEqual(h.scope(), {
    kind: "resolved",
    scope: { kind: "project", projectId: h.P },
    source: "explicit",
  });
  assert.equal(h.reads(), 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /The exact owned mission/);
});

for (const conflict of ["deferred status", "non-active execution"] as const) {
  test(`decoded ${conflict} cannot clear identity or deliver a mission`, async () => {
    const h = await catalogIdentityHarness();
    await h.claim();
    h.browse({ kind: "project", projectId: h.Q });
    const row = h.row();
    if (conflict === "deferred status") row.status = "deferred";
    else row.metadata.piLifecycle!.phase = "actionable";
    h.setRows([row]);
    const projection = () =>
      h.entries.filter((entry) =>
        ["jp-project-scope", "jp-working-identity"].includes(entry.customType),
      );
    const before = structuredClone(projection());
    const result = await h.event("before_agent_start");
    assert.equal(h.context.sessionManager.getSessionName(), "before");
    assert.deepEqual(projection(), before);
    assert.match(JSON.stringify(result), /unavailable/i);
    assert.doesNotMatch(JSON.stringify(result), /The exact owned mission/);
    assert.equal(h.reads(), 3);
  });
}

test("deferred ownership facts do not broaden the model work overview", async () => {
  const h = await catalogIdentityHarness();
  await h.claim();
  const row = h.row();
  row.status = "deferred";
  row.metadata.piLifecycle!.phase = "deferred";
  legacyLifecycle(row.metadata.piLifecycle!).execution = null;
  h.setRows([row]);
  const result = await h.event("before_agent_start");
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.doesNotMatch(
    JSON.stringify(result),
    /Owned task|The exact owned mission/,
  );
  assert.equal(h.reads(), 3);
});

test("failed claim leaves identity and browsing untouched without a projection read", async () => {
  const h = await catalogIdentityHarness();
  h.service.claim = async () => {
    throw new Error("claim rejected");
  };
  const before = structuredClone(h.entries);
  await assert.rejects(h.claim(), /claim rejected/);
  assert.deepEqual(h.entries, before);
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.equal(h.reads(), 0);
});

test("navigation during claim lookup is preserved without suppressing its owned mission", async () => {
  const h = await catalogIdentityHarness();
  h.setReader(async () => {
    h.browse({ kind: "global" });
    return [h.row()];
  });
  await h.claim();
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.deepEqual(h.scope(), {
    kind: "resolved",
    scope: { kind: "global" },
    source: "explicit",
  });
  assert.match(h.sent[0]?.message.content ?? "", /The exact owned mission/);
  await h.event("before_agent_start");
  assert.equal(h.scope().kind, "resolved");
  assert.deepEqual(h.scope(), {
    kind: "resolved",
    scope: { kind: "global" },
    source: "explicit",
  });
});

test("malformed browsing cannot hide a valid owned mission or identity", async () => {
  const h = await catalogIdentityHarness();
  await h.claim();
  h.browse({ kind: "invalid" });
  const result = await h.event("before_agent_start");
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.match(JSON.stringify(result), /The exact owned mission/);
  assert.equal(h.scope().kind, "invalid");
});

test("a mismatched post-claim owner cannot project another task as confirmation", async () => {
  const h = await catalogIdentityHarness();
  h.setRows([h.row("jp-different", h.Q)]);
  const before = structuredClone(h.entries);
  const result = await h.claim();
  assert.match(result.content[0].text, /jp-1: active/);
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.deepEqual(h.entries, before);
  assert.doesNotMatch(
    JSON.stringify(h.sent),
    /The exact owned mission|jp-different/,
  );
  assert.match(JSON.stringify(h.sent), /changed|unavailable/);
});

for (const [toolName, method, params] of [
  ["task_wait", "waitOnExistingCondition", { taskId: "jp-1" }],
  ["task_defer", "defer", { taskId: "jp-1", reason: "pause" }],
  [
    "task_close",
    "close",
    { taskId: "jp-1", kind: "cancelled", reason: "stop" },
  ],
] as const) {
  test(`${toolName} resets identity after successful release, never after rejection`, async () => {
    const h = await catalogIdentityHarness();
    await h.claim();
    h.browse({ kind: "project", projectId: h.Q });
    const original = h.service[method];
    const before = structuredClone(h.entries);
    Object.assign(h.service, {
      [method]: async () => {
        throw new Error("release rejected");
      },
    });
    await assert.rejects(
      h.tools.get(toolName)!.execute("release", params, null, null, h.context),
      /release rejected/,
    );
    assert.deepEqual(h.entries, before);
    assert.equal(h.context.sessionManager.getSessionName(), "before");
    Object.assign(h.service, {
      [method]: async (...args: any[]) => {
        const result = await (original as any)(...args);
        h.setRows([]);
        return result;
      },
    });
    await h.tools
      .get(toolName)!
      .execute("release", params, null, null, h.context);
    assert.equal(h.context.sessionManager.getSessionName(), "before");
    assert.deepEqual(h.scope(), {
      kind: "resolved",
      scope: { kind: "global" },
      source: "explicit",
    });
    assert.equal(h.reads(), 2);
  });

  for (const [catalogState, navigate] of [
    ["absent", false],
    ["prepared", false],
    ["absent", true],
    ["prepared", true],
  ] as const) {
    test(`${toolName} warns after committed release with ${catalogState} required catalog (navigation: ${navigate})`, async () => {
      const h = await catalogIdentityHarness();
      await h.claim();
      const original = h.service[method];
      let committed = false;
      Object.assign(h.service, {
        [method]: async (...args: any[]) => {
          const result = await (original as any)(...args);
          committed = true;
          h.setRows([]);
          h.setCatalog(
            catalogState === "absent"
              ? null
              : { ...h.catalog, state: "prepared" },
          );
          if (navigate) h.browse({ kind: "project", projectId: h.Q });
          return result;
        },
      });
      const result = await h.tools
        .get(toolName)!
        .execute("release", params, null, null, h.context);
      assert.equal(committed, true);
      assert.equal(h.context.sessionManager.getSessionName(), "before");
      assert.deepEqual(h.scope(), {
        kind: "resolved",
        scope: { kind: "project", projectId: navigate ? h.Q : h.P },
        source: "explicit",
      });
      assert.match(
        JSON.stringify(result.content),
        /succeeded.*identity.*not.*rolled back/i,
      );
      assert.equal(h.reads(), 2);
    });
  }
}

test("genuine legacy release does not require a catalog projection", async () => {
  const h = harness({
    readSessionFacts: async () => ({
      kind: "available",
      issues: [],
      catalog: null,
    }),
  });
  const result = await h.tools
    .get("task_defer")!
    .execute(
      "release",
      { taskId: "jp-1", reason: "pause" },
      null,
      null,
      h.context,
    );
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /working identity could not/,
  );
});

test("normal snapshots recover external completion and preserve identity on read failure", async () => {
  const h = await catalogIdentityHarness();
  await h.claim();
  h.browse({ kind: "project", projectId: h.Q });
  h.setReader(async () => {
    throw new Error("read failed");
  });
  await h.event("before_agent_start");
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  h.setReader(async () => []);
  await h.event("before_agent_start");
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.deepEqual(h.scope(), {
    kind: "resolved",
    scope: { kind: "global" },
    source: "explicit",
  });
});

test("catalog fork seeds neutral identity before an unavailable recovery read", async () => {
  const h = await catalogIdentityHarness();
  await h.event("session_before_fork");
  h.entries.length = 0;
  h.context.sessionManager.getSessionId = () => "child-580c8e67";
  h.setReader(async () => {
    throw new Error("unavailable");
  });
  await h.event("session_start", { reason: "fork" });
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.deepEqual(h.scope(), {
    kind: "resolved",
    scope: { kind: "global" },
    source: "explicit",
  });
  assert.equal(
    h.calls.filter((c) => ["claim", "defer", "close"].includes(c.name)).length,
    0,
  );
});

test("authoritative recovery supersedes the fresh catalog-session seed", async () => {
  const h = await catalogIdentityHarness();
  await h.event("session_before_fork");
  h.context.sessionManager.getSessionId = () => "child-580c8e67";
  const owned = h.row();
  legacyLifecycle(owned.metadata.piLifecycle!).execution!.sessionId =
    "child-580c8e67";
  h.setRows([owned]);
  await h.event("session_start", { reason: "fork" });
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.deepEqual(h.scope(), {
    kind: "resolved",
    scope: { kind: "project", projectId: h.P },
    source: "explicit",
  });
});

test("fresh startup shares ownership facts while keeping browse discovery separate", async () => {
  const h = await catalogIdentityHarness();
  h.context.sessionManager.getBranch = () => h.entries;
  await h.event("session_start", { reason: "startup" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.equal(h.reads(), 2);
  assert.equal(
    h.entries.filter((entry) => entry.customType === "jp-work-startup").length,
    1,
  );
});

test("compaction retains the owned mission despite an invalid browse filter", async () => {
  const h = await catalogIdentityHarness();
  await h.claim();
  h.browse({ kind: "invalid" });
  h.sent.length = 0;
  await h.event("session_compact");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "jp-work-compact");
  assert.match(h.sent[0].message.content, /The exact owned mission/);
  assert.match(h.sent[0].message.content, /Unavailable/);
});

test("resume and already-started startup recover identity with one bounded facts read", async () => {
  for (const reason of ["resume", "startup", "fork", "new"]) {
    const h = await catalogIdentityHarness();
    await h.event("session_start", { reason });
    assert.equal(h.context.sessionManager.getSessionName(), "before", reason);
    assert.equal(h.reads(), 1, reason);
  }
});

test("post-commit marker failure preserves the claim and later browsing during recovery", async () => {
  const h = await catalogIdentityHarness();
  const append = h.host.appendEntry;
  h.host.appendEntry = (type, data) => {
    if (type === "jp-working-identity") throw new Error("marker failed");
    append(type, data);
  };
  const result = await h.claim();
  assert.equal(h.calls.filter((c) => c.name === "claim").length, 1);
  assert.equal(result.isError, undefined);
  assert.match(
    JSON.stringify(result.content),
    /succeeded.*identity|succeeded.*projection/i,
  );
  assert.match(JSON.stringify(h.sent), /The exact owned mission/);
  h.browse({ kind: "project", projectId: h.Q });
  h.host.appendEntry = append;
  await h.event("before_agent_start");
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.deepEqual(h.scope(), {
    kind: "resolved",
    scope: { kind: "project", projectId: h.Q },
    source: "explicit",
  });
});

test("a pre-claim observation cannot clear identity after the newer claim commits", async () => {
  const h = await catalogIdentityHarness();
  let entered!: () => void;
  let finish!: (rows: ReturnType<typeof h.row>[]) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<ReturnType<typeof h.row>[]>((resolve) => {
    finish = resolve;
  });
  let first = true;
  h.setReader(async () => {
    if (!first) return [h.row()];
    first = false;
    entered();
    return pending;
  });
  const old = h.event("before_agent_start");
  await started;
  await h.claim();
  finish([]);
  await old;
  assert.equal(h.context.sessionManager.getSessionName(), "before");
  assert.match(JSON.stringify(h.sent), /The exact owned mission/);
});

test("legacy claim context is suppressed when its required scope changes during lookup", async () => {
  let entered!: () => void;
  let resolve!: (value: SessionFactsResult) => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const pendingContext = new Promise<SessionFactsResult>((done) => {
    resolve = done;
  });
  const h = harness({
    readSessionFacts: () => {
      entered();
      return pendingContext;
    },
  });
  let scope: unknown = { kind: "global" };
  h.context.sessionManager.getEntries = () => [
    {
      type: "custom",
      customType: "jp-project-scope",
      data: { version: 2, scope },
    },
  ];
  const pending = h.tools
    .get("task_claim")!
    .execute("claim", { taskId: "jp-1" }, null, null, h.context);
  await started;
  scope = { kind: "area", areaId: "11111111-1111-4111-8111-111111111111" };
  resolve(claimedFacts());
  await pending;
  assert.equal(h.sent.length, 0);
});

test("catalog ownership projection publishes the existing display-refresh event", async () => {
  const h = await catalogIdentityHarness();
  const events: unknown[][] = [];
  Object.assign(h.pi, {
    events: { emit: (...args: unknown[]) => events.push(args) },
  });
  await h.claim();
  assert.deepEqual(events, [["pi:work-scope-changed", "session-1"]]);
  await h.event("before_agent_start");
  assert.equal(events.length, 1);
  assert.equal(h.context.sessionManager.getSessionName(), "before");
});

function retainedIssue(
  phase: "active" | "actionable" | "waiting" | "deferred" | "done",
) {
  const owner = { ...V2_OWNER, sessionId: "session-1" };
  const current = withCheck({ owner });
  const lifecycle =
    phase === "waiting"
      ? blockLifecycleV2(current, {
          operationId: "block",
          sessionId: owner.sessionId,
          now: V2_NOW,
          reason: "Await review",
          conditionFingerprint: fingerprintConditionV2(current, [])!,
        })
      : v2State({
          phase,
          owner,
          disposition:
            phase === "done"
              ? {
                  kind: "completed",
                  reason: "Delivered",
                  at: V2_NOW,
                  evidenceArtifactIds: [],
                }
              : null,
        });
  return { ...normalizedIssue(), lifecycle, status: nativeStatusV2(lifecycle) };
}

test("v2 exposes explicit transitions instead of the incompatible wait API", async () => {
  const h = harness({ lifecycleWriteVersion: 2 });
  assert.equal(h.tools.has("task_wait"), false);
  for (const name of ["task_block", "task_resume", "task_release"]) {
    const tool = h.tools.get(name)!;
    assert.ok(tool);
    const params = { taskId: "jp-1", reason: "Meaningful work boundary" };
    assert.throws(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call",
        name,
        arguments: { taskId: "jp-1" },
      }),
    );
    for (const field of ["phase", "lifecycle"])
      assert.throws(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "call",
          name,
          arguments: { ...params, [field]: "done" },
        }),
      );
    await tool.execute("call", params, undefined, undefined, h.context);
    const call = h.calls.find((c) => c.name === name.slice(5))!;
    assert.equal(call.args[0], "jp-1");
    assert.equal(call.args[3], "call");
  }
});

test("condition changes are exclusive and hydrate no user-supplied observations", async () => {
  const h = harness({ lifecycleWriteVersion: 2 });
  const tool = h.tools.get("task_update")!;
  const condition = {
    kind: "check",
    purpose: "completion",
    reason: "Require merge",
    check: {
      id: "merge",
      kind: "github_pull_request",
      targetArtifactIds: ["pr"],
      predicate: {},
      onSatisfied: "close",
      wakeOn: ["changes_requested"],
    },
  };
  for (const content of [
    { add_labels: [] },
    { description: "Mission" },
    { next_step: null },
  ]) {
    await assert.rejects(
      tool.execute(
        "change",
        { taskId: "jp-1", condition, ...content },
        undefined,
        undefined,
        h.context,
      ),
      /exclusive|combined/,
    );
  }
  assert.equal(h.calls.length, 0);
  assert.throws(() =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "x",
      name: tool.name,
      arguments: {
        taskId: "jp-1",
        condition: {
          ...condition,
          check: { ...condition.check, state: "satisfied" },
        },
      },
    }),
  );
  await tool.execute(
    "change",
    { taskId: "jp-1", condition },
    undefined,
    undefined,
    h.context,
  );
  const call = h.calls.find((c) => c.name === "updateCondition")!;
  assert.equal(call.args[3], "change");
  assert.deepEqual((call.args[1] as any).check, {
    ...condition.check,
    state: "pending",
    createdAt: new Date(NOW).toISOString(),
    lastCheckedAt: null,
    nextCheckAt: new Date(NOW).toISOString(),
    lastObservation: null,
    errorCount: 0,
  });
});

for (const phase of ["actionable", "waiting", "deferred", "done"] as const) {
  test(`v2 ${phase} ownership blocks a second claim and delegated execution but permits explicit owner transitions`, async () => {
    const h = harness({ lifecycleWriteVersion: 2 });
    h.guardState.activeTasks = [retainedIssue(phase)];
    const guard = h.handlers.get("tool_call")![0];
    assert.equal(
      (
        (await guard(
          { toolName: "task_claim", input: { taskId: "jp-other" } },
          h.context,
        )) as any
      )?.block,
      true,
    );
    assert.equal(
      (
        (await guard(
          { toolName: "subagent", input: { agent: "worker", task: "Work" } },
          h.context,
        )) as any
      )?.block,
      true,
    );
    assert.equal(
      (
        (await guard(
          { toolName: "worktree_acquire", input: {} },
          h.context,
        )) as any
      )?.block,
      true,
    );
    assert.equal(
      await guard(
        { toolName: "task_claim", input: { taskId: "jp-1" } },
        h.context,
      ),
      undefined,
    );
    for (const toolName of [
      "task_resume",
      "task_release",
      "task_reopen",
      "task_close",
    ])
      assert.equal(
        await guard({ toolName, input: { taskId: "jp-1" } }, h.context),
        undefined,
      );
    assert.equal(
      (
        (await guard(
          { toolName: "task_release", input: { taskId: "jp-other" } },
          h.context,
        )) as any
      )?.block,
      true,
    );
  });
}

test("v2 cleanup uses ownership rather than current execution", async () => {
  const h = harness({ lifecycleWriteVersion: 2 });
  const issue = retainedIssue("waiting");
  h.guardState.activeTasks = [issue];
  h.guardState.associatedTasks = [issue];
  const result = await h.handlers.get("tool_call")![0](
    {
      toolName: "worktree_release",
      toolCallId: "cleanup",
      input: { repository: "repo", claimId: "claim" },
    },
    h.context,
  );
  assert.equal(result, undefined);
  assert.ok(h.calls.some((c) => c.name === "prepareWorktreeRelease"));
});

for (const action of ["claim", "release"] as const) {
  test(`uncertain v2 ${action} refreshes committed facts without reporting success`, async () => {
    const h = await catalogIdentityHarness(2);
    const row = h.row();
    row.metadata.piLifecycle = retainedIssue("active").lifecycle;
    h.setRows([row]);
    if (action === "release") {
      await h.claim();
      h.setRows([]);
    }
    const before = h.reads();
    h.service[action] = async () => {
      throw new Error("result unknown");
    };
    const tool = h.tools.get(`task_${action}`)!;
    assert.ok(tool);
    await assert.rejects(
      tool.execute(
        "unknown",
        { taskId: "jp-1", reason: "Switch" },
        null,
        null,
        h.context,
      ),
      /result unknown/,
    );
    assert.equal(h.reads(), before + 1);
    const marker = h.entries
      .filter((e) => e.customType === "jp-working-identity")
      .at(-1);
    assert.ok(marker);
    assert.equal(JSON.stringify(marker).includes("jp-1"), action === "claim");
  });
}

test("v2 release replay reaches authoritative history after ownership was already cleared", async () => {
  const h = harness({ lifecycleWriteVersion: 2 });
  const result = await h.handlers.get("tool_call")![0](
    {
      toolName: "task_release",
      input: {
        taskId: "jp-1",
        reason: "Switch",
        operationId: "already-released",
      },
    },
    h.context,
  );
  assert.equal(result, undefined);
});

test("owned paused execution refusal directs explicit continuation rather than another claim", async () => {
  const h = harness({ lifecycleWriteVersion: 2 });
  h.guardState.activeTasks = [retainedIssue("waiting")];
  const result = (await h.handlers.get("tool_call")![0](
    { toolName: "worktree_acquire", input: {} },
    h.context,
  )) as any;
  assert.match(result.reason, /task_resume/);
});

for (const mode of [1, 2] as const) {
  test(`writer mode ${mode} cannot delegate execution using a task from the other schema`, async () => {
    const h = harness({ lifecycleWriteVersion: mode });
    h.guardState.activeTasks = [
      mode === 2 ? activeIssue("jp-1") : retainedIssue("active"),
    ];
    const result = (await h.handlers.get("tool_call")![0](
      { toolName: "subagent", input: { agent: "worker", task: "Work" } },
      h.context,
    )) as any;
    assert.equal(result?.block, true);
    assert.match(result.reason, /version|incompatible/);
  });
}

test("v2 close retains the working identity until an explicit committed release", async () => {
  const h = await catalogIdentityHarness(2);
  const row = h.row();
  const done = retainedIssue("done");
  row.status = done.status;
  row.metadata.piLifecycle = done.lifecycle;
  h.setRows([row]);
  h.service.close = async () => done;
  await h.tools
    .get("task_close")!
    .execute(
      "close",
      { taskId: "jp-1", kind: "completed", reason: "Delivered" },
      null,
      null,
      h.context,
    );
  const marker = () =>
    h.entries.filter((e) => e.customType === "jp-working-identity").at(-1);
  assert.ok(JSON.stringify(marker()).includes("jp-1"));
  const released = { ...done, lifecycle: { ...done.lifecycle, owner: null } };
  h.service.release = async () => {
    row.metadata.piLifecycle = released.lifecycle;
    h.setRows([row]);
    return released;
  };
  await h.tools
    .get("task_release")!
    .execute(
      "release",
      { taskId: "jp-1", reason: "Switch work" },
      null,
      null,
      h.context,
    );
  assert.equal(JSON.stringify(marker()).includes("jp-1"), false);
});

test("v2 refuses an old pool boundary rather than falling back to result-only bookkeeping", async () => {
  const h = harness({ lifecycleWriteVersion: 2 });
  h.guardState.activeTasks = [retainedIssue("active")];
  const result = (await h.handlers.get("tool_call")![0](
    {
      toolName: "worktree_acquire",
      toolCallId: "acquire",
      input: { repository: "repo", branch: "jpriverar/branch" },
    },
    h.context,
  )) as any;
  assert.equal(result?.block, true);
  assert.match(result.reason, /boundary.*unavailable|incompatible/);
  assert.equal(
    h.calls.some(
      (call) =>
        call.name === "prepareWorktreeAcquire" ||
        call.name === "preflightWorktreeAcquire",
    ),
    false,
  );
});
