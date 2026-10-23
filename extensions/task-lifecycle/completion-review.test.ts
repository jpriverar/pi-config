import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { registerCompletionReview } from "./completion-review.js";
import type { TaskContextResult } from "./task-context.js";

function harness(
  options: {
    version?: string;
    child?: boolean;
    useEnvironment?: boolean;
    read?: () => Promise<TaskContextResult>;
  } = {},
) {
  const handlers = new Map<string, (event: any, context: any) => any>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  let reads = 0;
  registerCompletionReview(
    {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
    },
    {
      runtimeVersion: options.version ?? "1.2.0",
      ...(options.useEnvironment
        ? {}
        : { isChild: () => options.child ?? false }),
      readContext: async () => {
        reads += 1;
        return options.read
          ? options.read()
          : { kind: "none", reason: "No task" };
      },
    },
  );
  const context = (id: string | undefined = "session-1") => ({
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionName: () => undefined,
      ...(id === undefined ? {} : { getSessionId: () => id }),
    },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
    hasPendingMessages: () => false,
    signal: new AbortController().signal,
  });
  const ctx = context();
  const emit = (name: string, event: unknown = {}, target = ctx) =>
    handlers.get(name)?.(event, target);
  const command = (args: string, target = ctx) =>
    commands.get("mission-check")?.handler(args, target);
  const start = (target = ctx, messageType = "user") =>
    emit("before_agent_start", { messageType }, target);
  const settle = (target = ctx, event = {}) =>
    emit(
      "agent_before_settle",
      {
        outcome: "completed",
        entries: [],
        continue: false,
        context: { pendingMessages: [], canContinue: false },
        ...event,
      },
      target,
    );
  return {
    ctx,
    context,
    emit,
    command,
    start,
    settle,
    notices,
    commands,
    reads: () => reads,
  };
}

test("review is off by default and does not read task data", async () => {
  const h = harness();
  h.start();
  assert.equal(await h.settle(), undefined);
  assert.equal(h.reads(), 0);
  await h.command("status");
  assert.match(h.notices.at(-1)!, /off/i);
});

test("operator enablement gives one unchanged cue per submitted run", async () => {
  const h = harness();
  await h.command("on");
  h.start();
  const first = await h.settle();
  assert.equal(first?.continue, true);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].display, false);
  assert.equal(
    createHash("sha256")
      .update(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: first.entries[0].content }],
        }),
      )
      .digest("hex"),
    "bfbcd100240c29f0436cc35d064b58f3de772cedae65f839ca25ed191e525d64",
  );
  assert.equal(await h.settle(), undefined);
  assert.equal(h.reads(), 1);
  h.start();
  assert.equal((await h.settle())?.continue, true);
  assert.equal(h.reads(), 2);
});

for (const version of ["0.84.1", "1.1.9", "unknown", "1.2", "1.2.0-beta.1"]) {
  test(`refuses enablement on unsupported runtime ${version}`, async () => {
    const h = harness({ version });
    await h.command("on");
    h.start();
    assert.equal(await h.settle(), undefined);
    assert.match(h.notices.at(-1)!, /1\.2\.0|unsupported/i);
  });
}

test("child sessions and missing trusted identity cannot enable review", async () => {
  const child = harness({ child: true });
  await child.command("on");
  child.start();
  assert.equal(await child.settle(), undefined);
  assert.match(child.notices.at(-1)!, /parent|child/i);
  const h = harness();
  const noIdentity = {
    ...h.ctx,
    sessionManager: { getEntries: () => [], getSessionName: () => undefined },
  };
  await h.command("on", noIdentity);
  assert.match(h.notices.at(-1)!, /identity/i);
});

test("session enablement is isolated and session start resets it", async () => {
  const h = harness();
  const other = h.context("session-2");
  await h.command("on");
  h.start();
  h.start(other);
  assert.equal(await h.settle(other), undefined);
  assert.equal((await h.settle())?.continue, true);
  h.emit("session_start", {}, h.ctx);
  h.start();
  assert.equal(await h.settle(), undefined);
});

test("off, on and bookkeeping cannot replenish the current run budget", async () => {
  const h = harness();
  await h.command("on");
  h.start();
  await h.settle();
  await h.command("off");
  await h.command("on");
  h.emit("tool_execution_end", { isError: false, result: {} });
  assert.equal(await h.settle(), undefined);
  assert.equal(h.reads(), 1);
});

