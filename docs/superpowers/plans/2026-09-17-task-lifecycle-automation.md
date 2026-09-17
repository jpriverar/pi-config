# Task Lifecycle Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement goal-preserving task lifecycle automation, typed artifacts and checks, active execution leases, and task-aware worktree coordination in JP's personal Pi core.

**Architecture:** `jpriverar/pi-config` becomes the sole source repository for both the thin worktree pool and the lifecycle extension. The lifecycle domain, Beads adapter, and check adapters are separate modules; `extensions/task-lifecycle/index.ts` owns Pi tools and event hooks, while `extensions/worktree-pool/pool.ts` remains task-agnostic and exposes only generic pool operations. Existing `jp-workflow` and `tasks-overlay` consume a read-only lifecycle view through `lib/beads.ts`.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi 0.84.1 extension API, TypeBox 1.3, `bd` 1.1.2 with Dolt, Bun/tsx `node:test`, GitHub CLI, Git.

**Spec:** `../specs/2026-09-17-task-lifecycle-artifacts-design.md`

## Global Constraints

- All source, tests, specifications, and plans land in `jpriverar/pi-config`; do not add implementation to `experimental`.
- Runtime state remains outside Git: Beads in `${BEADS_DIR:-$HOME/beads/.beads}` and worktree leases below the configured pool root.
- One task represents one goal and may own zero to many artifacts and reconciled worktrees.
- Native Beads `blocks` edges are authoritative for task dependencies; blocker IDs are never copied into lifecycle metadata.
- `worktree_pool` imports no Beads or lifecycle module, receives no task ID, and owns allocation, capacity, registration, claims, release, and repair.
- `task-lifecycle` owns Beads correlation, execution leases, task-aware wrappers, and the pre-dispatch raw-pool guard.
- Beads 1.1.2 `--set-metadata piLifecycle.phase=...` creates a literal top-level key. Every lifecycle mutation must read the complete metadata object, replace only `metadata.piLifecycle` in memory under the lifecycle lock, write the merged object with `--metadata`, and verify the result.
- No production behavior is written before its focused test fails for the expected missing behavior.
- No bulk task migration, production worktree release, package installation, merge, or push occurs in this plan.
- Commit subjects use the repository's imperative/present-tense style and remain under 50 characters.
- Before every commit, run `git diff --cached --name-only` and confirm only intended files are staged.

## Shared Interfaces

The lifecycle modules use these exact exported contracts throughout the plan:

```ts
export type LifecyclePhase =
  | "actionable"
  | "active"
  | "waiting"
  | "deferred"
  | "done";
export type WaitingKind = "dependency" | "check";
export type ArtifactKind =
  | "branch" | "commit" | "pull_request" | "document"
  | "dashboard" | "deployment" | "report" | "other";
export type ArtifactRole = "deliverable" | "evidence" | "supporting";
export type CheckKind = "github_pull_request" | "time" | "manual";
export type CheckState = "pending" | "satisfied" | "action_required" | "error";
export type DispositionKind = "completed" | "cancelled" | "superseded";

export interface ExecutionLease {
  sessionId: string;
  claimedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  resourceSnapshot: { observedAt: string; resourceIds: string[] };
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  uri: string;
  title: string;
  role: ArtifactRole;
  sourceArtifactIds: string[];
  producedAt: string;
  producedBySession?: string;
  supersededAt: string | null;
}

export interface LifecycleCheck {
  id: string;
  kind: CheckKind;
  targetArtifactIds: string[];
  predicate: Record<string, unknown>;
  onSatisfied: "close" | "actionable";
  wakeOn: string[];
  state: CheckState;
  createdAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lastObservation: string | null;
  errorCount: number;
}

export interface LifecycleTransition {
  operationId: string;
  type: string;
  at: string;
  from: LifecyclePhase;
  to: LifecyclePhase;
  sessionId?: string;
  reason?: string;
}

export interface WorktreeResource {
  id: string;
  kind: "worktree";
  repository: string;
  claimId: string;
  pathId: string;
  operationId: string;
  path: string | null;
  branch: string;
  branchArtifactId: string | null;
  acquiredAt: string | null;
  releasedAt: string | null;
  cleanupState: "acquiring" | "active" | "release_pending" | "released" | "needs_attention";
  lastObservation?: Record<string, unknown>;
}

export interface Disposition {
  kind: DispositionKind;
  reason: string;
  at: string;
  evidenceArtifactIds: string[];
  supersedingTaskId?: string;
}

export interface NativeDependency {
  id: string;
  status: LifecycleIssue["status"];
  dependencyType: string;
}

export interface LockOwner {
  pid: number;
  sessionId: string;
  host: string;
  started: number;
}

export interface Mutation {
  operationId: string;
  status: LifecycleIssue["status"];
  lifecycle: LifecycleMetadataV1;
}

export interface LifecycleMetadataV1 {
  version: 1;
  phase: LifecyclePhase;
  waiting: { kind: WaitingKind } | null;
  stateEnteredAt: string;
  lastProgressAt: string;
  execution: ExecutionLease | null;
  artifacts: Artifact[];
  activeCheck: LifecycleCheck | null;
  checkHistory: LifecycleCheck[];
  transitionHistory: LifecycleTransition[];
  resources: WorktreeResource[];
  disposition: Disposition | null;
}

export interface LifecycleIssue {
  id: string;
  title: string;
  status: "open" | "in_progress" | "blocked" | "deferred" | "closed";
  metadata: Record<string, unknown>;
  lifecycle: LifecycleMetadataV1 | null;
  dependencies: NativeDependency[];
}

export interface LifecycleStore {
  show(id: string): Promise<LifecycleIssue>;
  list(statuses: readonly LifecycleIssue["status"][]): Promise<LifecycleIssue[]>;
  readyIds(): Promise<ReadonlySet<string>>;
  mutate(
    id: string,
    owner: LockOwner,
    operation: (issue: LifecycleIssue) => Mutation,
  ): Promise<LifecycleIssue>;
  addBlocker(dependentId: string, blockerId: string): Promise<void>;
}

export interface WorktreePoolPort {
  list(repository?: string): Promise<PoolListing>;
  acquire(
    request: AcquireRequest,
    owner: OwnerIdentity,
    identity?: { claimId: string; pathId: string },
  ): Promise<AcquireResult>;
  release(repository: string, claimId: string, owner: OwnerIdentity): Promise<ReleaseResult>;
}
```

