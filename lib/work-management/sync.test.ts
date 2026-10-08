import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { createLifecycleStore } from "../task-lifecycle/beads-store.js";
import { createActionableLifecycle } from "../task-lifecycle/model.js";
import { createWorkManagementSync } from "./sync.js";
import {
  decodeWorkManagement,
  newWorkManagementState,
  type WorkManagementState,
} from "./model.js";
import { target } from "./test-fixtures.js";
import {
  sendDatadogOperation,
  type DatadogOperationRequest,
  type DatadogOutcome,
} from "./datadog.js";

const now = Date.parse("2026-10-07T12:00:00Z");
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "wm-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lifecycle = createActionableLifecycle(new Date(now).toISOString());
  const raw = {
    id: "jp-test",
    title: "task",
    status: "open",
    metadata: {
      piLifecycle: lifecycle,
      keep: "untouched",
      piWorkManagement: newWorkManagementState(target, "task", "why"),
    },
    dependencies: [],
  };
  const comments: Array<{
    id: string;
    issue_id: string;
    text: string;
    created_at: string;
  }> = [];
  const store = createLifecycleStore(
    async (_, args) => {
      if (args[0] === "update")
        raw.metadata = JSON.parse(args[args.indexOf("--metadata") + 1]);
      return {
        code: 0,
        stdout: JSON.stringify(args[0] === "comments" ? comments : [raw]),
        stderr: "",
      };
    },
    { store: dir },
  );
  const calls: DatadogOperationRequest[] = [];
  let respond: (
    request: DatadogOperationRequest,
  ) => Promise<DatadogOutcome> = async (request) =>
    request.operation.kind === "create"
      ? {
          kind: "success",
          remote: {
            id: "case-1",
            url: "https://app.datadoghq.com/cases/case-1",
          },
        }
      : { kind: "success" };
  let clock = now;
  const deps = {
    store,
    owner: {
      pid: process.pid,
      host: hostname(),
      sessionId: "test",
      started: now,
    },
    now: () => clock,
    retryBaseMs: 1000,
    retryMaxMs: 60_000,
    readConfig: () => ({
      version: 1 as const,
      ddAuthPath: "/bin/dd-auth",
      curlPath: "/usr/bin/curl",
      workstreams: {},
    }),
    send: async (request: DatadogOperationRequest) => {
      calls.push(request);
      return respond(request);
    },
  };
  return {
    raw,
    store,
    comments,
    calls,
    deps,
    sync: createWorkManagementSync(deps),
    state: () => decodeWorkManagement(raw.metadata.piWorkManagement)!,
    respond: (fn: typeof respond) => {
      respond = fn;
    },
    clock: (value: number) => {
      clock = value;
    },
  };
}

test("completed before the first scan still creates then sends the terminal status", async (t) => {
  const h = await harness(t);
  h.raw.metadata.piLifecycle.phase = "done";
  h.raw.metadata.piLifecycle.disposition = {
    kind: "completed",
    reason: "done",
    at: new Date(now).toISOString(),
    evidenceArtifactIds: [],
  };
  h.raw.status = "closed";
  assert.deepEqual(await h.sync.candidates(), ["jp-test"]);
  assert.equal(await h.sync.step("jp-test"), "delivered");
  assert.equal(await h.sync.step("jp-test"), "delivered");
  assert.deepEqual(
    h.calls.map((c) => c.operation),
    [{ kind: "create" }, { kind: "status", statusName: "Done" }],
  );
  assert.equal(h.raw.metadata.keep, "untouched");
  assert.equal(h.raw.metadata.piLifecycle.phase, "done");
});

test("restart discovers ordered native logs and never replays confirmed IDs", async (t) => {
  const h = await harness(t);
  await h.sync.step("jp-test");
  for (const [id, text] of [
    ["c1", "same\n\n[pi-task-log:v1]"],
    ["c2", "unrelated"],
    ["c3", "same\n\n[pi-task-log:v1]"],
  ])
    h.comments.push({
      id,
      issue_id: "jp-test",
      text,
      created_at: new Date(now).toISOString(),
    });
  const restarted = createWorkManagementSync(h.deps);
  await restarted.step("jp-test");
  await restarted.step("jp-test");
  assert.equal(await createWorkManagementSync(h.deps).step("jp-test"), "idle");
  assert.deepEqual(h.state().deliveredCommentIds, ["c1", "c3"]);
  assert.deepEqual(
    h.calls.slice(1).map((c) => c.operation),
    [
      { kind: "comment", commentId: "c1" },
      { kind: "comment", commentId: "c3" },
    ],
  );
});

test("a concurrent lifecycle transition is not acknowledged by an older response", async (t) => {
  const h = await harness(t);
  await h.sync.step("jp-test");
  h.raw.metadata.piLifecycle.phase = "active";
  h.respond(async () => {
    h.raw.metadata.piLifecycle.phase = "deferred";
    h.raw.status = "deferred";
    return { kind: "success" };
  });
  await h.sync.step("jp-test");
  assert.equal(h.state().lastSentStatus, "In Progress");
  assert.equal(h.raw.metadata.piLifecycle.phase, "deferred");
  await h.sync.step("jp-test");
  assert.deepEqual(h.calls.at(-1)?.operation, {
    kind: "status",
    statusName: "Open",
  });
});

