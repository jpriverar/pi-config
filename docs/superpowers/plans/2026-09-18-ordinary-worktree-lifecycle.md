# Ordinary Worktree Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary `worktree_pool` acquire and release operations task-scoped and lifecycle-coordinated, then remove the public `task_worktree_*` tools.

**Architecture:** The lifecycle `tool_call` hook persists resource intent and injects a private correlation object before the task-agnostic pool executes. The `tool_result` hook validates the pool receipt and finalizes lifecycle metadata; existing synchronous reconciliation handles partial operations.

**Tech Stack:** Node.js 22, TypeScript, NodeNext `.js` imports, Pi extension hooks, `tsx --test`, TypeBox-compatible JSON schemas, Prettier.

**Spec:** `docs/superpowers/specs/2026-09-18-ordinary-worktree-lifecycle-design.md`

## Global Constraints

- Keep the worktree pool core unaware of tasks and Beads.
- Use the Pi tool-call ID as the operation ID and existing lifecycle-generated UUIDs as claim/path identities.
- Do not expose private correlation fields in the public `worktree_pool` schema.
- Treat tool input, task metadata, and tool results as untrusted.
- Fail closed for ambiguous or unverifiable protected state with curated errors.
- Preserve legacy unassociated release, list, and repair as recovery operations.
- Use focused RED/GREEN tests before each production change.
- Do not add timers, watchers, Bun, or background reconciliation.

---

### Task 1: Add private pool correlation input

**Files:**

- Create: `lib/task-lifecycle/worktree-tool-context.ts`
- Create: `lib/task-lifecycle/worktree-tool-context.test.ts`
- Modify: `extensions/worktree-pool/index.ts`
- Test: `extensions/worktree-pool/index.test.ts`

**Interfaces:**

- Produces `WORKTREE_LIFECYCLE_CONTEXT_KEY`, `WorktreeLifecycleContext`, and `readWorktreeLifecycleContext(input)`.
- The pool adapter consumes injected acquire identities but the public schema remains unchanged.

- [ ] **Step 1: Write failing parser and adapter tests**

Add tests proving that an absent context returns `null`, malformed contexts throw a curated validation error, and a valid acquire context reaches the third `pool.acquire` argument:

```ts
const context: WorktreeLifecycleContext = {
  version: 1,
  mode: "acquire",
  taskId: "jp-1",
  operationId: "tool-call-1",
  claimId: CLAIM_ID,
  pathId: "22222222-2222-4222-8222-222222222222",
  repository: "demo",
};

await h.call({
  action: "acquire",
  repository: "demo",
  branch: "topic",
  [WORKTREE_LIFECYCLE_CONTEXT_KEY]: context,
});
expect(h.pool.calls[0].args[2]).toEqual({
  claimId: context.claimId,
  pathId: context.pathId,
});
```

Keep the existing assertion that `pathId`, `claimId`, and the private key are absent from `tool.parameters.properties`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test:file -- lib/task-lifecycle/worktree-tool-context.test.ts extensions/worktree-pool/index.test.ts
```

Expected: FAIL because the context module does not exist and the pool adapter does not forward injected identities.

- [ ] **Step 3: Implement the private context parser and pool forwarding**

Define the bounded discriminated type:

```ts
export const WORKTREE_LIFECYCLE_CONTEXT_KEY = "__piTaskLifecycle";

export type WorktreeLifecycleContext =
  | {
      version: 1;
      mode: "acquire";
      taskId: string;
      operationId: string;
      claimId: string;
      pathId: string;
      repository: string;
    }
  | {
      version: 1;
      mode: "release";
      taskId: string;
      operationId: string;
      claimId: string;
      repository: string;
    };
```

`readWorktreeLifecycleContext` must return `null` when the key is absent and reject unknown keys, empty identifiers, invalid versions, action/mode mismatches, or a missing acquire `pathId`.

Update only the worktree-pool extension adapter to ignore the validated private key during action-field validation and pass `{ claimId, pathId }` to `runtime.pool.acquire`. Do not change `pool.ts` or the public tool schema.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/task-lifecycle/worktree-tool-context.ts lib/task-lifecycle/worktree-tool-context.test.ts extensions/worktree-pool/index.ts extensions/worktree-pool/index.test.ts
git diff --cached --name-only
git commit -m "support lifecycle pool identities"
```

---

### Task 2: Split lifecycle resource preparation from finalization

**Files:**

- Modify: `lib/task-lifecycle/service.ts`
- Test: `lib/task-lifecycle/service.test.ts`

**Interfaces:**

- Produces:

