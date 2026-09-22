import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ArtifactInput,
  LifecycleIssue,
  LockOwner,
} from "../../lib/task-lifecycle/types.js";
import type { GitArtifactObservationIntent } from "./git-artifact-command.js";
import {
  registerGitArtifactHooks,
  type GitArtifactHookService,
} from "./git-artifact-hooks.js";

function activeTask(id: string): LifecycleIssue {
  return {
    id,
    title: `task ${id}`,
    status: "in_progress",
    metadata: {},
    lifecycle: null,
    dependencies: [],
  };
}

function branch(task = "example"): ArtifactInput {
  return {
    id: `branch:${task}:refs/heads/topic`,
    kind: "branch",
    uri: `git://${task}/refs/heads/topic`,
    title: `${task} topic`,
    role: "evidence",
  };
}

function commit(task = "example"): ArtifactInput {
  const sha = "a".repeat(40);
  return {
    id: `commit:${task}:${sha}`,
    kind: "commit",
    uri: `git://${task}/commit/${sha}`,
    title: `${task} ${sha.slice(0, 12)}`,
    role: "evidence",
  };
}

type HookContext = {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, level: "warning"): void };
};
type Handler = (event: any, context: HookContext) => unknown;

function context(notifications: string[] = []): HookContext {
  return {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      notify(message: string, level: "warning") {
        assert.equal(level, "warning");
        notifications.push(message);
      },
    },
  };
}

function harness(
  options: {
    active?: LifecycleIssue[];
    intents?: GitArtifactObservationIntent[];
    artifacts?: ArtifactInput[];
    lookupError?: Error;
    observeError?: Error;
    recordError?: Error;
  } = {},
) {
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  const records: Array<{
    taskId: string;
    artifacts: readonly ArtifactInput[];
    owner: LockOwner;
    operationId: string;
  }> = [];
  const counters = { lookups: 0, observations: 0 };
  const service: GitArtifactHookService = {
    async activeTasksForSession() {
      counters.lookups += 1;
      if (options.lookupError !== undefined) throw options.lookupError;
      return options.active ?? [activeTask("jp-1")];
    },
    async recordObservedArtifacts(taskId, artifacts, owner, operationId) {
      if (options.recordError !== undefined) throw options.recordError;
      records.push({ taskId, artifacts, owner, operationId });
      return activeTask(taskId);
    },
  };
  const classifier = {
    classify() {
      return (
        options.intents ?? [
          {
            kind: "git-head" as const,
            operation: "commit" as const,
            cwd: "/repo",
            ref: "HEAD",
          },
        ]
      );
    },
  };
  const observer = {
    async observe() {
      counters.observations += 1;
      if (options.observeError !== undefined) throw options.observeError;
      return options.artifacts ?? [branch(), commit()];
    },
  };
  const pi = {
    on(event: "tool_call" | "tool_result", handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  registerGitArtifactHooks(pi, { service, classifier, observer });
  return {
    call: handlers.get("tool_call")![0],
    result: handlers.get("tool_result")![0],
    context: context(notifications),
    notifications,
    records,
    counters,
    options,
  };
}

test("captures the call-time task and records successful Bash artifacts once", async () => {
  const h = harness();
  const call = {
    toolName: "bash",
    toolCallId: "call-1",
    input: { command: "git commit -m ship" },
  };
  const originalCall = structuredClone(call);
  assert.equal(await h.call(call, h.context), undefined);
  assert.deepEqual(call, originalCall);

  const result = {
    toolName: "bash",
    toolCallId: "call-1",
    input: call.input,
    isError: false,
    content: [{ type: "text", text: "raw stdout" }],
  };
  const originalResult = structuredClone(result);
  assert.equal(await h.result(result, h.context), undefined);
  assert.deepEqual(result, originalResult);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].taskId, "jp-1");
  assert.deepEqual(h.records[0].artifacts, [branch(), commit()]);
  assert.equal(h.records[0].owner.sessionId, "session-1");
  assert.equal(h.records[0].operationId, "git-artifacts:call-1");

  assert.equal(await h.result(result, h.context), undefined);
  assert.equal(h.records.length, 1);
});

