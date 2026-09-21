# Lifecycle-Safe Task Tool Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy issue mutation tools with one lifecycle-safe `task_*` surface and make `task-lifecycle` the sole task-domain extension.

**Architecture:** Extend the existing lifecycle store, model, service, and extension rather than adding another subsystem. Preserve the existing work-state renderer and hooks in a focused `work-state.ts` module, then remove `jp-workflow` after the replacement tools are registered and tested.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9 with NodeNext `.js` imports, Pi extensions, Beads CLI, `tsx --test`, `node:test`, Prettier.

**Spec:** `docs/superpowers/specs/2026-09-21-task-tool-surface-design.md`

## Global Constraints

- Keep lifecycle metadata at version 1; do not introduce a metadata migration.
- `task_update` changes only labels; lifecycle and native status fields are not accepted.
- `task_log` appends a native Beads comment and requires the current session to own the Active task.
- Waiting conditions block only `completed`; `cancelled` and `superseded` may abandon them.
- Waiting tasks may become Active without losing their dependency or typed-check condition.
- Waiting, Deferred, and Done transitions must release associated worktrees before clearing ownership.
- Preserve the startup table, scoped hidden task context, and post-compaction reinjection currently provided by `jp-workflow`.
- Every Beads command receives the explicit configured store path.
- Lifecycle writes remain locked full-object read/merge/write operations followed by read-back.
- Use NodeNext `.js` imports and Node 22-compatible APIs; do not add Bun or new dependencies.
- Retire `file_issue`, `update_issue`, and `close_issue`; do not leave aliases or an alternate mutation path.

## Review Focus

- Empty or overlapping `add_labels`/`remove_labels` input must fail without issuing a partial Beads mutation; Task 1 tests this.
- Ownership must be revalidated under the lifecycle lock immediately before appending a comment; Task 1 tests an ownership change between calls.
- Claiming a Waiting task must preserve both dependency and typed-check conditions without making unrelated combinations valid; Task 2 tests both paths.
- Reconciliation of an Active task with a satisfied check must not close it or clear its lease; Task 2 tests this race.
- Moving the work-state code must preserve hostile-metadata escaping and hidden-context budgets exactly; Task 4 runs the relocated regression suite.

---

### Task 1: Add Safe Create, Label, Log, and Defer Operations

**Files:**

- Modify: `lib/task-lifecycle/types.ts`
- Modify: `lib/task-lifecycle/model.ts`
- Modify: `lib/task-lifecycle/model.test.ts`
- Modify: `lib/task-lifecycle/service.ts`
- Modify: `lib/task-lifecycle/service.test.ts`
- Modify: `lib/task-lifecycle/beads-store.ts`
- Modify: `lib/task-lifecycle/beads-store.test.ts`

**Interfaces:**

- Produces: `CreateTaskInput`, `UpdateTaskLabelsInput`, `LifecycleStore.create`, `LifecycleStore.updateLabels`, `LifecycleStore.appendComment`, `TaskLifecycleService.create`, `TaskLifecycleService.updateLabels`, `TaskLifecycleService.log`, `TaskLifecycleService.defer`.
- Consumes: existing `LifecycleIssue`, `LifecycleMetadataV1`, `LockOwner`, `Mutation`, resource cleanup, and Beads execution adapters.

- [ ] **Step 1: Add failing model and service tests for the four operations**

Add focused cases equivalent to:

```ts
test("creates managed actionable tasks", async () => {
  const created = await service(store).create(
    {
      title: "Ship it",
      why: "Required",
      workstream: "pi-setup",
      needsJp: false,
    },
    session("s1"),
  );
  assert.equal(created.status, "open");
  assert.equal(created.lifecycle?.phase, "actionable");
});

test("updates labels without adopting legacy lifecycle", async () => {
  const saved = await service(store).updateLabels(
    "jp-1",
    { addLabels: ["priority:high"], removeLabels: ["priority:low"] },
    session("s1"),
  );
  assert.equal(saved.lifecycle, null);
});

test("logs only while the same session owns the active task", async () => {
  await assert.rejects(
    service(store).log("jp-1", "progress", session("other")),
    /current execution owner/,
  );
  assert.deepEqual(store.comments, []);
});

test("defers only after releasing task worktrees", async () => {
  const saved = await service(store, { pool }).defer(
    "jp-1",
    "Lower priority",
    session("s1"),
    "defer-1",
  );
  assert.equal(saved.lifecycle?.phase, "deferred");
  assert.equal(saved.lifecycle?.execution, null);
  assert.equal(saved.status, "deferred");
});
```