```ts
prepareWorktreeAcquire(
  request: TaskWorktreeAcquireRequest,
  owner: LockOwner,
  operationId: string,
): Promise<WorktreeLifecycleContext>;

finalizeWorktreeAcquire(
  context: Extract<WorktreeLifecycleContext, { mode: "acquire" }>,
  result: AcquireResult,
  owner: LockOwner,
): Promise<LifecycleIssue>;

associatedTasksForClaim(claimId: string): Promise<LifecycleIssue[]>;

prepareWorktreeRelease(
  taskId: string,
  claimId: string,
  owner: LockOwner,
  operationId: string,
): Promise<WorktreeLifecycleContext>;

finalizeWorktreeRelease(
  context: Extract<WorktreeLifecycleContext, { mode: "release" }>,
  owner: LockOwner,
): Promise<LifecycleIssue>;
```

- Existing `task_wait` and `task_close` continue using an internal combined release helper.

- [ ] **Step 1: Rewrite service tests around prepare/finalize boundaries**

Replace direct public-wrapper expectations with tests that assert:

```ts
const prepared = await sut.prepareWorktreeAcquire(
  {
    taskId: "jp-1",
    repository: "DataDog/dd-source",
    branch: "jpriverar/topic",
  },
  session("s1"),
  "tool-call-1",
);
assert.equal(pool.acquireCalls.length, 0);
assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "acquiring");

const saved = await sut.finalizeWorktreeAcquire(
  prepared as Extract<WorktreeLifecycleContext, { mode: "acquire" }>,
  acquireReceipt(prepared),
  session("s1"),
);
assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
```

Also cover same-repository/branch retry reuse, exact receipt validation, deterministic sorting from `associatedTasksForClaim`, release preparation, release-pending retry reuse, and release finalization.

- [ ] **Step 2: Run the service tests and verify RED**

```bash
npm run test:file -- lib/task-lifecycle/service.test.ts
```

Expected: FAIL because the split methods do not exist.

- [ ] **Step 3: Refactor the service without changing lifecycle metadata schema**

Extract the existing phases of `acquireWorktree` and `releaseWorktree` into the interfaces above. Preparation owns authoritative task mutation; finalization rechecks task ownership and exact operation/claim identity before calling the existing model transitions.

When preparation finds an existing pending operation for the same repository and branch or claim, return its persisted operation and identities rather than generating new ones. This makes an ordinary retry recover the original operation even though Pi assigns the retry a new tool-call ID.

`associatedTasksForClaim` must scan lifecycle-managed issues across all statuses, return deterministic task-ID order, and include released records so contradictory duplicate history fails closed.

Keep a private combined release helper for `releaseResources`; it must call prepare, pool release, and finalize in that order.

- [ ] **Step 4: Run service and model tests and verify GREEN**

```bash
npm run test:file -- lib/task-lifecycle/service.test.ts lib/task-lifecycle/model.test.ts
```

Expected: all tests pass without changes to the model schema.

- [ ] **Step 5: Commit**

```bash
git add lib/task-lifecycle/service.ts lib/task-lifecycle/service.test.ts
git diff --cached --name-only
git commit -m "split worktree lifecycle phases"
```

---

### Task 3: Coordinate ordinary pool calls in Pi hooks

**Files:**

- Modify: `lib/task-lifecycle/tool-guard.ts`
- Test: `lib/task-lifecycle/tool-guard.test.ts`
- Modify: `extensions/task-lifecycle/index.ts`
- Test: `extensions/task-lifecycle/index.test.ts`

**Interfaces:**

- Consumes the Task 1 context key/parser and Task 2 service methods.
- Removes `task_worktree_acquire` and `task_worktree_release` registrations.
- Registers one lifecycle `tool_result` handler.

- [ ] **Step 1: Write failing classifier and hook tests**

Update the pure classifier expectation:

```ts
assert.deepEqual(
  classifyTaskToolRequirement("worktree_pool", {
    action: "acquire",
    repository: "repo",
    branch: "topic",
  }),
  { kind: "active-task" },
);
```

Replace the old task-specific tool tests with hook tests proving:

- the two tools are absent;
- unattached acquire is blocked before preparation;
- attached acquire calls `prepareWorktreeAcquire` and injects its context;
- associated release requires the same Active task and calls `prepareWorktreeRelease`;
- unassociated release, list, and repair remain untouched;
- a successful `tool_result` invokes the matching finalize method;
- failed pool results leave pending state untouched;
- malformed receipts and finalization failures return `isError: true` with curated identifiers only.

- [ ] **Step 2: Run focused hook tests and verify RED**

```bash
npm run test:file -- lib/task-lifecycle/tool-guard.test.ts extensions/task-lifecycle/index.test.ts
```

Expected: FAIL because acquire has the old inverse guard, task-specific tools remain registered, and no result hook exists.

- [ ] **Step 3: Implement pre-call coordination and remove public wrappers**

Delete both `pi.registerTool` blocks for `task_worktree_*` and remove them from `sameTaskTools`.

Classify only `worktree_pool acquire` as `active-task`. After resolving exactly one task, call `prepareWorktreeAcquire` and assign its returned context to `event.input[WORKTREE_LIFECYCLE_CONTEXT_KEY]`.

For release, call `associatedTasksForClaim` first:

