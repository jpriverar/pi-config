import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createLifecycleStore } from "./beads-store.js";
import { TaskLifecycleService } from "./service.js";
import { createTaskLifecycleExtension } from "../../extensions/task-lifecycle/index.js";
import type { LifecycleMetadataV1, LockOwner } from "./types.js";

const NOW = "2026-09-17T10:00:00.000Z";
const OWNER: LockOwner = {
  pid: process.pid,
  sessionId: "owner",
  host: "host",
  started: Date.parse(NOW),
};

function state(): LifecycleMetadataV1 {
  return {
    version: 1,
    phase: "active",
    waiting: null,
    stateEnteredAt: NOW,
    lastProgressAt: NOW,
    execution: {
      sessionId: "owner",
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
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-task-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cliCalls: Array<readonly string[]> = [];
  const record = {
    id: "jp-example",
    title: "Deliver the feature",
    description: "Build and validate the feature",
    status: "in_progress",
    metadata: {
      next_step: "Validate abc123",
      piLifecycle: state(),
      unrelated: { keep: ["all", "values"] },
    } as Record<string, unknown>,
  };
  const control = {
    ignoreWrites: false,
    alterStatus: false,
    alterMetadata: false,
    retainNextStep: false,
  };
  const store = createLifecycleStore(
    async (command, args, execution) => {
      assert.equal(command, "bd");
      assert.deepEqual(args.slice(-2), ["--db", join(directory, ".beads")]);
      cliCalls.push(args);
      if (args[0] === "show") {
        assert.equal(execution?.env.BD_BACKUP_ENABLED, "false");
      } else {
        assert.equal(args[0], "update");
        if (!control.ignoreWrites) {
          if (args.includes("--metadata"))
            record.metadata = JSON.parse(args[args.indexOf("--metadata") + 1]);
          if (args.includes("-d"))
            record.description = args[args.indexOf("-d") + 1];
          if (args.includes("-s")) record.status = args[args.indexOf("-s") + 1];
          if (control.alterStatus) record.status = "closed";
          if (control.alterMetadata) record.metadata.unrelated = { keep: [] };
          if (control.retainNextStep)
            record.metadata.next_step = "Validate abc123";
        }
      }
      return { code: 0, stdout: JSON.stringify([record]), stderr: "" };
    },
    { store: join(directory, ".beads") },
  );
  const service = new TaskLifecycleService({
    store,
    now: () => Date.parse(NOW),
    uuid: () => "operation",
    executionTimeoutMs: 60_000,
  });
  return { store, service, record, cliCalls, control };
}

test("unchanged content still checks ownership without writing", async (t) => {
  const f = await fixture(t);
  await f.service.updateTask(
    "jp-example",
    {
      addLabels: [],
      removeLabels: [],
      nextStep: "Validate abc123",
    },
    OWNER,
  );
  assert.deepEqual(
    f.cliCalls.map((args) => args[0]),
    ["show"],
  );
  await assert.rejects(
    f.service.updateTask(
      "jp-example",
      {
        addLabels: [],
        removeLabels: [],
        nextStep: "Validate abc123",
      },
      { ...OWNER, sessionId: "other" },
    ),
    /owned by active session owner/,
  );
  assert.equal(f.cliCalls.filter((args) => args[0] === "update").length, 0);
});

test("clearing next_step does not close the task or alter lifecycle evidence", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.record.metadata.piLifecycle);
  const saved = await f.service.updateTask(
    "jp-example",
    {
      addLabels: [],
      removeLabels: [],
      nextStep: null,
    },
    OWNER,
  );
  assert.equal(saved.metadata.next_step, null);
  assert.equal(saved.status, "in_progress");
  assert.deepEqual(saved.lifecycle, before);
  assert.deepEqual(saved.metadata.unrelated, { keep: ["all", "values"] });
});

test("description-only updates preserve the current next step", async (t) => {
  const f = await fixture(t);
  const saved = await f.service.updateTask(
    "jp-example",
    {
      addLabels: [],
      removeLabels: [],
      description: "Build, validate and report the feature",
    },
    OWNER,
  );
  assert.equal(saved.description, "Build, validate and report the feature");
  assert.equal(saved.metadata.next_step, "Validate abc123");
});

for (const input of [
  { nextStep: "Post the approved result" },
  { description: "Build, validate and report the feature" },
]) {
  const field = "nextStep" in input ? "next_step" : "description";
  test(`does not claim a successful ${field} update after a mismatched read-back`, async (t) => {
    const f = await fixture(t);
    f.control.ignoreWrites = true;
    await assert.rejects(
      f.service.updateTask(
        "jp-example",
        {
          addLabels: [],
          removeLabels: [],
          ...input,
        },
        OWNER,
      ),
      new RegExp(field),
    );
    assert.equal(f.cliCalls.filter((args) => args[0] === "update").length, 1);
  });
}

for (const field of ["status", "metadata"] as const) {
  test(`read-back rejects unexpected ${field} changes`, async (t) => {
    const f = await fixture(t);
    f.control.alterStatus = field === "status";
    f.control.alterMetadata = field === "metadata";
    await assert.rejects(
      f.service.updateTask(
        "jp-example",
        {
          addLabels: [],
          removeLabels: [],
          nextStep: "Report validated behavior",
        },
        OWNER,
      ),
      new RegExp(field),
    );
    assert.equal(f.cliCalls.filter((args) => args[0] === "update").length, 1);
  });
}

