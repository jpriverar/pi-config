import assert from "node:assert/strict";
import test from "node:test";
import { classifyReadiness, type BeadsIssue } from "../beads.js";
import { taskTableCells } from "../../extensions/shared/task-table.js";
import {
  selectTaskAssignment,
  taskTokens,
} from "../../extensions/project-status/herdr-values.js";
import { selectOwnedTaskContext } from "../../extensions/task-lifecycle/task-context.js";
import { blockLifecycleV2, fingerprintConditionV2 } from "./v2-model.js";
import {
  applyConditionObservationV2,
  prepareConditionObservationV2,
} from "./v2-reconciliation.js";
import {
  reconciliationOperationId,
  fingerprintCheck,
} from "./reconciliation.js";
import {
  withCheck,
  check,
  resource,
  issue,
  NOW,
  LATER,
  OWNER,
} from "./v2-test-fixtures.js";

function cleanupRequired(): BeadsIssue {
  const initial = withCheck({
    activeCheck: check({ onSatisfied: "close" }),
    resources: [resource()],
  });
  const blocked = blockLifecycleV2(initial, {
    operationId: "block",
    sessionId: OWNER.sessionId,
    now: NOW,
    reason: "Wait for delivery",
    conditionFingerprint: fingerprintConditionV2(initial, [])!,
  });
  const current = issue(blocked, "blocked");
  const prepared = prepareConditionObservationV2(
    current,
    reconciliationOperationId({
      taskId: current.id,
      requestId: "finish",
      manualOutcome: "satisfied",
      expectedCheckFingerprint: fingerprintCheck(current)!,
    }),
    "reconciler",
    "satisfied",
  );
  const result = applyConditionObservationV2(
    blocked,
    prepared,
    { outcome: "satisfied", observation: "Delivered" },
    LATER,
  );
  assert.equal(result.transition, "cleanup_required");
  return {
    id: "jp-test",
    title: "Owned work",
    status: "open",
    labels: [],
    lifecycle: result.state,
  };
}

test("successful checks with retained resources show persistent cleanup warnings", () => {
  const row = cleanupRequired();
  const [classified] = classifyReadiness([row], new Set([row.id]));
  assert.match(classified.warnings.join(" "), /cleanup required.*claim-1/i);
});

test("shared tables and Herdr show Ready with cleanup required rather than ordinary resume", () => {
  const row = cleanupRequired();
  const [classified] = classifyReadiness([row], new Set([row.id]));
  const theme: any = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  assert.match(
    taskTableCells(classified, theme).state.join(" "),
    /Ready.*cleanup required/i,
  );
  assert.match(
    taskTokens(selectTaskAssignment([row], OWNER.sessionId)).pi_task_status!,
    /Ready.*cleanup required/i,
  );
});

test("owned task context explains that successful delivery still needs cleanup", () => {
  const context = selectOwnedTaskContext([cleanupRequired()], {
    getSessionId: () => OWNER.sessionId,
    getEntries: () => [],
    getSessionName: () => undefined,
  });
  assert.equal(context.kind, "available");
  if (context.kind !== "available") throw new Error("missing context");
  assert.match(context.value.warnings.join(" "), /cleanup.*clos/i);
});

test("a satisfied continuation or fully released resources do not acquire a cleanup cue", () => {
  const row = cleanupRequired();
  row.lifecycle!.activeCheck!.onSatisfied = "actionable";
  assert.equal(
    taskTokens(selectTaskAssignment([row], OWNER.sessionId)).pi_task_status,
    "Ready to resume",
  );
  row.lifecycle!.activeCheck!.onSatisfied = "close";
  row.lifecycle!.resources[0].cleanupState = "released";
  row.lifecycle!.resources[0].releasedAt = LATER;
  assert.equal(
    taskTokens(selectTaskAssignment([row], OWNER.sessionId)).pi_task_status,
    "Ready to resume",
  );
});