test("persisted in-flight and unknown comment outcomes stop all replay", async (t) => {
  const h = await harness(t);
  h.raw.metadata.piWorkManagement.inFlight = { kind: "create" };
  assert.equal(await h.sync.step("jp-test"), "attention");
  assert.equal(h.calls.length, 0);
  assert.equal(
    await createWorkManagementSync(h.deps).step("jp-test"),
    "attention",
  );
  h.raw.metadata.piWorkManagement = newWorkManagementState(
    target,
    "task",
    "why",
  );
  await h.sync.step("jp-test");
  h.comments.push({
    id: "c1",
    issue_id: "jp-test",
    text: "progress\n\n[pi-task-log:v1]",
    created_at: new Date(now).toISOString(),
  });
  h.respond(async () => ({ kind: "unknown", code: "timeout" }));
  assert.equal(await h.sync.step("jp-test"), "attention");
  h.raw.metadata.piLifecycle.phase = "active";
  assert.equal(await h.sync.step("jp-test"), "attention");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.state().inFlight, { kind: "comment", commentId: "c1" });
});

test("safe rejections back off and missing configuration requires attention", async (t) => {
  const h = await harness(t);
  h.respond(async () => ({
    kind: "retryable",
    code: "rate_limited",
    retryAfterMs: 10_000,
  }));
  assert.equal(await h.sync.step("jp-test"), "retry");
  assert.equal(h.state().inFlight, null);
  assert.deepEqual(await h.sync.candidates(), []);
  assert.equal(await h.sync.step("jp-test"), "idle");
  h.clock(now + 10_000);
  assert.deepEqual(await h.sync.candidates(), ["jp-test"]);
  const unconfigured = createWorkManagementSync({
    ...h.deps,
    readConfig: () => null,
  });
  assert.equal(await unconfigured.step("jp-test"), "attention");
  assert.equal(h.calls.length, 1);
});

test("remote success followed by a lost local receipt cannot create a second item", async (t) => {
  const h = await harness(t);
  const original = h.store.mutateWorkManagement;
  let writes = 0;
  h.store.mutateWorkManagement = async (...args) => {
    if (++writes === 2) throw new Error("crash before acknowledgment");
    return original(...args);
  };
  await assert.rejects(h.sync.step("jp-test"), /crash before acknowledgment/);
  assert.deepEqual(h.state().inFlight, { kind: "create" });
  assert.equal(h.calls.length, 1);
  h.store.mutateWorkManagement = original;
  assert.equal(
    await createWorkManagementSync(h.deps).step("jp-test"),
    "attention",
  );
  assert.equal(h.calls.length, 1);
});

test("reopening a task updates its existing item rather than creating another", async (t) => {
  const h = await harness(t);
  await h.sync.step("jp-test");
  h.raw.metadata.piLifecycle.phase = "done";
  h.raw.metadata.piLifecycle.disposition = {
    kind: "completed",
    reason: "done",
    at: new Date(now).toISOString(),
    evidenceArtifactIds: [],
  };
  await h.sync.step("jp-test");
  h.raw.metadata.piLifecycle.phase = "active";
  h.raw.metadata.piLifecycle.disposition = null;
  await h.sync.step("jp-test");
  assert.equal(h.calls.filter((c) => c.operation.kind === "create").length, 1);
  assert.equal(h.calls.at(-1)?.remoteId, "case-1");
  assert.deepEqual(h.calls.at(-1)?.operation, {
    kind: "status",
    statusName: "In Progress",
  });
});

test("login-needed work survives restart and retries after manual authentication", async (t) => {
  const h = await harness(t);
  let authenticated = false,
    writes = 0;
  h.respond((request) =>
    sendDatadogOperation(request, {
      ddAuthPath: "/test/dd-auth",
      curlPath: "/usr/bin/curl",
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 10000,
      run: async () => {
        if (!authenticated)
          return { code: 78, stdout: "", stderr: "login needed" };
        writes++;
        return {
          code: 0,
          stdout: JSON.stringify({ data: { id: "case-1" } }) + "\n201\n",
          stderr: "",
        };
      },
    }),
  );
  assert.equal(await h.sync.step("jp-test"), "retry");
  assert.equal(h.state().inFlight, null);
  assert.equal(h.state().failure?.code, "authentication_required");
  const restarted = createWorkManagementSync(h.deps);
  assert.equal(await restarted.step("jp-test"), "idle");
  assert.equal(writes, 0);
  authenticated = true;
  h.clock(now + 1000);
  assert.equal(await restarted.step("jp-test"), "delivered");
  assert.equal(writes, 1);
  assert.equal(h.state().remote?.id, "case-1");
  assert.equal(h.state().failure, null);
});