test("ignores calls that cannot produce a supported Bash artifact", async () => {
  const h = harness({ intents: [] });
  for (const event of [
    { toolName: "read", toolCallId: "read-1", input: { command: "secret" } },
    { toolName: "bash", toolCallId: "missing-1", input: {} },
    {
      toolName: "bash",
      toolCallId: "unclassified-1",
      input: { command: "git status" },
    },
  ]) {
    assert.equal(await h.call(event, h.context), undefined);
  }
  assert.equal(h.counters.lookups, 0);

  const noTask = harness({ active: [] });
  assert.equal(
    await noTask.call(
      {
        toolName: "bash",
        toolCallId: "no-task",
        input: { command: "git commit -m secret" },
      },
      noTask.context,
    ),
    undefined,
  );
  assert.deepEqual(noTask.notifications, []);
});

test("curates ambiguous ownership and lookup failures without blocking", async () => {
  for (const options of [
    { active: [activeTask("jp-secret-a"), activeTask("jp-secret-b")] },
    { lookupError: new Error("provider SECRET") },
  ]) {
    const h = harness(options);
    assert.equal(
      await h.call(
        {
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "git commit -m COMMAND-SECRET" },
        },
        h.context,
      ),
      undefined,
    );
    assert.deepEqual(h.notifications, [
      "Git artifact observation skipped; use task_attach_artifact if needed.",
    ]);
    assert.equal(h.notifications.join(" ").includes("SECRET"), false);
  }
});

test("skips failed Bash and clears the pending observation", async () => {
  const h = harness();
  const call = {
    toolName: "bash",
    toolCallId: "failed-1",
    input: { command: "git commit -m ship" },
  };
  await h.call(call, h.context);
  await h.result({ ...call, isError: true }, h.context);
  await h.result({ ...call, isError: false }, h.context);
  assert.equal(h.counters.observations, 0);
  assert.deepEqual(h.records, []);
});

test("curates observer and persistence failures and clears pending state", async () => {
  for (const options of [
    { observeError: new Error("observer SECRET") },
    { recordError: new Error("store SECRET") },
  ]) {
    const h = harness(options);
    const event = {
      toolName: "bash",
      toolCallId: "failure-1",
      input: { command: "git commit -m COMMAND-SECRET" },
    };
    await h.call(event, h.context);
    assert.equal(
      await h.result(
        {
          ...event,
          isError: false,
          stdout: "STDOUT-SECRET",
          stderr: "STDERR-SECRET",
        },
        h.context,
      ),
      undefined,
    );
    assert.deepEqual(h.notifications, [
      "Git artifact observation failed; use task_attach_artifact if needed.",
    ]);
    assert.equal(h.notifications.join(" ").includes("SECRET"), false);

    await h.result({ ...event, isError: false }, h.context);
    assert.equal(h.counters.observations, 1);
  }
});

test("keeps interleaved observations bound to their call-time tasks", async () => {
  const h = harness();
  h.options.active = [activeTask("jp-a")];
  await h.call(
    {
      toolName: "bash",
      toolCallId: "call-a",
      input: { command: "git commit -m a" },
    },
    h.context,
  );
  h.options.active = [activeTask("jp-b")];
  await h.call(
    {
      toolName: "bash",
      toolCallId: "call-b",
      input: { command: "git push origin topic" },
    },
    h.context,
  );

  await h.result(
    { toolName: "bash", toolCallId: "call-b", isError: false },
    h.context,
  );
  await h.result(
    { toolName: "bash", toolCallId: "call-a", isError: false },
    h.context,
  );
  assert.deepEqual(
    h.records.map(({ taskId, operationId }) => ({ taskId, operationId })),
    [
      { taskId: "jp-b", operationId: "git-artifacts:call-b" },
      { taskId: "jp-a", operationId: "git-artifacts:call-a" },
    ],
  );
});

test("ignores unmatched results, including results seen by a fresh registrar", async () => {
  const first = harness();
  await first.call(
    {
      toolName: "bash",
      toolCallId: "old-call",
      input: { command: "git commit -m ship" },
    },
    first.context,
  );
  const fresh = harness();
  assert.equal(
    await fresh.result(
      { toolName: "bash", toolCallId: "old-call", isError: false },
      fresh.context,
    ),
    undefined,
  );
  assert.deepEqual(fresh.records, []);
});
