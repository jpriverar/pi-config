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
    ["task_log", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    ["task_defer", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    ["task_update", { taskId: "jp-a" }, { kind: "none" }],
    [
      "task_update",
      { taskId: "jp-a", next_step: "Check the staging result" },
      { kind: "same-task", taskId: "jp-a" },
    ],
    [
      "task_update",
      { taskId: "jp-a", next_step: null },
      { kind: "same-task", taskId: "jp-a" },
    ],
    [
      "task_update",
      { taskId: "jp-a", description: "Keep validation in scope" },
      { kind: "same-task", taskId: "jp-a" },
    ],
    [
      "task_update",
      { taskId: "jp-a", add_labels: ["needs:jp"] },
      { kind: "none" },
    ],
    ["task_create", { title: "work" }, { kind: "none" }],
    ["task_close", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    [
      "task_attach_artifact",
      { taskId: "jp-a" },
      { kind: "same-task", taskId: "jp-a" },
    ],
    [
      "worktree_acquire",
      { repository: "repo", branch: "topic" },
      { kind: "active-task" },
    ],
    ["worktree_release", { claimId: "claim-1" }, { kind: "none" }],
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

test("v2 distinguishes resumed or steered execution from read-only subagent management", () => {
  for (const input of [
    { action: "resume", id: "child" },
    { action: "steer", id: "child", message: "Continue" },
    { action: "project.open", cwd: "/repo", message: "Implement the change" },
  ])
    assert.deepEqual(classifyTaskToolRequirement("subagent", input, 2), {
      kind: "active-task",
    });
  for (const action of [
    "status",
    "list",
    "models",
    "guide",
    "stop",
    "interrupt",
    "project.status",
    "project.close",
  ])
    assert.deepEqual(classifyTaskToolRequirement("subagent", { action }, 2), {
      kind: "none",
    });
  assert.deepEqual(
    classifyTaskToolRequirement("subagent", { action: "project.open" }, 2),
    { kind: "none" },
  );
});