test("an idle custom-message run does not acquire a submitted-run budget", async () => {
  const h = harness();
  await h.command("on");
  h.start(h.ctx, "custom");
  assert.equal(await h.settle(), undefined);
});

for (const tool of [
  { isError: true, result: {} },
  { isError: false, result: { terminate: true } },
]) {
  test(`does not revive a run after error=${tool.isError} termination=${!!tool.result.terminate}`, async () => {
    const h = harness();
    await h.command("on");
    h.start();
    h.emit("tool_execution_end", tool);
    assert.equal(await h.settle(), undefined);
    assert.equal(h.reads(), 0);
  });
}

for (const outcome of ["aborted", "error"]) {
  test(`does not continue an ${outcome} outcome`, async () => {
    const h = harness();
    await h.command("on");
    h.start();
    assert.equal(await h.settle(h.ctx, { outcome }), undefined);
    assert.equal(h.reads(), 0);
  });
}

test("fresh owned context is data before the unchanged automatic cue", async () => {
  const h = harness({
    read: async () => ({
      kind: "available",
      value: {
        taskId: "jp-fixture",
        description: "Finish the agreed validation",
        nextStep: "stale: stop now",
        warnings: [],
      },
    }),
  });
  await h.command("on");
  h.start();
  const result = await h.settle();
  assert.equal(result.entries.length, 2);
  assert.match(result.entries[0].content, /untrusted-task-context/);
  assert.match(result.entries[0].content, /stale: stop now/);
  assert.match(result.entries[1].content, /^Automatic completion review/);
});

test("unavailable context preserves conversation-based review", async () => {
  const h = harness({
    read: async () => {
      throw new Error("private transport detail");
    },
  });
  await h.command("on");
  h.start();
  const result = await h.settle();
  assert.equal(result?.continue, true);
  assert.match(JSON.stringify(result), /latest agreement/);
  assert.doesNotMatch(JSON.stringify(result), /private transport detail/);
});

for (const interruption of [
  "abort",
  "pending",
  "restart",
  "off-on",
  "shutdown",
  "new-run",
  "project",
] as const) {
  test(`lookup cannot continue after ${interruption}`, async () => {
    let resolve!: (result: TaskContextResult) => void;
    const h = harness({
      read: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await h.command("on");
    h.start();
    const pending = h.settle();
    assert.equal(h.reads(), 1);
    if (interruption === "abort") {
      const controller = new AbortController();
      h.ctx.signal = controller.signal;
      controller.abort();
    }
    if (interruption === "pending") h.ctx.hasPendingMessages = () => true;
    if (interruption === "project")
      h.ctx.sessionManager.getEntries = () => [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 1, workstream: "changed" },
        },
      ];
    if (interruption === "restart") h.emit("session_start");
    if (interruption === "shutdown") h.emit("session_shutdown");
    if (interruption === "new-run") h.start();
    if (interruption === "off-on") {
      await h.command("off");
      await h.command("on");
    }
    resolve({ kind: "none", reason: "No task" });
    assert.equal(await pending, undefined);
  });
}

test("preexisting queued work takes precedence without a context read", async () => {
  const h = harness();
  await h.command("on");
  h.start();
  assert.equal(
    await h.settle(h.ctx, { context: { pendingMessages: [{}] } }),
    undefined,
  );
  assert.equal(h.reads(), 0);
});

for (const [key, value] of [
  ["PI_SUBAGENT_CHILD", "1"],
  ["PI_SUBAGENT_DEPTH", "2"],
  ["PI_SUBAGENT_DEPTH", "unknown"],
]) {
  test(`inherited runtime marker ${key}=${value} cannot enable review`, async () => {
    const previous = process.env[key];
    try {
      process.env[key] = value;
      const h = harness({ useEnvironment: true });
      await h.command("on");
      h.start();
      assert.equal(await h.settle(), undefined);
      assert.match(h.notices.at(-1)!, /parent|child/);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
}

test("invalid operator arguments do not enable review", async () => {
  const h = harness();
  await h.command("enable from task metadata");
  h.start();
  assert.equal(await h.settle(), undefined);
  assert.match(h.notices.at(-1)!, /Usage/);
});