Also pin these failures:

```ts
assert.throws(
  () => normalizeLabelUpdate({ addLabels: [], removeLabels: [] }),
  /at least one label change/,
);
assert.throws(
  () => normalizeLabelUpdate({ addLabels: ["x"], removeLabels: ["x"] }),
  /both add and remove/,
);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npm run test:file -- \
  lib/task-lifecycle/model.test.ts \
  lib/task-lifecycle/service.test.ts \
  lib/task-lifecycle/beads-store.test.ts
```

Expected: failures for missing create/update/log/defer APIs and normalization helpers.

- [ ] **Step 3: Add the input and store interfaces**

Add these internal shapes in `types.ts`:

```ts
export interface CreateTaskInput {
  title: string;
  why: string;
  workstream?: string;
  needsJp: boolean;
}

export interface UpdateTaskLabelsInput {
  addLabels: string[];
  removeLabels: string[];
}

export interface LifecycleStore {
  show(id: string): Promise<LifecycleIssue>;
  list(statuses: readonly LifecycleStatus[]): Promise<LifecycleIssue[]>;
  readyIds(): Promise<ReadonlySet<string>>;
  create(
    input: CreateTaskInput,
    lifecycle: LifecycleMetadataV1,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  updateLabels(
    id: string,
    input: UpdateTaskLabelsInput,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  appendComment(
    id: string,
    message: string,
    owner: LockOwner,
    validate: (issue: LifecycleIssue) => void,
  ): Promise<LifecycleIssue>;
  mutate(
    id: string,
    owner: LockOwner,
    operation: (issue: LifecycleIssue) => Mutation,
  ): Promise<LifecycleIssue>;
  addBlocker(dependentId: string, blockerId: string): Promise<void>;
}
```

`appendComment` must acquire the lifecycle file-operation lock, read the issue, call `validate`, append with `bd comments add`, and read back before releasing the lock. `updateLabels` must issue one Beads update containing both add/remove arguments so it cannot leave a partial label change.

- [ ] **Step 4: Implement minimal model and service behavior**

Add a model transition that reuses V1:

```ts
export function deferLifecycle(
  state: LifecycleMetadataV1,
  input: { operationId: string; now: string; reason: string },
): LifecycleMetadataV1 {
  requireInvariant(state.phase === "active", "defer requires phase active");
  requireNoUnreleasedWorktrees(state);
  return transition(
    { ...state, execution: null, waiting: null, activeCheck: null },
    input.operationId,
    "defer",
    input.now,
    "deferred",
    { reason: input.reason },
  );
}
```

Implement service methods with these signatures:

```ts
create(input: CreateTaskInput, owner: LockOwner): Promise<LifecycleIssue>;
updateLabels(taskId: string, input: UpdateTaskLabelsInput, owner: LockOwner): Promise<LifecycleIssue>;
log(taskId: string, message: string, owner: LockOwner): Promise<LifecycleIssue>;
defer(taskId: string, reason: string, owner: LockOwner, operationId?: string): Promise<LifecycleIssue>;
```

Use the existing resource-release path before `deferLifecycle`. For `log`, perform `requireManaged`, `requireCurrentOwner`, and `phase === "active"` validation through the store's locked `appendComment` callback.

- [ ] **Step 5: Implement and test Beads command adapters**

Use existing `execute`, identifier validation, error redaction, metadata serialization, and read-back helpers. Pin exact commands in `beads-store.test.ts`:

```ts
[
  "create",
  "Ship it",
  "-d",
  "Required",
  "-l",
  "workstream:pi-setup",
  "--metadata",
  serializedMetadata,
  "--json",
]
[
  "update",
  "jp-1",
  "--add-label",
  "priority:high",
  "--remove-label",
  "priority:low",
  "--json",
]
["comments", "add", "jp-1", "progress", "--json"]
```

Include the explicit `--db <store>` behavior through the existing executor abstraction rather than duplicating it in assertions.

- [ ] **Step 6: Run focused GREEN tests**