---

### Task 1: Move the thin worktree pool into personal core

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/manifest.test.mjs`
- Modify: `tests/package-load.test.ts`
- Create: `tests/expect.ts`
- Create: `extensions/shared/shell-command.ts`
- Create: `extensions/shared/shell-command.test.ts`
- Create: `extensions/worktree-pool/*.ts`
- Create: `extensions/worktree-pool/config.json`

**Interfaces:**
- Consumes: the reviewed worktree-pool implementation at `experimental@a51892dd128cc08bb2cc922077f5a8c44e3df06d:users/jp.riveraruiz/pi-config/agent/extensions/worktree-pool/`.
- Produces: package resource `./extensions/worktree-pool/index.ts` and the unchanged raw `worktree_pool` tool.

- [x] **Step 1: Add failing package-manifest and source-boundary tests**

Add to `tests/manifest.test.mjs`:

```js
assert.ok(
  pkg.pi.extensions.includes("./extensions/worktree-pool/index.ts"),
  "personal core must own the worktree pool",
);
assert.ok(
  existsSync(join(root, "extensions/worktree-pool/pool.ts")),
  "worktree pool core must ship with personal core",
);
const poolSource = existsSync(join(root, "extensions/worktree-pool"))
  ? readdirSync(join(root, "extensions/worktree-pool"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(root, "extensions/worktree-pool", name), "utf8"))
      .join("\n")
  : "";
for (const forbidden of ["piLifecycle", "LifecycleIssue", "taskId", "BEADS_DIR", '"bd"']) {
  assert.ok(!poolSource.includes(forbidden), `pool source contains task concern ${forbidden}`);
}
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/manifest.test.mjs`

Expected: FAIL because `./extensions/worktree-pool/index.ts` is absent from the package manifest.

- [x] **Step 3: Copy the reviewed pool and register it**

Copy every tracked file from the source directory into `extensions/worktree-pool/`, preserving filenames and tests. Copy its task-agnostic `extensions/shared/shell-command.ts` dependency and test. Adapt Bun-only test imports and `import.meta.path` to the package's Node 22/`tsx --test` conventions through `tests/expect.ts`; do not add Bun as a second runtime. Add `./extensions/worktree-pool/index.ts` to `package.json#pi.extensions` immediately before `jp-workflow`. Do not import Beads or task lifecycle code.

Add to `README.md`:

```md
## Worktree pool

The package includes a bounded, conservative worktree allocator. Its core knows
only repositories, branches, Git registrations, opaque claims, capacity, and
clean release. Task ownership and lifecycle policy live in the separate
`task-lifecycle` extension.
```

- [x] **Step 4: Run destination pool and manifest tests**

Run:

```bash
npm run test:file -- extensions/shared/shell-command.test.ts extensions/worktree-pool/*.test.ts
node --test tests/manifest.test.mjs
```

Expected: all migrated tests and manifest tests PASS.

- [x] **Step 5: Commit the pool migration**

```bash
git add package.json README.md tests/manifest.test.mjs tests/package-load.test.ts tests/expect.ts extensions/shared extensions/worktree-pool docs/superpowers/plans/2026-09-17-task-lifecycle-automation.md
git diff --cached --name-only
git commit -m "move worktree pool into personal core"
```

---

### Task 2: Add task-agnostic pool coordination seams

**Files:**
- Modify: `extensions/worktree-pool/pool.ts`
- Modify: `extensions/worktree-pool/pool.test.ts`
- Modify: `extensions/worktree-pool/index.ts`
- Create: `extensions/worktree-pool/runtime.ts`
- Create: `extensions/worktree-pool/runtime.test.ts`
- Create: `lib/file-operation-lock.ts`
- Create: `tests/file-operation-lock.test.ts`
- Modify: `extensions/worktree-pool/operation-lock.ts`
- Modify: `extensions/worktree-pool/operation-lock.test.ts`

**Interfaces:**
- Produces: `WorktreePool.acquire(request, owner, identity?)`, complete read-only pool observations, `loadWorktreePoolRuntime()`, and generic `withFileOperationLock()`.
- Preserves: raw tool schema; callers cannot supply claim/path IDs through `worktree_pool`.

- [x] **Step 1: Write failing deterministic-identity and observation tests**

Add focused tests proving:

```ts
const acquired = await pool.acquire(request, owner, {
  claimId: "claim-fixed",
  pathId: "path-fixed",
});
assert.equal(acquired.claimId, "claim-fixed");
assert.match(acquired.path, /worktree-path-fixed$/);

const [listed] = (await pool.list("repo")).repositories[0].worktrees;
assert.equal(listed.currentBranch, "topic");
assert.equal(listed.head, "a".repeat(40));
assert.equal(listed.clean, true);
```

Also assert that `index.ts` tool parameters do not expose `claimId` for acquire or `pathId` at all.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test:file -- extensions/worktree-pool/pool.test.ts extensions/worktree-pool/index.test.ts
```

Expected: FAIL because injected acquisition identity and complete observations do not exist.

- [x] **Step 3: Implement the task-agnostic seams**

Change the pool signature exactly to:

```ts
async acquire(
  request: AcquireRequest,
  owner: OwnerIdentity,
  identity: { claimId: string; pathId: string } = {
    claimId: this.uuid(),
    pathId: this.uuid(),
  },
): Promise<AcquireResult>
```

Validate each supplied identity as a safe opaque component before creating paths or lease records. Add `currentBranch`, `head`, `clean`, and `branchProtectsHead` to `PoolWorktreeListing`; populate them from the existing read-only observation path.

Move production runtime construction from `index.ts` into:

```ts
export interface WorktreePoolRuntime {
  root: string;
  pool: WorktreePool;
  repositories: ResolvedRepository[];
}
export async function loadWorktreePoolRuntime(
  repositoryIdentifiers: string[],
  purpose: "identity" | "acquire",
): Promise<WorktreePoolRuntime>;
export function currentOwner(sessionId: string): OwnerIdentity;
```

`index.ts` calls these functions and retains the raw tool behavior.

- [x] **Step 4: Write a failing generic lock-root test**

Create `tests/file-operation-lock.test.ts` proving two calls against the same explicit lock root serialize and dead local owners are reclaimed, while unreadable or remote-owner records fail closed.

- [x] **Step 5: Run the lock test and verify RED**

Run: `npm run test:file -- tests/file-operation-lock.test.ts`

Expected: FAIL because `lib/file-operation-lock.ts` does not exist.

- [x] **Step 6: Extract the generic file lock**

Move the lock-container implementation into:

```ts
export async function withFileOperationLock<T>(
  lockRoot: string,
  owner: LockOwner,
  operation: () => Promise<T>,
  dependencies: FileOperationLockDependencies,
): Promise<T>;
```

Keep `extensions/worktree-pool/operation-lock.ts` as a thin wrapper that passes `join(repository.commonDir, "pi-worktree-pool")`. The generic module must not import worktree, Beads, or lifecycle types.

- [x] **Step 7: Run all pool and lock tests**

Run:

```bash
npm run test:file -- tests/file-operation-lock.test.ts extensions/worktree-pool/*.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit the pool seams**

```bash
git add lib/file-operation-lock.ts tests/file-operation-lock.test.ts extensions/worktree-pool
git diff --cached --name-only
git commit -m "add task-agnostic pool seams"
```

---

### Task 3: Implement and validate the lifecycle model

**Files:**
- Create: `lib/task-lifecycle/types.ts`
- Create: `lib/task-lifecycle/model.ts`
- Create: `lib/task-lifecycle/model.test.ts`

**Interfaces:**
- Produces: all shared lifecycle types, `decodeLifecycle()`, `adoptLegacyLifecycle()`, `validateLifecycle()`, `canonicalizeArtifact()`, `attachArtifact()`, and pure transition helpers.
- Consumes: no filesystem, CLI, network, or Pi API.

- [ ] **Step 1: Write failing decoder and invariant tests**

Cover exact behaviors:

```ts
assert.deepEqual(decodeLifecycle(validRaw), { ok: true, value: validLifecycle });
assert.deepEqual(decodeLifecycle({ version: 2 }), {
  ok: false,
  warning: "unsupported piLifecycle version 2",
});
assert.throws(
  () => validateLifecycle({ ...active, execution: null }, activeIssue),
  /phase active requires one execution lease/,
);
assert.throws(
  () => validateLifecycle({ ...dependencyWait, activeCheck: check }, issue),
  /dependency wait must not have an active check/,
);
```

Include every phase/status projection, waiting subtype, disposition, duplicate resource pair, unknown enum, and malformed timestamp.

- [ ] **Step 2: Run model tests and verify RED**

Run: `npm run test:file -- lib/task-lifecycle/model.test.ts`

Expected: FAIL because the model modules do not exist.

- [ ] **Step 3: Implement strict decoding and legacy adoption**

Implement discriminated decoders without coercing unknown data. `decodeLifecycle()` preserves the caller's raw metadata outside `piLifecycle` and returns a warning rather than throwing for unsupported lifecycle data.

`adoptLegacyLifecycle(issue, readyIds, now)` maps:

```ts
status === "closed"      -> phase "done" only for read-only presentation
status === "deferred"    -> phase "deferred"
status === "blocked"     -> phase "waiting", kind "check", with a migration warning
status === "in_progress" -> phase "actionable", with an interrupted-ownership warning
status === "open" && unresolvedBlocks.length > 0 -> phase "waiting", kind "dependency"
status === "open" && readyIds.has(id) -> phase "actionable"
```

A lifecycle mutation writes a full version-1 object; read-only legacy classification does not mutate Beads.

- [ ] **Step 4: Implement artifacts and pure transitions**

Export:

```ts
export function canonicalizeArtifact(input: ArtifactInput, now: string, sessionId?: string): Artifact;
export function attachArtifact(state: LifecycleMetadataV1, artifact: Artifact): LifecycleMetadataV1;
export function claimLifecycle(state: LifecycleMetadataV1, input: ClaimInput): LifecycleMetadataV1;
export function waitLifecycle(state: LifecycleMetadataV1, input: WaitInput): LifecycleMetadataV1;
export function closeLifecycle(state: LifecycleMetadataV1, input: CloseInput): LifecycleMetadataV1;
export function reopenLifecycle(state: LifecycleMetadataV1, input: ReopenInput): LifecycleMetadataV1;
export function interruptLifecycle(state: LifecycleMetadataV1, input: InterruptInput): LifecycleMetadataV1;
```

Deduplicate artifacts by canonical `(kind, uri)`, transitions by `operationId`, and resources by ID plus canonical repository/full-branch pair. Poll observations change `lastCheckedAt` but not `stateEnteredAt` or `lastProgressAt` unless the outcome changes.

- [ ] **Step 5: Run model tests and verify GREEN**

Run: `npm run test:file -- lib/task-lifecycle/model.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the model**

```bash
git add lib/task-lifecycle/types.ts lib/task-lifecycle/model.ts lib/task-lifecycle/model.test.ts
git diff --cached --name-only
git commit -m "add task lifecycle model"
```

---

### Task 4: Add the locked Beads lifecycle store

**Files:**
- Create: `lib/task-lifecycle/beads-store.ts`
- Create: `lib/task-lifecycle/beads-store.test.ts`
- Create: `scripts/check-beads-lifecycle-compat.mjs`

**Interfaces:**
- Consumes: `withFileOperationLock()` and lifecycle decoders.
- Produces: `createLifecycleStore(exec, options): LifecycleStore`.

- [ ] **Step 1: Write failing store tests**

Use a fake executor to assert exact commands and ordering:

```ts
assert.deepEqual(calls, [
  ["bd", ["show", "jp-1", "--long", "--json", "--db", store]],
  ["bd", ["update", "jp-1", "-s", "in_progress", "--metadata", mergedJson, "--json", "--db", store]],
  ["bd", ["show", "jp-1", "--long", "--json", "--db", store]],
]);
assert.deepEqual(JSON.parse(mergedJson).unrelated, { keep: true });
assert.ok(!Object.hasOwn(JSON.parse(mergedJson), "piLifecycle.phase"));
```

Also test native dependency decoding, `bd dep add <dependent> <blocker> --type blocks`, malformed JSON, nonzero exits, verification mismatch, and concurrent mutations serialized by one store lock.

- [ ] **Step 2: Run store tests and verify RED**

Run: `npm run test:file -- lib/task-lifecycle/beads-store.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement the store adapter**

Every `mutate()` call:

1. acquires `withFileOperationLock(join(store, "pi-task-lifecycle"), owner, ...)`;
2. runs `bd show <id> --long --json`;
3. decodes metadata and native dependencies;
4. applies the pure mutation;
5. writes native status and the complete merged metadata in one `bd update` call;
6. re-reads and verifies phase, status, execution, artifact/resource IDs, and operation ID.

Command failures expose operation, issue ID, store, and exit code, but never raw task content from stdout/stderr.

- [ ] **Step 4: Encode the live compatibility probe**

`scripts/check-beads-lifecycle-compat.mjs` creates a temporary Dolt store with `BEADS_DIR` and `BEADS_DB` removed, verifies create/show/update/list round trips, proves dotted `--set-metadata` is unsafe, and removes the exact temporary directory in `finally`.

Expected summary fields:

```text
bd_version=bd version 1.1.2 (Homebrew)
nested_set_supported=false
full_metadata_roundtrip=true
show_long_includes_metadata=true
list_includes_metadata=true
temporary_store_removed=true
```

- [ ] **Step 5: Run unit and compatibility tests**

Run:

```bash
npm run test:file -- lib/task-lifecycle/beads-store.test.ts
node scripts/check-beads-lifecycle-compat.mjs
```

Expected: PASS with the six compatibility fields above.

- [ ] **Step 6: Commit the store adapter**

```bash
git add lib/task-lifecycle/beads-store.ts lib/task-lifecycle/beads-store.test.ts scripts/check-beads-lifecycle-compat.mjs
git diff --cached --name-only
git commit -m "add locked lifecycle store"
```

---

### Task 5: Implement lifecycle operations and tools

**Files:**
- Create: `lib/task-lifecycle/service.ts`
- Create: `lib/task-lifecycle/service.test.ts`
- Create: `extensions/task-lifecycle/index.ts`
- Create: `extensions/task-lifecycle/index.test.ts`
- Create: `extensions/task-lifecycle/config.json`
- Create: `extensions/task-lifecycle/README.md`
- Modify: `package.json`
- Modify: `tests/manifest.test.mjs`

**Interfaces:**
- Produces: `TaskLifecycleService` and tools `task_claim`, `task_attach_artifact`, `task_wait`, `task_reconcile`, `task_close`, and `task_reopen`.
- Worktree methods exist on the service interface but are implemented in Task 6.

- [ ] **Step 1: Write failing service tests for core operations**

Cover:

```ts
await service.claim("jp-1", session("s1"));
assert.equal(saved.lifecycle.phase, "active");
assert.equal(saved.status, "in_progress");
assert.equal(saved.lifecycle.execution?.sessionId, "s1");

await assert.rejects(
  service.claim("jp-1", session("s2")),
  /owned by active session s1/,
);

await service.waitForDependencies("jp-1", ["jp-blocker"], session("s1"));
assert.equal(saved.status, "open");
assert.deepEqual(saved.lifecycle.waiting, { kind: "dependency" });
assert.equal(saved.lifecycle.activeCheck, null);
```

Also test check wait, close dispositions, reopen, artifact deduplication, execution timeout, idempotent operation IDs, release failure leaving phase active, and blocker IDs absent from metadata.

- [ ] **Step 2: Run service tests and verify RED**

Run: `npm run test:file -- lib/task-lifecycle/service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service core**

Constructor:

```ts
export class TaskLifecycleService {
  constructor(private readonly deps: {
    store: LifecycleStore;
    now: () => number;
    uuid: () => string;
    executionTimeoutMs: number;
    pool?: WorktreePoolPort;
    checkAdapters?: CheckAdapterRegistry;
  }) {}
}
```

Methods require current execution ownership for active mutations. `claim()` reconciles retained resource observations first, records the complete resource snapshot, and permits claim for resource repair even when an association is unresolved. `wait()` and `close()` release every active resource before changing phase; any refusal leaves phase and lease active.

- [ ] **Step 4: Write failing extension registration tests**

The harness records tools and handlers. Assert exact strict schemas, tool descriptions, `session_start`, `session_shutdown`, `turn_start`, and `tool_call` registration. Assert headless contexts never call TUI-only methods.

- [ ] **Step 5: Run extension tests and verify RED**

Run: `npm run test:file -- extensions/task-lifecycle/index.test.ts`

Expected: FAIL because the extension does not exist.

- [ ] **Step 6: Register the extension and core tools**

Add `./extensions/task-lifecycle/index.ts` to `package.json#pi.extensions` after `worktree-pool` and before `jp-workflow`. Load this exact config:

```json
{
  "version": 1,
  "executionTimeoutMs": 21600000,
  "activityWriteIntervalMs": 300000,
  "sessionReconcileLimit": 10,
  "sessionPrCheckLimit": 5,
  "prPollIntervalMs": 900000,
  "maxBackoffMs": 21600000,
  "warningErrorCount": 3
}
```

Tool schemas reject unknown fields and empty IDs/reasons. Tool results return a compact task summary in `content` and the full normalized lifecycle issue in `details`.

- [ ] **Step 7: Run extension, service, and manifest tests**

Run:

```bash
npm run test:file -- lib/task-lifecycle/service.test.ts extensions/task-lifecycle/index.test.ts tests/manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit lifecycle operations**

```bash
git add package.json tests/manifest.test.mjs lib/task-lifecycle/service.ts lib/task-lifecycle/service.test.ts extensions/task-lifecycle
git diff --cached --name-only
git commit -m "add lifecycle operations"
```

---

### Task 6: Add coordinated task-worktree operations

**Files:**
- Modify: `lib/task-lifecycle/types.ts`
- Modify: `lib/task-lifecycle/model.ts`
- Modify: `lib/task-lifecycle/model.test.ts`
- Modify: `lib/task-lifecycle/service.ts`
- Modify: `lib/task-lifecycle/service.test.ts`
- Modify: `extensions/task-lifecycle/index.ts`
- Modify: `extensions/task-lifecycle/index.test.ts`

**Interfaces:**
- Produces: `task_worktree_acquire(taskId, repository, branch, startPoint?)`, `task_worktree_release(taskId, claimId)`, resource reconciliation, and raw-pool pre-dispatch guard.
- Consumes: deterministic pool identity and complete pool observations from Task 2.

- [ ] **Step 1: Write failing pending-acquire tests**

Test exact sequence:

```ts
const operationId = "tool-call-1";
const result = await service.acquireWorktree(
  { taskId: "jp-1", repository: "repo", branch: "jpriverar/topic" },
  session("s1"),
  operationId,
);
assert.equal(pool.acquireCalls[0].identity.claimId, pending.claimId);
assert.equal(result.lifecycle.resources[0].cleanupState, "active");
assert.equal(result.lifecycle.resources[0].branchArtifactId, result.lifecycle.artifacts[0].id);
```

Cover pool-success/finalization-failure, retry without duplicate allocation, reconciliation by exact claim ID, duplicate repository/full-branch rejection, multiple distinct healthy resources, dirty current resources allowing another acquire, and malformed/ambiguous associations blocking acquire.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run test:file -- lib/task-lifecycle/model.test.ts lib/task-lifecycle/service.test.ts
```

Expected: FAIL because worktree methods and pending resource states are absent.

- [ ] **Step 3: Implement acquire, release, and reconciliation**

`acquireWorktree()` persists an `acquiring` resource with preselected `claimId` and `pathId`, releases the lifecycle lock, calls the pool, then finalizes the exact resource. `releaseWorktree()` persists `release_pending`, calls the pool, and records `releasedAt` only after success. Reconciliation uses exact claim ID first and never guesses across branch-only matches.

- [ ] **Step 4: Write failing raw-tool guard tests**

Assert:

```ts
assert.deepEqual(await emit("tool_call", {
  toolName: "worktree_pool",
  input: { action: "acquire", repository: "repo", branch: "topic" },
}), {
  block: true,
  reason: expect.stringContaining("task_worktree_acquire"),
});
```

Raw `list` and `repair` always pass. Raw acquire passes with no Active lifecycle task. Raw release passes for an unassociated claim and is blocked for any claim linked to lifecycle metadata. The pool tool receives no call when blocked.

- [ ] **Step 5: Register wrapper tools and guard**

Use the `tool_call` handler in `task-lifecycle/index.ts`; do not modify `worktree-pool/index.ts` with Beads checks. Load the pool through `loadWorktreePoolRuntime()` and pass only repository, branch, start point, opaque IDs, and owner identity.

- [ ] **Step 6: Run lifecycle and pool boundary tests**

Run:

```bash
npm run test:file -- extensions/task-lifecycle/*.test.ts lib/task-lifecycle/*.test.ts extensions/worktree-pool/*.test.ts tests/manifest.test.mjs
```

Expected: PASS, including a source scan proving the pool contains no task concern.

- [ ] **Step 7: Commit worktree coordination**

```bash
git add lib/task-lifecycle extensions/task-lifecycle extensions/worktree-pool tests/manifest.test.mjs
git diff --cached --name-only
git commit -m "coordinate task worktrees"
```

---

### Task 7: Implement deterministic checks and reconciliation hooks

**Files:**
- Create: `lib/task-lifecycle/checks.ts`
- Create: `lib/task-lifecycle/checks.test.ts`
- Modify: `lib/task-lifecycle/service.ts`
- Modify: `lib/task-lifecycle/service.test.ts`
- Modify: `extensions/task-lifecycle/index.ts`
- Modify: `extensions/task-lifecycle/index.test.ts`

**Interfaces:**
- Produces: `CheckAdapter`, `createCheckAdapterRegistry()`, GitHub PR/time/manual adapters, bounded `reconcileDue()`, and lifecycle session/activity hooks.

- [ ] **Step 1: Write failing adapter tests**

Use fake `gh` results to cover `open`, `merged`, `changes_requested`, `merge_conflict`, and `closed_unmerged`. Cover two-PR `all merged`, `any`, time due/not-due, manual overdue, and bounded exponential backoff:

```ts
assert.deepEqual(await registry.observe(twoPrAllMerged), {
  outcome: "pending",
  observation: "1/2 merged",
});
assert.deepEqual(await registry.observe(changesRequested), {
  outcome: "action_required",
  observation: "changes_requested",
});
```

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `npm run test:file -- lib/task-lifecycle/checks.test.ts`

Expected: FAIL because check adapters do not exist.

- [ ] **Step 3: Implement the adapters**

GitHub PR checks call:

```bash
gh pr view <canonical-url> --json state,reviewDecision,mergeStateStatus,mergedAt
```

`mergedAt != null` is satisfied; `CHANGES_REQUESTED`, `DIRTY`, and closed without merge are action required; all other open states are pending. Time checks compare one RFC3339 `at` timestamp. Manual checks do not invent an observation; after `reviewAt` they remain waiting with an overdue warning until explicit `task_reconcile` input records `satisfied` or `action_required`.

- [ ] **Step 4: Write failing reconciliation and hook tests**

Cover:

- native final blocker resolution -> actionable exactly once;
- due PR merged -> done exactly once;
- action required -> actionable exactly once;
- polling updates only check timestamps;
- timeout -> one `execution_interrupted` transition;
- repeated adapter error -> backoff and warning;
- `session_start` processes at most configured limits;
- `before_agent_start` performs zero `gh` calls;
- `session_shutdown` interrupts on quit/new/resume/fork but preserves on reload;
- activity refresh is rate-limited and a long-running tool remains live.

- [ ] **Step 5: Implement reconciliation and hooks**

`session_start` invokes bounded reconciliation and returns; it creates no timer, watcher, or background process. `turn_start` and `tool_execution_start/end` refresh ownership no more often than `activityWriteIntervalMs`. `session_shutdown` awaits interruption persistence before returning.

- [ ] **Step 6: Run all lifecycle tests**

Run:

```bash
npm run test:file -- lib/task-lifecycle/*.test.ts extensions/task-lifecycle/*.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit checks and reconciliation**

```bash
git add lib/task-lifecycle extensions/task-lifecycle
git diff --cached --name-only
git commit -m "reconcile lifecycle checks"
```

---

### Task 8: Make existing task views lifecycle-aware

**Files:**
- Modify: `lib/beads.ts`
- Modify: `tests/beads.test.ts`
- Modify: `extensions/jp-workflow/index.ts`
- Modify: `extensions/jp-workflow/index.test.ts`
- Modify: `extensions/tasks-overlay/index.ts`
- Modify: `extensions/tasks-overlay/index.test.ts`

**Interfaces:**
- Consumes: read-only lifecycle decoding from `lib/task-lifecycle/model.ts` and native dependency IDs from Beads.
- Produces: compact Active, Actionable, and Waiting presentation with inline warnings; no network calls.

- [ ] **Step 1: Write failing Beads classification tests**

Add cases proving:

```ts
assert.equal(classify(lifecycleWaitingDependency).readiness, "waiting");
assert.deepEqual(classify(lifecycleWaitingDependency).blockingTaskIds, ["jp-blocker"]);
assert.equal(classify(lifecycleActionableWithNativeBlocker).readiness, "waiting");
assert.match(classify(malformedLifecycle).warnings[0], /unsupported piLifecycle/);
```

`BeadsClient.listBlockingDependencies(id)` must execute `bd dep list <id> --json` and retain only unresolved `dependency_type === "blocks"` records.

- [ ] **Step 2: Run Beads tests and verify RED**

Run: `npm run test:file -- tests/beads.test.ts`

Expected: FAIL because lifecycle metadata and blocker details are not decoded.

- [ ] **Step 3: Extend read-only Beads classification**

Add lifecycle view fields to `BeadsIssue` and `ClassifiedIssue`. Lifecycle metadata controls presentation when valid; native readiness prevents a drifted `phase=actionable` issue with an unresolved blocker from appearing ready. Legacy issues retain current behavior plus migration warnings.

- [ ] **Step 4: Write failing workflow and overlay presentation tests**

Assert exact visible and hidden sections:

```text
ACTIVE
ACTIONABLE
WAITING
jp-654 Roll out migration · blocked by jp-600 · waiting 1d
jp-789 Fix review issue · PR open · next check 14:00 · waiting 2d
```

Assert a dependency-waiting task appears exactly once and never under Ready/Open/Actionable. Assert overdue checks and retained-resource warnings are inline annotations, not separate lifecycle states. Assert the injected block contains only normalized untrusted task data.

- [ ] **Step 5: Implement lifecycle-aware rendering**

Keep network and pool reads out of `before_agent_start`. Native dependency IDs come from Beads. Pool observations are persisted by explicit lifecycle reconciliation and rendered as warnings from metadata. Reuse the same classified data for startup card, hidden injection, and `/tasks` overlay.

- [ ] **Step 6: Run all task-view tests**

Run:

```bash
npm run test:file -- tests/beads.test.ts extensions/jp-workflow/index.test.ts extensions/tasks-overlay/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit lifecycle presentation**

```bash
git add lib/beads.ts tests/beads.test.ts extensions/jp-workflow extensions/tasks-overlay
git diff --cached --name-only
git commit -m "show explicit task lifecycles"
```

---

### Task 9: Verify one-repository integration and document rollout

**Files:**
- Modify: `README.md`
- Create: `docs/task-lifecycle.md`
- Create: `scripts/report-lifecycle-migration.mjs`
- Create: `tests/task-lifecycle-integration.test.ts`

**Interfaces:**
- Produces: temporary-store integration evidence, read-only migration report, operator documentation, and final verification.
- Does not mutate JP's real task store or real worktree pool.

- [ ] **Step 1: Write a failing temporary integration test**

The test creates a temporary Dolt store and temporary Git repositories/pool, then performs:

```text
claim
acquire repo-a/branch-a
acquire repo-b/branch-b
attach PR A and PR B
release both claims
wait on all(PR A, PR B) merged
observe one merged -> remain waiting
observe both merged -> close once
reconcile again -> no duplicate transition
```

Also run dependency, time, manual, interruption, dirty retained-resource, and partial-acquire recovery flows. All fixtures are created below one test-owned temporary root and removed in `finally`.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `npm run test:file -- tests/task-lifecycle-integration.test.ts`

Expected: FAIL on the first missing integration contract, not on fixture setup.

- [ ] **Step 3: Complete only missing integration wiring**

Wire real `bd`, Git, and pool adapters through dependency injection. Do not add new lifecycle states, check kinds, or artifact inference. Keep every mutation inside the temporary root.

- [ ] **Step 4: Add the read-only migration reporter**

`scripts/report-lifecycle-migration.mjs` reads current Beads issues and pool listings and prints proposed mappings without calling `bd update`, `bd close`, pool release, Git mutation, or GitHub mutation. Include counts and issue IDs for legacy actionable, dependency-waiting, manually blocked, stale in-progress, deferred, done, and retained-resource candidates.

- [ ] **Step 5: Document operation and rollout boundaries**

`docs/task-lifecycle.md` covers:

- all tool schemas and examples;
- lifecycle/status/dependency mapping;
- artifact and resource identity;
- check polling and backoff;
- shutdown/timeout behavior;
- raw pool guard behavior;
- temporary-store smoke command;
- read-only migration report command;
- explicit prohibition on bulk migration or release without approval;
- the historical experimental pool copy is not authoritative and must not be edited as implementation source.

Update `README.md` resources and task-data sections to link the document.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node scripts/check-beads-lifecycle-compat.mjs
npm run test:file -- tests/task-lifecycle-integration.test.ts
npm test
npm run typecheck
npm run format:check
npm run verify:portable
git diff --check
```

Expected: every command exits 0; full tests report zero failures; compatibility reports nested dotted set unsupported and full metadata round-trip supported.

- [ ] **Step 7: Commit integration and docs**

```bash
git add README.md docs/task-lifecycle.md scripts/report-lifecycle-migration.mjs tests/task-lifecycle-integration.test.ts
git diff --cached --name-only
git commit -m "verify task lifecycle integration"
```

- [ ] **Step 8: Record implementation evidence**

Record commit range, exact verification commands, pass counts, compatibility output, and the read-only migration-report path in Beads task `jp-mkt4`. Do not install, push, merge, migrate tasks, or release production worktrees without JP's next explicit decision.
