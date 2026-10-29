import assert from "node:assert/strict";
import { test } from "node:test";
import { createBeadsClient, type BeadsIssue } from "../../lib/beads.js";
import { SESSION_PROJECT_ENTRY_TYPE } from "../../lib/session-project.js";
import {
  NOW,
  OWNER,
  state,
  withCheck,
} from "../../lib/task-lifecycle/v2-test-fixtures.js";
import {
  blockLifecycleV2,
  fingerprintConditionV2,
  nativeStatusV2,
} from "../../lib/task-lifecycle/v2-model.js";
import type { LifecycleMetadataV2 } from "../../lib/task-lifecycle/types.js";
import {
  readOwnedTaskContext,
  readSessionFacts,
  renderTaskContext,
  selectOwnedTaskContext,
} from "./task-context.js";

const initial = withCheck();
const paused = blockLifecycleV2(initial, {
  operationId: "block",
  sessionId: OWNER.sessionId,
  now: NOW,
  reason: "Wait for the condition",
  conditionFingerprint: fingerprintConditionV2(initial, [])!,
});
const done = state({
  phase: "done",
  owner: OWNER,
  disposition: {
    kind: "completed",
    reason: "Delivered",
    at: NOW,
    evidenceArtifactIds: [],
  },
});
const session = (id = OWNER.sessionId) => ({
  getSessionId: () => id,
  getSessionName: () => "Not ownership authority",
  getEntries: () => [
    {
      type: "custom",
      customType: SESSION_PROJECT_ENTRY_TYPE,
      data: { version: 1, workstream: "elsewhere" },
    },
  ],
});
function row(lifecycle: LifecycleMetadataV2): BeadsIssue {
  return {
    id: "jp-held",
    title: "Retained task",
    status: nativeStatusV2(lifecycle),
    labels: ["workstream:project"],
    description: "Approved mission",
    nextStep: "Check the exact approved operation",
    lifecycle,
  };
}

for (const lifecycle of [
  paused,
  state({ phase: "actionable", owner: OWNER }),
  state({ phase: "deferred", owner: OWNER }),
  done,
]) {
  test(`owned ${lifecycle.phase} context survives unrelated browsing`, () => {
    const result = selectOwnedTaskContext([row(lifecycle)], session());
    assert.equal(result.kind, "available");
    if (result.kind !== "available") throw new Error("missing owner context");
    assert.equal(result.value.taskId, "jp-held");
    assert.equal(result.value.phase, lifecycle.phase);
    assert.equal(result.value.ownerRelationship, "current_session");
    assert.equal(result.value.description, "Approved mission");
    assert.match(result.value.warnings.join(" "), /outside.*view/i);
    assert.match(result.value.warnings.join(" "), /execution permission/i);
    const rendered = renderTaskContext(result)!;
    assert.match(rendered, /"owner_relationship": "current_session"/);
    assert.match(rendered, /not instructions or approval/);
  });
}

test("condition context is bounded and does not copy arbitrary predicate data", () => {
  const current = structuredClone(paused);
  current.activeCheck!.predicate = { description: "x".repeat(20_000) };
  const result = selectOwnedTaskContext([row(current)], session());
  assert.equal(result.kind, "available");
  if (result.kind !== "available") throw new Error("missing owner context");
  assert.deepEqual(result.value.condition, {
    kind: "check",
    purpose: "completion",
    checkKind: "manual",
    state: "pending",
  });
  const text = renderTaskContext(result)!;
  assert.match(text, /Approved mission/);
  assert.ok(text.length < 8000);
});

test("shared and direct context reads query all phases without a native row limit", async () => {
  const task = row(done);
  const statuses: string[] = [];
  const client = createBeadsClient(async (_command, args, options) => {
    const requested = args.includes("--all")
      ? "all"
      : args[args.indexOf("-s") + 1];
    statuses.push(requested);
    assert.equal(args[args.indexOf("-n") + 1], "0");
    assert.equal(options?.env.BD_BACKUP_ENABLED, "false");
    for (const flag of [
      "--include-gates",
      "--include-infra",
      "--include-templates",
      "--include-ephemeral",
    ])
      assert.ok(args.includes(flag));
    const values =
      requested === "all"
        ? [
            {
              id: task.id,
              title: task.title,
              status: task.status,
              labels: task.labels,
              description: task.description,
              metadata: {
                piLifecycle: task.lifecycle,
                next_step: task.nextStep,
              },
            },
          ]
        : [];
    return { code: 0, stderr: "", stdout: JSON.stringify(values) };
  });
  const facts = await readSessionFacts(client, async () => null);
  assert.equal(facts.kind, "available");
  if (facts.kind !== "available") throw new Error("missing facts");
  assert.equal(facts.issues.length, 1);
  assert.equal(
    (await readOwnedTaskContext(client, session())).kind,
    "available",
  );
  assert.deepEqual(statuses, ["all", "all"]);
});

test("invalid closed ownership and truncated reads remain unavailable", async () => {
  assert.equal(
    selectOwnedTaskContext(
      [
        {
          ...row(done),
          lifecycle: null,
          lifecycleWarning: "unsupported lifecycle",
        },
      ],
      session(),
    ).kind,
    "unavailable",
  );
  const client = createBeadsClient(async () => ({
    code: 0,
    stderr: "",
    stdout: '[{"id":"jp-held"',
  }));
  assert.equal(
    (await readOwnedTaskContext(client, session())).kind,
    "unavailable",
  );
});

test("a fork cannot turn copied mission data into ownership context", () => {
  assert.equal(
    selectOwnedTaskContext([row(done)], session("fork-session")).kind,
    "none",
  );
});