Run the Step 2 command. Expected: all selected tests pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add lib/task-lifecycle
git diff --cached --name-only
git commit -m "task: add safe mutation services"
```

### Task 2: Allow Active Work With Retained Waiting Conditions

**Files:**

- Modify: `lib/task-lifecycle/model.ts`
- Modify: `lib/task-lifecycle/model.test.ts`
- Modify: `lib/task-lifecycle/service.ts`
- Modify: `lib/task-lifecycle/service.test.ts`

**Interfaces:**

- Produces: `TaskLifecycleService.waitOnExistingCondition` and broadened V1 claim/reconcile/close behavior.
- Consumes: existing `claimLifecycle`, `waitLifecycle`, `closeLifecycle`, `LifecycleCheck`, and native dependency summaries.

- [ ] **Step 1: Write failing tests for Waiting → Active → Waiting**

Add model/service cases equivalent to:

```ts
test("claims dependency-waiting work without dropping blockers", async () => {
  const saved = await service(storeWithDependencyWait()).claim(
    "jp-1",
    session("s1"),
    "claim-1",
  );
  assert.equal(saved.lifecycle?.phase, "active");
  assert.deepEqual(saved.lifecycle?.waiting, { kind: "dependency" });
  assert.equal(saved.dependencies[0]?.status, "open");
});

test("claims check-waiting work without dropping its check", async () => {
  const saved = await service(storeWithCheckWait()).claim(
    "jp-1",
    session("s1"),
  );
  assert.equal(saved.lifecycle?.activeCheck?.id, "check-1");
});

test("returns active work to its retained condition", async () => {
  const saved = await service(storeWithActiveCheck()).waitOnExistingCondition(
    "jp-1",
    session("s1"),
    "wait-1",
  );
  assert.equal(saved.lifecycle?.phase, "waiting");
  assert.equal(saved.lifecycle?.activeCheck?.id, "check-1");
});
```

- [ ] **Step 2: Write failing completion and reconciliation tests**

Pin the accepted distinction:

```ts
await assert.rejects(
  service(storeWithActiveBlocker()).close(
    "jp-1",
    { kind: "completed", reason: "done", evidenceArtifactIds: [] },
    session("s1"),
  ),
  /unresolved condition/,
);

const cancelled = await service(storeWithActiveBlocker()).close(
  "jp-1",
  { kind: "cancelled", reason: "obsolete", evidenceArtifactIds: [] },
  session("s1"),
);
assert.equal(cancelled.lifecycle?.phase, "done");
```

Add an Active-check reconciliation case asserting that a satisfied observation updates/archives the check but leaves `phase=active` and the same execution lease.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
npm run test:file -- \
  lib/task-lifecycle/model.test.ts \
  lib/task-lifecycle/service.test.ts
```

Expected: current invariants reject retained waiting/check state and `claimLifecycle` rejects phase Waiting.

- [ ] **Step 4: Relax only the necessary V1 invariants**

Change active validation to permit either no retained condition or one valid retained condition:

```ts
if (lifecycle.phase === "active") {
  requireInvariant(
    issue.status === "in_progress",
    "phase active requires native status in_progress",
  );
  requireInvariant(
    lifecycle.execution !== null,
    "phase active requires one execution lease",
  );
  validateRetainedCondition(lifecycle, unresolvedBlockers);
}
```

Keep Actionable, Waiting, Deferred, and Done invariants unchanged. Do not change `version: 1` or introduce another metadata shape.

Update `claimLifecycle` to accept `actionable` or `waiting` and preserve `waiting` plus `activeCheck` instead of clearing them.

- [ ] **Step 5: Add the existing-condition wait and Active reconcile paths**

Add:

```ts
waitOnExistingCondition(
  taskId: string,
  owner: LockOwner,
  operationId?: string,
): Promise<LifecycleIssue>;
```

It requires Active ownership, an existing unresolved condition, successful resource cleanup, and then changes only execution/phase/native projection needed to return to Waiting.

For `reconcileTask` on Active work, continue resource/lease reconciliation and also observe a retained typed check when due. A satisfied check must clear/archive the condition while preserving the execution lease; it must not call `closeLifecycle` while Active.

- [ ] **Step 6: Enforce completion eligibility in the service**

Before resource cleanup for `kind === "completed"`, reject when either condition remains unresolved:

```ts
const hasBlocker = current.dependencies.some(
  (dependency) =>
    dependency.dependencyType === "blocks" && dependency.status !== "closed",
);
const hasCheck = current.lifecycle?.activeCheck !== null;
if (hasBlocker || hasCheck) {
  throw new Error(
    `task ${taskId} has an unresolved condition and cannot be completed`,
  );
}
```

Do not apply this guard to `cancelled` or `superseded`.

- [ ] **Step 7: Run focused GREEN tests and commit**

