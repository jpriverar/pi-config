# Task-Scoped Tool Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require selected Pi tool operations to run only when the current Pi session owns the appropriate Active lifecycle task.

**Architecture:** Add a pure tool-requirement classifier under `lib/task-lifecycle`, expose authoritative Active-task lookup from `TaskLifecycleService`, and extend the existing lifecycle extension's `tool_call` hook to enforce the classifier. Beads lifecycle metadata remains the only attachment authority; no session binding state, result adapters, or subagent propagation is added.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi 0.84.1 extension events, `tsx --test`, Beads 1.1.2 with Dolt.

**Spec:** `../specs/2026-09-18-task-scoped-tool-guards-design.md`

## Global Constraints

- Implement only task-scoped admission control; do not add result adapters, automatic artifact attachment, subagent inheritance, or generic Bash interpretation.
- Beads lifecycle metadata remains authoritative. Do not add a binding ID, session custom entry, metadata version, or event ledger.
- Unknown tools and unrecognized input shapes remain unprotected.
- Unprotected tools must not read Beads merely to determine attachment.
- Protected calls fail closed when attachment cannot be verified, without exposing raw task content, stdout, or stderr.
- Preserve the existing raw `worktree_pool` acquisition and associated-release guards.
- Keep the worktree pool task-agnostic and do not change its public schema.
- Use the existing Pi session ID as execution ownership; add no new identifiers.
- No production behavior is written before its focused test fails for the expected missing behavior.
- Run implementation directly unless the operator explicitly authorizes delegation.
- Commit subjects remain under 50 characters.
- Before every commit, run `git diff --cached --name-only` and confirm only intended files are staged.

---

## File structure

- Create `lib/task-lifecycle/tool-guard.ts`: pure classification of known tool names and structured arguments.
- Create `lib/task-lifecycle/tool-guard.test.ts`: table-driven classifier coverage.
- Modify `lib/task-lifecycle/service.ts`: return Active lifecycle tasks owned by a session.
- Modify `lib/task-lifecycle/service.test.ts`: authoritative ownership lookup tests.
- Modify `extensions/task-lifecycle/index.ts`: enforce requirements in the existing `tool_call` hook.
- Modify `extensions/task-lifecycle/index.test.ts`: admission, mismatch, failure, and compatibility tests.
- Modify `docs/task-lifecycle.md`: operator-facing behavior and limitations.

---

### Task 1: Classify task-scoped tool intents

**Files:**

- Create: `lib/task-lifecycle/tool-guard.ts`
- Create: `lib/task-lifecycle/tool-guard.test.ts`

**Interfaces:**

- Consumes: untrusted Pi `toolName: string` and `input: unknown` values.
- Produces:

```ts
export type TaskToolRequirement =
  | { kind: "none" }
  | { kind: "active-task" }
  | { kind: "same-task"; taskId: string }
  | { kind: "claim-task"; taskId: string };

export function classifyTaskToolRequirement(
  toolName: string,
  input: unknown,
): TaskToolRequirement;
```

- [ ] **Step 1: Write the classifier tests**

Create `lib/task-lifecycle/tool-guard.test.ts` with table-driven cases covering the complete Version 1 policy:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyTaskToolRequirement } from "./tool-guard.js";