test("next-step clearing is verified after a lifecycle mutation", async (t) => {
  const f = await fixture(t);
  f.control.retainNextStep = true;
  await assert.rejects(
    f.service.close(
      "jp-example",
      {
        kind: "cancelled",
        reason: "Explicit cancellation",
        evidenceArtifactIds: [],
      },
      OWNER,
      "cancel",
    ),
    /next_step was not cleared/,
  );
  assert.equal(f.cliCalls.filter((args) => args[0] === "update").length, 1);
});

test("rejects an ownership change observed inside the native update", async (t) => {
  const f = await fixture(t);
  (f.record.metadata.piLifecycle as LifecycleMetadataV1).execution!.sessionId =
    "new-owner";
  await assert.rejects(
    f.service.updateTask(
      "jp-example",
      {
        addLabels: [],
        removeLabels: [],
        nextStep: null,
      },
      OWNER,
    ),
    /owned by active session new-owner/,
  );
  assert.deepEqual(
    f.cliCalls.map((args) => args[0]),
    ["show"],
  );
});

test("does not update content on a non-active task", async (t) => {
  const f = await fixture(t);
  const deferred = { ...state(), phase: "deferred" as const, execution: null };
  f.record.status = "deferred";
  f.record.metadata.piLifecycle = deferred;
  await assert.rejects(
    f.service.updateTask(
      "jp-example",
      {
        addLabels: [],
        removeLabels: [],
        description: "Changed goal",
      },
      OWNER,
    ),
    /not actively owned/,
  );
  assert.deepEqual(
    f.cliCalls.map((args) => args[0]),
    ["show"],
  );
});

for (const kind of ["completed", "cancelled", "superseded"] as const) {
  test(`clears an obsolete next_step when the task is ${kind}`, async (t) => {
    const f = await fixture(t);
    const done: LifecycleMetadataV1 = {
      ...state(),
      phase: "done",
      execution: null,
      disposition: {
        kind,
        reason: "Explicitly dispositioned",
        at: NOW,
        evidenceArtifactIds: [],
        ...(kind === "superseded" ? { supersedingTaskId: "jp-successor" } : {}),
      },
      transitionHistory: [
        {
          operationId: "close",
          type: "close",
          at: NOW,
          from: "active",
          to: "done",
        },
      ],
    };
    const saved = await f.store.mutate("jp-example", OWNER, () => ({
      operationId: "close",
      status: "closed",
      lifecycle: done,
    }));
    assert.equal(saved.metadata.next_step, null);
    assert.deepEqual(saved.metadata.unrelated, { keep: ["all", "values"] });
  });
}

test("reopening a done task does not revive its stale next step", async (t) => {
  const f = await fixture(t);
  f.record.status = "closed";
  f.record.metadata.piLifecycle = {
    ...state(),
    phase: "done",
    execution: null,
    disposition: {
      kind: "cancelled",
      reason: "Paused outcome",
      at: NOW,
      evidenceArtifactIds: [],
    },
  };
  const reopened: LifecycleMetadataV1 = {
    ...state(),
    phase: "actionable",
    execution: null,
    transitionHistory: [
      {
        operationId: "reopen",
        type: "reopen",
        at: NOW,
        from: "done",
        to: "actionable",
      },
    ],
  };
  const saved = await f.store.mutate("jp-example", OWNER, () => ({
    operationId: "reopen",
    status: "open",
    lifecycle: reopened,
  }));
  assert.equal(saved.metadata.next_step, null);
});

test("registered content tool enforces ownership without an outer tool_call hook", async (t) => {
  const f = await fixture(t);
  const tools = new Map<string, any>();
  createTaskLifecycleExtension({
    service: f.service,
    now: () => Date.parse(NOW),
    pid: OWNER.pid,
    hostname: OWNER.host,
    activityWriteIntervalMs: 300000,
    sessionReconcileLimit: 10,
    sessionPrCheckLimit: 5,
  })({
    on() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    exec: async () => {
      throw new Error("unexpected extension CLI call");
    },
    registerEntryRenderer() {},
    appendEntry() {},
    sendMessage() {},
  } as any);
  const context = {
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "foreign",
      getEntries: () => [],
      getBranch: () => [],
      getSessionName: () => undefined,
    },
  };
  const params = {
    taskId: "jp-example",
    next_step: "Post the approved result",
  };
  const update = tools.get("task_update")!;
  await assert.rejects(
    update.execute("foreign", params, null, null, context),
    /owned by active session owner/,
  );
  assert.equal(f.cliCalls.filter((args) => args[0] === "update").length, 0);

  context.sessionManager.getSessionId = () => OWNER.sessionId;
  await update.execute("owned", params, null, null, context);
  assert.equal(f.record.metadata.next_step, "Post the approved result");
});

for (const phase of ["deferred", "waiting", "active"] as const) {
  test(`preserves next_step across ${phase} transitions`, async (t) => {
    const f = await fixture(t);
    const target: LifecycleMetadataV1 = {
      ...state(),
      phase,
      waiting: phase === "waiting" ? { kind: "dependency" } : null,
      execution: phase === "active" ? state().execution : null,
      transitionHistory: [
        {
          operationId: "transition",
          type: "transition",
          at: NOW,
          from: "active",
          to: phase,
        },
      ],
    };
    const saved = await f.store.mutate("jp-example", OWNER, () => ({
      operationId: "transition",
      lifecycle: target,
      status:
        phase === "waiting"
          ? "blocked"
          : phase === "active"
            ? "in_progress"
            : "deferred",
    }));
    assert.equal(saved.metadata.next_step, "Validate abc123");
  });
}