Run the Step 3 command. Then:

```bash
git add lib/task-lifecycle/model.ts lib/task-lifecycle/model.test.ts \
  lib/task-lifecycle/service.ts lib/task-lifecycle/service.test.ts
git diff --cached --name-only
git commit -m "task: work active waiting tasks"
```

### Task 3: Register the Unified `task_*` Tool Surface

**Files:**

- Modify: `extensions/task-lifecycle/index.ts`
- Modify: `extensions/task-lifecycle/index.test.ts`
- Modify: `lib/task-lifecycle/tool-guard.ts`
- Modify: `lib/task-lifecycle/tool-guard.test.ts`

**Interfaces:**

- Produces: public `task_create`, `task_update`, `task_log`, and `task_defer` tools; optional-condition `task_wait` routing.
- Consumes: Task 1 service methods and Task 2 `waitOnExistingCondition`.

- [ ] **Step 1: Add failing registration and routing tests**

Extend the fake `TaskLifecycleToolService` and assert exact schemas/routes:

```ts
assert.deepEqual(registeredToolNames, [
  "task_create",
  "task_update",
  "task_log",
  "task_claim",
  "task_attach_artifact",
  "task_wait",
  "task_defer",
  "task_reconcile",
  "task_close",
  "task_reopen",
]);
```

Pin that:

- `task_create` maps `needs_jp` to internal `needsJp`.
- `task_update` rejects unknown/status fields and maps `add_labels`/`remove_labels`.
- `task_log` forwards one non-empty message.
- `task_defer` forwards reason and tool-call operation ID.
- `task_wait` with no kind calls `waitOnExistingCondition`; existing dependency/check inputs retain their current routes.

- [ ] **Step 2: Add failing guard tests**

```ts
assert.deepEqual(classifyTaskToolRequirement("task_log", { taskId: "jp-1" }), {
  kind: "same-task",
  taskId: "jp-1",
});
assert.deepEqual(
  classifyTaskToolRequirement("task_defer", { taskId: "jp-1" }),
  { kind: "same-task", taskId: "jp-1" },
);
assert.deepEqual(
  classifyTaskToolRequirement("task_update", { taskId: "jp-1" }),
  { kind: "none" },
);
```

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
npm run test:file -- \
  extensions/task-lifecycle/index.test.ts \
  lib/task-lifecycle/tool-guard.test.ts
```

- [ ] **Step 4: Extend the service interface and register strict tools**

Add the Task 1/2 methods to `TaskLifecycleToolService`. Define schemas with `additionalProperties: false` through the existing `objectSchema` helper.

For `task_wait`, remove `kind` from the required list and route omitted kind only when `blockerIds` and `check` are also absent. Continue rejecting mixed authorities.

- [ ] **Step 5: Extend same-task classification**

Add only `task_log` and `task_defer` to `sameTaskTools`. Keep `task_create` and `task_update` management operations. Existing `task_claim` remains the only claim transition.

- [ ] **Step 6: Run focused GREEN tests and commit**

Run the Step 3 command. Then:

```bash
git add extensions/task-lifecycle/index.ts extensions/task-lifecycle/index.test.ts \
  lib/task-lifecycle/tool-guard.ts lib/task-lifecycle/tool-guard.test.ts
git diff --cached --name-only
git commit -m "task: expose unified task tools"
```

### Task 4: Fold Work-State Presentation Into `task-lifecycle`

**Files:**

- Create: `extensions/task-lifecycle/work-state.ts`
- Create: `extensions/task-lifecycle/work-state.test.ts`
- Modify: `extensions/task-lifecycle/index.ts`
- Delete: `extensions/jp-workflow/index.ts`
- Delete: `extensions/jp-workflow/index.test.ts`
- Modify: `package.json`
- Modify: `tests/package-load.test.ts`
- Modify: `tests/pi-smoke.ts`
- Modify: `tests/manifest.test.mjs`
- Modify: `README.md`
- Modify: `docs/task-lifecycle.md`

**Interfaces:**

- Produces: `registerTaskWorkState(pi: TaskWorkStateApi): void` registered by the sole task extension.
- Consumes: existing `createBeadsClient`, `listClassifiedIssues`, session workstream resolution, startup renderer, and hidden-state rendering behavior.

- [ ] **Step 1: Move the presentation tests and remove legacy mutation expectations**

Move `extensions/jp-workflow/index.test.ts` to `extensions/task-lifecycle/work-state.test.ts`. Change its import to `./work-state.js`, preserve all startup/scoping/escaping/budget cases, and delete only tests for `file_issue`, `update_issue`, and `close_issue`.

Add one composition test in `extensions/task-lifecycle/index.test.ts` asserting the startup entry renderer and `session_compact` hook are registered by the lifecycle extension.

- [ ] **Step 2: Run relocation tests and confirm RED**

```bash
npm run test:file -- \
  extensions/task-lifecycle/work-state.test.ts \
  extensions/task-lifecycle/index.test.ts
