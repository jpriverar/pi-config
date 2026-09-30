import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWorktreeRepairTools } from "./repair-tools.js";

function harness() {
  const tools = new Map<string, any>();
  const calls: string[] = [];
  const actor = {
    pid: 123,
    sessionId: "repairer",
    host: "host",
    started: 1000,
  };
  const plan = {
    version: 1 as const,
    taskId: "jp-target",
    repository: "repo",
    originalSessionId: "original-owner",
    fingerprint: "a".repeat(64),
    claims: [
      {
        claimId: "123e4567-e89b-42d3-a456-426614174000",
        path: "/repo/worktree",
        branch: "topic",
        head: "1".repeat(40),
        owner: { ...actor, sessionId: "original-owner" },
        poolState: "removing",
        nativeLock: "absent",
        taskState: "release_pending",
        action: "cancel_release",
      },
    ],
  };
  const service = {
    async preview() {
      calls.push("preview");
      return plan;
    },
    async apply(
      _taskId: string,
      _claimIds: string[],
      _fingerprint: string,
      owner: unknown,
    ) {
      calls.push("apply");
      assert.deepEqual(owner, actor);
      return {
        taskId: "jp-target",
        repairedClaimIds: [plan.claims[0].claimId],
      };
    },
  };
  registerWorktreeRepairTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool) },
    { service: service as any, ownerFor: () => actor },
  );
  const context = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => actor.sessionId },
    ui: {
      confirm: async (_title: string, message: string) => {
        calls.push("confirm");
        for (const value of [
          "jp-target",
          "original-owner",
          "/repo/worktree",
          "topic",
          plan.fingerprint,
        ])
          assert.ok(message.includes(value));
        return true;
      },
    },
  };
  const params = {
    taskId: "jp-target",
    claimIds: [plan.claims[0].claimId],
    expectedFingerprint: plan.fingerprint,
  };
  return { tools, calls, service, plan, context, params };
}

test("repair preview is available without UI and never asks for confirmation or applies", async () => {
  const h = harness();
  const result = await h.tools
    .get("task_worktree_repair_preview")
    .execute(
      "preview",
      { taskId: h.params.taskId, claimIds: h.params.claimIds },
      undefined,
      undefined,
      { ...h.context, mode: "print", hasUI: false },
    );
  assert.equal(result.details.fingerprint, h.plan.fingerprint);
  assert.deepEqual(h.calls, ["preview"]);
});

test("repair apply obtains native confirmation for the fingerprint-bound plan before applying", async () => {
  const h = harness();
  await h.tools
    .get("task_worktree_repair_apply")
    .execute("apply", h.params, undefined, undefined, h.context);
  assert.deepEqual(h.calls, ["preview", "confirm", "apply"]);
  const schema = h.tools.get("task_worktree_repair_apply").parameters;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "taskId",
    "claimIds",
    "expectedFingerprint",
  ]);
  assert.equal("confirmed" in schema.properties, false);
});

test("operator denial cannot be overridden by a model-supplied confirmation flag", async () => {
  const h = harness();
  h.context.ui.confirm = async () => {
    h.calls.push("denied");
    return false;
  };
  await assert.rejects(
    h.tools
      .get("task_worktree_repair_apply")
      .execute(
        "apply",
        { ...h.params, confirmed: true },
        undefined,
        undefined,
        h.context,
      ),
    /declined|denied/i,
  );
  assert.deepEqual(h.calls, ["preview", "denied"]);
});

for (const mode of ["rpc", "print", "json", undefined]) {
  test(`repair apply rejects non-terminal mode ${mode}`, async () => {
    const h = harness();
    await assert.rejects(
      h.tools
        .get("task_worktree_repair_apply")
        .execute("apply", h.params, undefined, undefined, {
          ...h.context,
          mode,
        }),
      /terminal|TUI/i,
    );
    assert.deepEqual(h.calls, []);
  });
}

test("stale repair binding is rejected before confirmation", async () => {
  const h = harness();
  await assert.rejects(
    h.tools
      .get("task_worktree_repair_apply")
      .execute(
        "apply",
        { ...h.params, expectedFingerprint: "b".repeat(64) },
        undefined,
        undefined,
        h.context,
      ),
    /stale|changed/i,
  );
  assert.deepEqual(h.calls, ["preview"]);
});

test("cancellation during confirmation prevents apply", async () => {
  const h = harness();
  const abort = new AbortController();
  h.context.ui.confirm = async () => {
    h.calls.push("confirm");
    abort.abort();
    return true;
  };
  await assert.rejects(
    h.tools
      .get("task_worktree_repair_apply")
      .execute("apply", h.params, abort.signal, undefined, h.context),
    /abort|cancel/i,
  );
  assert.deepEqual(h.calls, ["preview", "confirm"]);
});

test("unexpected inspection errors do not expose private store output", async () => {
  const h = harness();
  h.service.preview = async () => {
    throw new Error("private fixture credential output");
  };
  await assert.rejects(
    h.tools
      .get("task_worktree_repair_preview")
      .execute("preview", h.params, undefined, undefined, h.context),
    (error: Error) => {
      assert.doesNotMatch(error.message, /private fixture|credential/);
      return /inspect|preview/i.test(error.message);
    },
  );
});
