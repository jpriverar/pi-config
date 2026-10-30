import assert from "node:assert/strict";
import { test } from "node:test";
import { createBeadsClient, type BeadsIssue } from "./beads.js";
import {
  resolveOwnedTask,
  resolveWorkingIdentity,
} from "./session-identity.js";
import { P, Q, catalogFixture } from "./work-catalog/test-fixtures.js";
import {
  blockLifecycleV2,
  fingerprintConditionV2,
  nativeStatusV2,
} from "./task-lifecycle/v2-model.js";
import {
  NOW,
  OWNER,
  state,
  withCheck,
} from "./task-lifecycle/v2-test-fixtures.js";
import type { LifecycleMetadataV2 } from "./task-lifecycle/types.js";

const pending = withCheck();
const paused = blockLifecycleV2(pending, {
  operationId: "pause",
  sessionId: OWNER.sessionId,
  now: NOW,
  reason: "Wait for the condition",
  conditionFingerprint: fingerprintConditionV2(pending, [])!,
});
const phases: LifecycleMetadataV2[] = [
  state({ phase: "active", owner: OWNER }),
  state({ phase: "actionable", owner: OWNER }),
  paused,
  state({ phase: "deferred", owner: OWNER }),
  state({
    phase: "done",
    owner: OWNER,
    disposition: {
      kind: "completed",
      reason: "Delivered",
      at: NOW,
      evidenceArtifactIds: [],
    },
  }),
];
function owned(
  lifecycle: LifecycleMetadataV2,
  id = "jp-owned",
  projectId = P,
): BeadsIssue {
  return {
    id,
    title: "Owned task",
    status: nativeStatusV2(lifecycle),
    labels: [],
    projectReference: { kind: "valid", projectId },
    lifecycle,
  };
}

for (const lifecycle of phases) {
  test(`v2 ${lifecycle.phase} ownership survives a fresh identity lookup`, () => {
    const row = owned(lifecycle);
    const before = structuredClone(row);
    for (let lookup = 0; lookup < 2; lookup++) {
      const result = resolveWorkingIdentity(
        [row],
        catalogFixture(),
        OWNER.sessionId,
      );
      assert.equal(result.kind, "assigned");
      if (result.kind !== "assigned") throw new Error("missing owner identity");
      assert.equal(result.taskId, row.id);
      assert.equal(result.projectId, P);
    }
    assert.deepEqual(row, before);
  });
}

test("a retained terminal owner participates in cross-phase uniqueness", () => {
  const result = resolveOwnedTask(
    [owned(phases[0]), owned(phases[4], "jp-done", Q)],
    OWNER.sessionId,
  );
  assert.equal(result.kind, "ambiguous");
});

test("closed malformed or unsupported records cannot become inferred unassigned", () => {
  for (const warning of [
    "malformed owner",
    "unsupported piLifecycle version 99",
  ]) {
    const row: BeadsIssue = {
      ...owned(phases[4]),
      lifecycle: null,
      lifecycleWarning: warning,
    };
    assert.equal(resolveOwnedTask([row], OWNER.sessionId).kind, "unavailable");
  }
});

test("owned v2 phases with contradictory native status remain unavailable", () => {
  for (const lifecycle of phases) {
    const row = owned(lifecycle);
    row.status = row.status === "closed" ? "open" : "closed";
    assert.equal(resolveOwnedTask([row], OWNER.sessionId).kind, "unavailable");
  }
});

test("new fork or clone session IDs do not inherit retained ownership", () => {
  for (const lifecycle of phases)
    assert.equal(
      resolveOwnedTask([owned(lifecycle)], "new-session").kind,
      "unassigned",
    );
});

test("explicitly unowned and legacy closed rows remain unassigned", () => {
  const unowned = owned({ ...phases[4], owner: null });
  assert.equal(resolveOwnedTask([unowned], OWNER.sessionId).kind, "unassigned");
  const legacy: BeadsIssue = {
    id: "jp-legacy",
    title: "Legacy",
    status: "closed",
    labels: [],
  };
  assert.equal(resolveOwnedTask([legacy], OWNER.sessionId).kind, "unassigned");
});

test("the shared Beads reader retains v2 owner data without fabricating an execution lease", async () => {
  const row = owned(phases[4]);
  const client = createBeadsClient(async (_command, args, options) => {
    assert.equal(args[0], "list");
    assert.equal(args[args.indexOf("-n") + 1], "0");
    assert.equal(options?.env.BD_BACKUP_ENABLED, "false");
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify([
        {
          id: row.id,
          title: row.title,
          status: row.status,
          metadata: { piLifecycle: row.lifecycle },
          labels: row.labels,
        },
      ]),
    };
  });
  const result = await client.listIssues(["closed"]);
  assert.equal(result.ok, true);
  const lifecycle = result.value[0].lifecycle;
  assert.equal(lifecycle?.version, 2);
  if (lifecycle?.version !== 2) throw new Error("missing v2 data");
  assert.deepEqual(lifecycle.owner, OWNER);
  assert.equal(Object.hasOwn(lifecycle, "execution"), false);
  assert.equal(result.value[0].lifecycleWarning, undefined);
});