```

Expected: missing `work-state.ts` and missing lifecycle composition.

- [ ] **Step 3: Extract `registerTaskWorkState` without changing behavior**

Move the renderer, state-query helpers, and these hooks into `work-state.ts`:

```ts
export function registerTaskWorkState(pi: TaskWorkStateApi): void {
  pi.registerEntryRenderer(STARTUP_ENTRY, renderStartupEntry);
  pi.on("session_start", appendStartupState);
  pi.on("before_agent_start", injectHiddenState);
  pi.on("session_compact", queueCompactedState);
}
```

Do not move `file_issue`, `update_issue`, or `close_issue`. Call `registerTaskWorkState(pi)` from the default lifecycle extension after constructing lifecycle dependencies. Preserve error redaction, hostile-metadata escaping, workstream scoping, visual table layout, and character caps.

- [ ] **Step 4: Delete `jp-workflow` and update package contracts**

Remove `./extensions/jp-workflow/index.ts` from `package.json` and every package-load/manifest/smoke fixture. Replace old mutation smoke calls with the new task tool names and lifecycle-safe setup; do not retain aliases.

Update documentation to list the unified tools and state that `task-lifecycle` owns both lifecycle enforcement and task-state presentation.

- [ ] **Step 5: Run focused package and presentation tests**

```bash
npm run test:file -- \
  extensions/task-lifecycle/work-state.test.ts \
  extensions/task-lifecycle/index.test.ts \
  tests/package-load.test.ts
node --test tests/manifest.test.mjs
npm run verify:smoke
```

Expected: all pass; package tools contain no retired names and package extensions contain no `jp-workflow` path.

- [ ] **Step 6: Commit Task 4**

```bash
git add -A extensions/jp-workflow extensions/task-lifecycle package.json \
  tests/package-load.test.ts tests/pi-smoke.ts tests/manifest.test.mjs \
  README.md docs/task-lifecycle.md
git diff --cached --name-only
git commit -m "task: consolidate task extension"
```

### Task 5: Verify the Complete Surface

**Files:**

- Modify only if verification finds a defect in files already owned by Tasks 1-4.

**Interfaces:**

- Consumes: the completed unified extension and all repository verification commands.
- Produces: release evidence for `jp-akhu`; no new behavior.

- [ ] **Step 1: Run focused lifecycle tests together**

```bash
npm run test:file -- \
  lib/task-lifecycle/model.test.ts \
  lib/task-lifecycle/service.test.ts \
  lib/task-lifecycle/beads-store.test.ts \
  lib/task-lifecycle/tool-guard.test.ts \
  extensions/task-lifecycle/index.test.ts \
  extensions/task-lifecycle/work-state.test.ts \
  tests/task-lifecycle-integration.test.ts \
  tests/package-load.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run static and portability gates**

```bash
npm run typecheck
npm run format:check
npm run verify:portable
npm run licenses:check
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Run repository-wide verification**

```bash
npm test
npm run verify:smoke
```

Expected: all pass. If a known timing test flakes, capture the exact failing output and rerun only that isolated test once; do not claim a clean full-suite result unless the full command itself passes.

- [ ] **Step 4: Inspect the delivered public contract**

```bash
node --test tests/manifest.test.mjs
git grep -nE 'file_issue|update_issue|close_issue|extensions/jp-workflow' -- \
  package.json README.md docs extensions lib tests ':!docs/superpowers/specs/**' ':!docs/superpowers/plans/**'
```

Expected: manifest passes and grep returns no active contract or code references.

- [ ] **Step 5: Commit any verification-only corrections**

If verification required a focused correction:

```bash
git add <only-corrected-files>
git diff --cached --name-only
git commit -m "task: fix unified surface verification"
```

Otherwise, do not create an empty commit.

- [ ] **Step 6: Stop before installation, live testing, or push**

Report local verification evidence. Updating the installed Git package, reloading Pi, live-mutating task state, and pushing remain explicit rollout decisions after local review.