test("classifies task-scoped tool requirements", () => {
  const cases: Array<[string, unknown, unknown]> = [
    ["subagent", { agent: "worker", task: "implement" }, { kind: "active-task" }],
    ["subagent", { workflow: "review", args: {} }, { kind: "active-task" }],
    ["subagent", { action: "list" }, { kind: "none" }],
    ["task_claim", { taskId: "jp-a" }, { kind: "claim-task", taskId: "jp-a" }],
    ["task_wait", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    ["task_close", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    ["task_attach_artifact", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    ["task_worktree_acquire", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
    ["task_worktree_release", { taskId: "jp-a" }, { kind: "same-task", taskId: "jp-a" }],
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
  assert.deepEqual(classifyTaskToolRequirement("task_wait", {}), { kind: "none" });
  assert.deepEqual(classifyTaskToolRequirement("task_claim", { taskId: "" }), { kind: "none" });
  assert.deepEqual(classifyTaskToolRequirement("task_close", null), { kind: "none" });
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
npm run test:file -- lib/task-lifecycle/tool-guard.test.ts
```

Expected: FAIL because `./tool-guard.js` does not exist.

- [ ] **Step 3: Implement the minimal pure classifier**

Create `lib/task-lifecycle/tool-guard.ts`:

```ts
export type TaskToolRequirement =
  | { kind: "none" }
  | { kind: "active-task" }
  | { kind: "same-task"; taskId: string }
  | { kind: "claim-task"; taskId: string };

const sameTaskTools = new Set([
  "task_attach_artifact",
  "task_wait",
  "task_close",
  "task_worktree_acquire",
  "task_worktree_release",
]);

export function classifyTaskToolRequirement(
  toolName: string,
  input: unknown,
): TaskToolRequirement {
  if (toolName === "subagent") {
    return isRecord(input) && typeof input.action === "string"
      ? { kind: "none" }
      : { kind: "active-task" };
  }

  const taskId = readTaskId(input);
  if (toolName === "task_claim" && taskId !== null) {
    return { kind: "claim-task", taskId };
  }
  if (sameTaskTools.has(toolName) && taskId !== null) {
    return { kind: "same-task", taskId };
  }
  return { kind: "none" };
}

function readTaskId(input: unknown): string | null {
  if (!isRecord(input)) return null;
  return typeof input.taskId === "string" && input.taskId.length > 0
    ? input.taskId
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

Do not import lifecycle services or Pi types into this module.

- [ ] **Step 4: Run the classifier tests and observe GREEN**

Run:

```bash
npm run test:file -- lib/task-lifecycle/tool-guard.test.ts
```

Expected: all classifier tests pass.

- [ ] **Step 5: Commit the classifier**

```bash
git add lib/task-lifecycle/tool-guard.ts lib/task-lifecycle/tool-guard.test.ts
git diff --cached --name-only
git commit -m "classify task-scoped tool calls"
```

---

### Task 2: Resolve Active tasks owned by a session

**Files:**

- Modify: `lib/task-lifecycle/service.ts`
- Modify: `lib/task-lifecycle/service.test.ts`

**Interfaces:**

- Consumes: `LifecycleStore.list(["in_progress"])` and a Pi session ID.
- Produces:

```ts
TaskLifecycleService.activeTasksForSession(
  sessionId: string,
): Promise<LifecycleIssue[]>;
```

- Preserves:

```ts
TaskLifecycleService.hasActiveTask(sessionId: string): Promise<boolean>;
```

by implementing it from `activeTasksForSession`.

- [ ] **Step 1: Write focused ownership-resolution tests**

Add tests to `lib/task-lifecycle/service.test.ts` using the existing fake store. Construct issues for:

- an Active task owned by `session-a`;
- an Active task owned by `session-b`;
- a lifecycle-managed Waiting task;
- a legacy `in_progress` task with no lifecycle metadata.

Assert:

```ts
const owned = await sut.activeTasksForSession("session-a");
assert.deepEqual(owned.map((issue) => issue.id), ["jp-a", "jp-z"]);
```

Use two owned tasks inserted in reverse ID order so the test proves deterministic sorting. Also assert:

```ts
assert.equal(await sut.hasActiveTask("session-a"), true);
assert.deepEqual(await sut.activeTasksForSession("missing"), []);
```

The fake store must return all configured issues from `list(["in_progress"])`; do not weaken production filtering to satisfy the fixture.

- [ ] **Step 2: Run the service tests and observe RED**

Run:

```bash
npm run test:file -- lib/task-lifecycle/service.test.ts
```

Expected: FAIL because `activeTasksForSession` is not defined.

- [ ] **Step 3: Implement authoritative lookup**

Add this method beside `hasActiveTask` in `TaskLifecycleService`:

```ts
async activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]> {
  const issues = await this.deps.store.list(["in_progress"]);
  return issues
    .filter(
      (issue) =>
        issue.lifecycle?.phase === "active" &&
        issue.lifecycle.execution?.sessionId === sessionId,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

async hasActiveTask(sessionId: string): Promise<boolean> {
  return (await this.activeTasksForSession(sessionId)).length > 0;
}
```

Do not infer ownership from native `status=in_progress` alone.

- [ ] **Step 4: Run service and model tests**

Run:

```bash
npm run test:file -- \
  lib/task-lifecycle/service.test.ts \
  lib/task-lifecycle/model.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit session ownership resolution**

```bash
git add lib/task-lifecycle/service.ts lib/task-lifecycle/service.test.ts
git diff --cached --name-only
git commit -m "resolve active session tasks"
```

---

### Task 3: Enforce tool requirements in the lifecycle extension

**Files:**

- Modify: `extensions/task-lifecycle/index.ts`
- Modify: `extensions/task-lifecycle/index.test.ts`

**Interfaces:**

- Consumes:

```ts
classifyTaskToolRequirement(toolName, input)
TaskLifecycleToolService.activeTasksForSession(sessionId)
```

- Produces Pi `tool_call` hook results of either `undefined` or:

```ts
{ block: true; reason: string }
```

- [ ] **Step 1: Extend the extension harness for Active-task lookup**

Add to `TaskLifecycleToolService` in `extensions/task-lifecycle/index.ts`:

```ts
activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]>;
```

In `extensions/task-lifecycle/index.test.ts`, replace the boolean-only guard fixture with an array while retaining `hasActiveTask` coverage for the raw worktree guard:

```ts
const guardState = {
  activeTasks: [] as LifecycleIssue[],
  associatedClaims: new Set<string>(),
};

async activeTasksForSession(sessionId: string) {
  calls.push({ name: "activeTasksForSession", args: [sessionId] });
  return guardState.activeTasks;
},
async hasActiveTask(sessionId: string) {
  calls.push({ name: "hasActiveTask", args: [sessionId] });
  return guardState.activeTasks.length > 0;
},
```

Add a test helper that creates an Active issue with an ID and matching execution lease:

```ts
function activeIssue(id: string, sessionId = "session-1"): LifecycleIssue {
  const issue = normalizedIssue("active");
  issue.id = id;
  issue.lifecycle!.execution = {
    sessionId,
    claimedAt: new Date(NOW).toISOString(),
    lastActivityAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    resourceSnapshot: { observedAt: new Date(NOW).toISOString(), resourceIds: [] },
  };
  return issue;
}
```

- [ ] **Step 2: Write failing admission tests**

Add focused tests that invoke the registered `tool_call` handler directly and assert:

```ts
const blocked = await guard(
  { toolName: "subagent", input: { agent: "worker", task: "implement" } },
  h.context,
);
assert.deepEqual(blocked, {
  block: true,
  reason: "subagent execution requires an Active task; claim a task before retrying",
});
```

Then cover:

- one attached task allows subagent execution;
- `{ toolName: "subagent", input: { action: "list" } }` remains allowed and does not call `activeTasksForSession`;
- same-task `task_wait` is allowed;
- different-task `task_wait` is blocked with `session owns active task jp-a, not jp-b`;
- unattached `task_claim` is allowed;
- retrying `task_claim` for the attached task is allowed;
- claiming another task is blocked;
- two Active tasks block with sorted task IDs;
- a rejected `activeTasksForSession` call returns a generic verification failure without the thrown message;
- unknown tools remain allowed and do not call the resolver;
- all existing raw worktree-pool guard assertions still pass.

For the store-failure case, reject with a sentinel containing text that must not appear in the returned reason:

```ts
new Error("private task content and raw stderr")
```

- [ ] **Step 3: Run the extension test and observe RED**

Run:

```bash
npm run test:file -- extensions/task-lifecycle/index.test.ts
```

Expected: FAIL because subagent and same-task calls are not yet guarded.

- [ ] **Step 4: Implement admission in the existing hook**

Import the classifier into `extensions/task-lifecycle/index.ts`. Preserve the existing raw worktree checks, then enforce the classified requirement.

Use a small local helper to create block results:

```ts
const block = (reason: string) => ({ block: true, reason });
```

After handling the raw pool cases:

```ts
const requirement = classifyTaskToolRequirement(
  typeof event?.toolName === "string" ? event.toolName : "",
  event?.input,
);
if (requirement.kind === "none") return undefined;

let activeTasks: LifecycleIssue[];
try {
  activeTasks = await deps.service.activeTasksForSession(
    context.sessionManager.getSessionId(),
  );
} catch {
  return block(`unable to verify Active task ownership for ${event.toolName}`);
}

if (activeTasks.length > 1) {
  return block(
    `session owns multiple Active tasks: ${activeTasks
      .map((issue) => issue.id)
      .join(", ")}; repair lifecycle state before retrying`,
  );
}

const activeTask = activeTasks[0] ?? null;
```

Apply each requirement explicitly:

- `active-task`: block when `activeTask === null`;
- `same-task`: block when unattached or when IDs differ;
- `claim-task`: allow when unattached or IDs match, otherwise block and instruct the caller to wait, close, or relinquish the current task.

Do not persist state, alter arguments, or inspect arbitrary text.

- [ ] **Step 5: Run focused lifecycle extension tests**

Run:

```bash
npm run test:file -- \
  lib/task-lifecycle/tool-guard.test.ts \
  lib/task-lifecycle/service.test.ts \
  extensions/task-lifecycle/index.test.ts
```

Expected: all tests pass, including the existing raw pool guard tests.

- [ ] **Step 6: Run type checking and formatting for changed code**

Run:

```bash
npm run typecheck
npx prettier --check \
  lib/task-lifecycle/tool-guard.ts \
  lib/task-lifecycle/tool-guard.test.ts \
  lib/task-lifecycle/service.ts \
  lib/task-lifecycle/service.test.ts \
  extensions/task-lifecycle/index.ts \
  extensions/task-lifecycle/index.test.ts
git diff --check
```

Expected: every command exits successfully.

- [ ] **Step 7: Commit admission enforcement**

```bash
git add \
  extensions/task-lifecycle/index.ts \
  extensions/task-lifecycle/index.test.ts
git diff --cached --name-only
git commit -m "guard task-scoped tool calls"
```

---

### Task 4: Document and verify the rollout

**Files:**

- Modify: `docs/task-lifecycle.md`

**Interfaces:**

- Documents the exact protected operations, derived attachment rule, errors, and Version 1 limitations from the approved specification.

- [ ] **Step 1: Add the operator-facing tool-guard section**

Add a `## Task-scoped tool guards` section to `docs/task-lifecycle.md` containing:

- attachment is derived from Active ownership by the current Pi session;
- subagent execution requires an Active task;
- subagent management actions remain available unattached;
- lifecycle tools with a structured `taskId` must target the attached task;
- `task_claim` cannot switch a session directly to a second task;
- unknown tools, Bash, reads, and recovery paths remain unprotected;
- no child task inheritance or automatic artifact attachment exists in Version 1;
- claim and launch should occur in separate turns.

Include these recovery instructions:

```text
If execution is blocked as unattached, call task_claim for the intended task and retry.
If the session owns the wrong task, move that task to Waiting, Done, or Actionable before claiming another.
If multiple Active tasks are reported, repair their lifecycle ownership explicitly before retrying protected work.
```

- [ ] **Step 2: Run focused and complete tests**

Run:

```bash
npm run test:file -- \
  lib/task-lifecycle/tool-guard.test.ts \
  lib/task-lifecycle/service.test.ts \
  extensions/task-lifecycle/index.test.ts
npm test
```

Expected: focused tests and the complete suite pass.

- [ ] **Step 3: Run repository gates**

Run:

```bash
node scripts/check-beads-lifecycle-compat.mjs
npm run typecheck
npm run format:check
npx prettier --check \
  docs/task-lifecycle.md \
  docs/superpowers/specs/2026-09-18-task-scoped-tool-guards-design.md \
  docs/superpowers/plans/2026-09-18-task-scoped-tool-guards.md
npm run verify:portable
node --test tests/manifest.test.mjs
git diff --check
git status --short
```

Expected:

- Beads compatibility passes;
- the complete test suite and three manifest tests pass;
- type checking and all Prettier checks pass;
- portability passes;
- `git diff --check` reports no errors;
- only intended implementation and documentation files are modified.

- [ ] **Step 4: Commit operational documentation**

```bash
git add docs/task-lifecycle.md
git diff --cached --name-only
git commit -m "document task-scoped tool guards"
```

- [ ] **Step 5: Verify the final branch**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: the worktree is clean and the four focused commits are present in order.

## Completion criteria

Implementation is complete when:

- the approved classifier policy is represented by pure table-driven tests;
- protected calls derive attachment from authoritative lifecycle ownership;
- subagent execution is blocked while unattached and allowed while attached;
- structured lifecycle task IDs cannot target another task;
- a session cannot sequentially claim a second task while its first remains Active;
- existing worktree-pool guards continue to pass;
- no deferred feature from the specification has been introduced;
- focused tests, the full suite, compatibility, type checking, formatting, portability, manifest tests, and diff checks all pass.
