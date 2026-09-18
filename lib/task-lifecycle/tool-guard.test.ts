import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyTaskToolRequirement } from "./tool-guard.js";

test("classifies task-scoped tool requirements", () => {
  const cases: Array<[string, unknown, unknown]> = [
    [
      "subagent",
      { agent: "worker", task: "implement" },
      { kind: "active-task" },
    ],
    ["subagent", { workflow: "review", args: {} }, { kind: "active-task" }],
    ["subagent", { action: "list" }, { kind: "none" }],
    ["task_claim", { taskId: "jp-a" }, { kind: "claim-task", taskId: "jp-a" }],
    ["task_wait", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    ["task_close", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    [
      "task_attach_artifact",
      { taskId: "jp-a" },
      { kind: "same-task", taskId: "jp-a" },
    ],
    [
      "task_worktree_acquire",
      { taskId: "jp-a" },
      { kind: "same-task", taskId: "jp-a" },
    ],
    [
      "task_worktree_release",
      { taskId: "jp-a" },
      { kind: "same-task", taskId: "jp-a" },
    ],
    ["task_reopen", { taskId: "jp-a" }, { kind: "none" }],
    ["task_reconcile", { taskId: "jp-a" }, { kind: "none" }],
    ["bash", { command: "git status" }, { kind: "none" }],
    ["unknown", { taskId: "jp-a" }, { kind: "none" }],
  ];

  for (const [toolName, input, expected] of cases) {
    assert.deepEqual(classifyTaskToolRequirement(toolName, input), expected);
  }
});

test("leaves malformed task inputs to their tool schemas", () => {
  assert.deepEqual(classifyTaskToolRequirement("task_wait", {}), {
    kind: "none",
  });
  assert.deepEqual(classifyTaskToolRequirement("task_claim", { taskId: "" }), {
    kind: "none",
  });
  assert.deepEqual(classifyTaskToolRequirement("task_close", null), {
    kind: "none",
  });
});