```ts
if (associated.length === 0) return undefined;
if (associated.length !== 1) return block(ambiguousClaimReason(claimId));
if (activeTask?.id !== associated[0].id) return block(ownerMismatchReason(...));
const prepared = await deps.service.prepareWorktreeRelease(
  associated[0].id,
  claimId,
  ownerFor(context),
  event.toolCallId,
);
event.input[WORKTREE_LIFECYCLE_CONTEXT_KEY] = prepared;
```

Catch store failures and return curated block reasons without raw errors.

- [ ] **Step 4: Implement result finalization**

Register `tool_result`. Ignore non-pool, uncoordinated, and `isError` results. Validate `event.details` against the injected mode and claim before invoking the corresponding finalize method.

On finalization failure, replace the result with a bounded error such as:

```text
worktree_pool acquire completed for claim <claimId>, but task <taskId> lifecycle finalization failed; reconcile the task before continuing
```

Do not claim that the pool mutation rolled back.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command plus:

```bash
npm run test:file -- extensions/worktree-pool/index.test.ts lib/task-lifecycle/service.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/task-lifecycle/tool-guard.ts lib/task-lifecycle/tool-guard.test.ts extensions/task-lifecycle/index.ts extensions/task-lifecycle/index.test.ts
git diff --cached --name-only
git commit -m "coordinate ordinary worktree tools"
```

---

### Task 4: Reconcile pending resources and enforce clean transitions

**Files:**

- Modify: `lib/task-lifecycle/service.ts`
- Test: `lib/task-lifecycle/service.test.ts`

**Interfaces:**

- Extends `reconcileTask` to reconcile worktree resource states before execution timeout handling.
- Keeps `task_wait` and `task_close` automatic cleanup behavior.

- [ ] **Step 1: Write failing recovery and transition tests**

Add tests for:

```ts
// acquiring + one exact valid pool claim -> active
await sut.reconcileTask("jp-1", session("s1"));
assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "active");

// release_pending + no exact pool claim -> released
await sut.reconcileTask("jp-1", session("s1"));
assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "released");
```

Also prove that zero/multiple/contradictory acquisition evidence remains explicit, pending resources prevent Waiting/Done, and a refused automatic release leaves the task Active with an error matching:

```text
task jp-1 still owns worktree <claim>; make it releasable or release it before waiting
```

- [ ] **Step 2: Run service tests and verify RED**

```bash
npm run test:file -- lib/task-lifecycle/service.test.ts
```

Expected: FAIL because Active reconciliation currently checks only execution timeout and release errors are not actionable.

- [ ] **Step 3: Implement bounded resource reconciliation**

Before timeout reconciliation, inspect each non-released resource using exact repository and claim identity:

- finalize `acquiring` only for one valid exact match;
- finalize `release_pending` only when no exact match remains;
- leave a missing acquisition or still-present release explicit and retryable;
- throw curated ambiguity or contradiction errors for unsafe evidence.

Process resources deterministically and synchronously. Do not add polling or timers.

Wrap automatic cleanup refusal with the task ID and claim while preserving the pending resource state and Active phase.

- [ ] **Step 4: Run lifecycle tests and verify GREEN**

```bash
npm run test:file -- lib/task-lifecycle/service.test.ts lib/task-lifecycle/model.test.ts tests/task-lifecycle-integration.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/task-lifecycle/service.ts lib/task-lifecycle/service.test.ts
git diff --cached --name-only
git commit -m "reconcile worktree resource operations"
```

---

### Task 5: Document and verify the delivered flow

**Files:**

- Modify: `docs/task-lifecycle.md`
- Modify: `docs/superpowers/plans/2026-09-18-ordinary-worktree-lifecycle.md`

**Interfaces:**

- Documents only `task_claim` plus ordinary `worktree_pool` operations as the public workflow.

- [ ] **Step 1: Update lifecycle operations documentation**

Replace every normal-use reference to `task_worktree_acquire` or `task_worktree_release` with:

```text
task_claim -> worktree_pool acquire -> worktree_pool release -> task_wait/task_close
```

Document automatic association, automatic cleanup before Waiting/Done, legacy unassociated release, and partial-operation reconciliation.

- [ ] **Step 2: Run the full verification suite**

Run each gate separately and record actual results:

```bash
npm test
node scripts/check-beads-lifecycle-compat.mjs
npm run typecheck
npm run format:check
npm run verify:portable
git diff --check
```

Expected: every command exits 0. Do not claim completion from focused tests alone.

- [ ] **Step 3: Mark this plan complete and commit documentation**

Check completed steps in this file, then:

```bash
git add docs/task-lifecycle.md docs/superpowers/plans/2026-09-18-ordinary-worktree-lifecycle.md
git diff --cached --name-only
git commit -m "document ordinary worktree lifecycle"
```

- [ ] **Step 4: Verify final branch state**

```bash
git status --short --branch
git log --oneline main..HEAD
git diff --check main...HEAD
```

Expected: clean status, only focused commits, and no whitespace errors.
