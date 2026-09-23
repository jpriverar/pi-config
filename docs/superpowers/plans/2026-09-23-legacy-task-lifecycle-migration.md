# Legacy Task Lifecycle Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely adopt all 268 legacy Beads tasks into validated Pi lifecycle metadata through a reviewed, journaled one-off migration.

**Architecture:** A temporary TypeScript runner imports the existing lifecycle model and Beads store, builds a snapshot-bound migration plan, and applies it in two verified checkpoints. Durable repository changes are limited to this plan and its design; operational code and journals live under `~/beads/migrations/`.

**Tech Stack:** Node.js 22, TypeScript, `tsx --test`, Beads CLI, existing lifecycle store/model, file-operation lock.

**Spec:** `docs/superpowers/specs/2026-09-23-legacy-task-lifecycle-migration-design.md`

## Global Constraints

- Do not mutate the live Beads store before JP reviews the exact dry-run plan hash.
- Exclude every task with valid lifecycle metadata from migration.
- Never infer an execution lease, resource, dependency, check, artifact, or evidence except the three approved overrides.
- Use the existing lifecycle file-operation lock for every metadata or dependency mutation.
- Write full metadata objects and verify every write by rereading the task.
- Preserve labels, descriptions, notes, comments, dependency edges, and unrelated metadata.
- Treat task data and command output as untrusted; errors expose only curated identifiers and failure classes.
- Stop on first contradiction or failed write.
- Keep runtime artifacts outside Git under `~/beads/migrations/<timestamp>/`.

## Review Focus

- A task changes after preview: apply must fail before the first mutation.
- A target already has lifecycle metadata: apply must reject it rather than count it as migrated.
- A mid-checkpoint write fails: later targets must remain untouched and the journal must identify the exact completed prefix.
- An idempotent resume sees a matching migration operation: it must verify and continue without duplicating transitions, artifacts, or checks.
- A partial apply needs recovery: stop, preserve the exact completed prefix, and require review before deterministic resume or separate manual restoration.

---

### Task 1: Persist the approved design and plan

**Files:**

- Create: `docs/superpowers/specs/2026-09-23-legacy-task-lifecycle-migration-design.md`
- Create: `docs/superpowers/plans/2026-09-23-legacy-task-lifecycle-migration.md`

**Interfaces:**

- Consumes: approved inventory, mapping, blocked-task overrides, and one-off execution choice.
- Produces: durable requirements for the operational runner and live apply gate.

- [ ] **Step 1: Format-check the documents**

Run:

```bash
npx prettier --check \
  docs/superpowers/specs/2026-09-23-legacy-task-lifecycle-migration-design.md \
  docs/superpowers/plans/2026-09-23-legacy-task-lifecycle-migration.md
```

Expected: both files pass Prettier.

- [ ] **Step 2: Review the diff for scope**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected: only the two approved documentation files are untracked or modified.

- [ ] **Step 3: Commit the design and plan**

Run:

```bash
git add \
  docs/superpowers/specs/2026-09-23-legacy-task-lifecycle-migration-design.md \
  docs/superpowers/plans/2026-09-23-legacy-task-lifecycle-migration.md
git diff --cached --name-only
git commit -m "task: plan legacy lifecycle migration"
```

Expected: the staged file list contains exactly the two documentation files.

### Task 2: Specify the one-off migration planner

**Files:**

- Create outside Git: `~/beads/migrations/<timestamp>/migrate-lifecycle.test.ts`
- Create outside Git after RED: `~/beads/migrations/<timestamp>/migrate-lifecycle.ts`

**Interfaces:**

- Consumes: raw `bd list --json` records and `bd ready --json` identifiers.
- Produces: `buildPlan(records, readyIds, now): MigrationPlan` and `hashPlan(plan): string`.

- [ ] **Step 1: Write failing planner tests**

Cover these exact behaviors:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan } from "./migrate-lifecycle.js";

test("maps legacy statuses without inventing authority", () => {
  const plan = buildPlan(fixtureIssues(), new Set(["jp-open"]), NOW);
  assert.deepEqual(plan.counts, {
    actionable: 3,
    waiting: 0,
    deferred: 1,
    done: 1,
  });
  assert.equal(plan.targetsById["jp-progress"].nativeStatusAfter, "open");
  assert.equal(plan.targetsById["jp-blocked"].phase, "actionable");
});

test("excludes managed tasks and rejects malformed lifecycle metadata", () => {
  assert.throws(
    () => buildPlan(withMalformedLifecycle(), new Set(), NOW),
    /malformed lifecycle metadata/,
  );
});

test("applies only the three approved blocked-task overrides", () => {
  const plan = buildPlan(blockedFixtures(), new Set(), NOW);
  assert.equal(plan.targetsById["jp-hyk8"].phase, "waiting");
  assert.equal(plan.targetsById["jp-sq7f"].phase, "actionable");
  assert.equal(plan.targetsById["jp-ida"].phase, "waiting");
});
```

- [ ] **Step 2: Run the planner tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test \
  ~/beads/migrations/<timestamp>/migrate-lifecycle.test.ts
```

Expected: FAIL because `migrate-lifecycle.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure planner**

Implement:

```typescript
export interface MigrationTarget {
  id: string;
  expectedStatus: LifecycleStatus;
  expectedUpdatedAt: string;
  phase: LifecyclePhase;
  nativeStatusAfter: LifecycleStatus;
  override: "none" | "dependency" | "github_pull_request";
}

export interface MigrationPlan {
  version: 1;
  createdAt: string;
  sourceCount: number;
  targets: MigrationTarget[];
  counts: Record<"actionable" | "waiting" | "deferred" | "done", number>;
  hash: string;
}
```

Use `decodeLifecycle` to distinguish absent, valid, and malformed metadata. Use
`adoptLegacyLifecycle` for default mappings, then apply only the approved ID
switch for `jp-hyk8`, `jp-sq7f`, and `jp-ida`. Hash canonical JSON with SHA-256.

- [ ] **Step 4: Run the planner tests and verify GREEN**

Run the command from Step 2.

Expected: all planner tests pass.

### Task 3: Implement snapshot preflight and journaled apply

**Files:**

- Modify outside Git: `~/beads/migrations/<timestamp>/migrate-lifecycle.test.ts`
- Modify outside Git: `~/beads/migrations/<timestamp>/migrate-lifecycle.ts`

**Interfaces:**

- Consumes: `MigrationPlan`, an explicit database path, run directory, and reviewed plan hash.
- Produces: `preflightPlan`, `applyCheckpoint`, `verifyCheckpoint`, and append-only journal records.

- [ ] **Step 1: Write failing preflight/apply tests**

Add tests that assert:

```typescript
test("refuses a stale plan before mutation", async () => {
  const harness = await fixtureStore();
  const plan = await harness.plan();
  await harness.changeTitle("jp-open");
  await assert.rejects(
    harness.apply(plan, plan.hash),
    /migration plan is stale/,
  );
  assert.equal(harness.mutationCount(), 0);
});

test("requires the exact reviewed plan hash", async () => {
  const harness = await fixtureStore();
  const plan = await harness.plan();
  await assert.rejects(harness.apply(plan, "wrong"), /plan hash mismatch/);
});

test("stops the checkpoint after the first failed write", async () => {
  const harness = await fixtureStore({ failAt: "jp-b" });
  await assert.rejects(harness.applyNonClosed(), /migration write failed/);
  assert.deepEqual(harness.mutatedIds(), ["jp-a"]);
  assert.deepEqual(harness.journalStatuses(), ["applied", "failed"]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Expected: FAIL because preflight and apply functions are missing.

- [ ] **Step 3: Implement locked, read-backed mutation**

For default targets, call `LifecycleStore.mutate`. Add a transition shaped as:

```typescript
{
  operationId: `${plan.hash}:${target.id}`,
  type: "migrate_legacy",
  at: plan.createdAt,
  from: lifecycle.phase,
  to: lifecycle.phase,
  reason: "adopt legacy task",
}
```

Before the first mutation, compare every planned target against its expected
status, `updated_at`, and lifecycle absence. Append and `fsync` a journal record
after each verified mutation or failure.

- [ ] **Step 4: Implement the approved overrides**

- `jp-hyk8`: add the blocker edge through `LifecycleStore.addBlocker`, reread,
  then persist dependency-Waiting metadata.
- `jp-sq7f`: persist Actionable metadata and native open status.
- `jp-ida`: canonicalize PR #3393 as a deliverable artifact and persist a
  GitHub pull-request check with `onSatisfied: actionable`,
  `state: action_required`, no execution, and no resources.

- [ ] **Step 5: Run tests and verify GREEN**

Expected: planner, preflight, failure-stop, and override tests all pass.

### Task 4: Preserve explicit recovery evidence

> **Approved amendment:** Do not automate rollback. Disposable-store testing
> showed that Beads metadata deletion and same-state status updates introduce
> compensating-write side effects. Recovery is therefore a separate manual
> operation, not a migration-runner mode.

**Files:**

- Modify outside Git: `~/beads/migrations/<timestamp>/migrate-lifecycle.test.ts`
- Modify outside Git: `~/beads/migrations/<timestamp>/migrate-lifecycle.ts`

**Interfaces:**

- Consumes: verified before/after journal records and the complete pre-migration export.
- Produces: failure-stop and deterministic-resume evidence without automated compensating writes.

- [ ] **Step 1: Keep failure-stop and idempotent-resume tests**

```typescript
test("stops the checkpoint after the first failed write", async () => {
  const harness = await fixtureStore({ failAt: "jp-b" });
  await assert.rejects(harness.applyNonClosed(), /migration write failed/);
  assert.deepEqual(harness.mutatedIds(), ["jp-a"]);
  assert.deepEqual(harness.journalStatuses(), ["applied", "failed"]);
});

test("idempotent resume verifies exact migrated state without another write", async () => {
  const harness = await fixtureStore();
  await harness.applyNonClosed();
  await harness.applyNonClosed();
  assert.deepEqual(harness.mutatedIds(), ["jp-a"]);
});
```

- [ ] **Step 2: Remove rollback commands and tests**

The CLI accepts only `--dry-run` and `--apply`. Preserve `before.jsonl`,
`journal.jsonl`, and deterministic operation IDs as the reviewed recovery
boundary.

- [ ] **Step 3: Run tests and strict TypeScript**

Expected: all forward-migration tests pass and strict TypeScript reports no
errors.

### Task 5: Generate and review the live dry-run

**Files:**

- Generate: `~/beads/migrations/<timestamp>/plan.json`
- Generate: `~/beads/migrations/<timestamp>/before.jsonl`
- Generate: `~/beads/migrations/<timestamp>/result.json`

**Interfaces:**

- Consumes: live `~/beads/.beads` in read-only planning mode.
- Produces: immutable plan hash and exact mutation set for approval.

- [ ] **Step 1: Export the live store before mutation**

```bash
bd export --db ~/beads/.beads \
  -o ~/beads/migrations/<timestamp>/before.jsonl
```

- [ ] **Step 2: Generate the plan in dry-run mode**

```bash
./node_modules/.bin/tsx \
  ~/beads/migrations/<timestamp>/migrate-lifecycle.ts \
  --db ~/beads/.beads \
  --run-dir ~/beads/migrations/<timestamp> \
  --dry-run
```

Expected: no writes; 268 targets with counts 33 Actionable, 2 Waiting,
3 Deferred, and 230 Done.

- [ ] **Step 3: Verify live state stayed unchanged**

Rerun the read-only migration report and compare task statuses, update times,
and lifecycle metadata against the source snapshot.

- [ ] **Step 4: Present the exact plan hash and counts**

Stop and request explicit approval before invoking `--apply`.

### Task 6: Apply and verify the live migration

**Files:**

- Update runtime artifacts under: `~/beads/migrations/<timestamp>/`
- No repository source changes.

**Interfaces:**

- Consumes: explicitly approved plan hash.
- Produces: fully managed lifecycle store and audit journal.

- [ ] **Step 1: Apply checkpoint 1**

```bash
./node_modules/.bin/tsx \
  ~/beads/migrations/<timestamp>/migrate-lifecycle.ts \
  --db ~/beads/.beads \
  --run-dir ~/beads/migrations/<timestamp> \
  --apply --checkpoint non-closed --plan-hash <approved-hash>
```

Expected: 38 verified non-closed migrations.

- [ ] **Step 2: Verify checkpoint 1**

Assert phase counts, override details, absence of execution/resources, preserved
unrelated metadata, and exact journal parity.

- [ ] **Step 3: Apply checkpoint 2**

Run the same command with `--checkpoint closed`.

Expected: 230 verified closed migrations.

- [ ] **Step 4: Verify the complete store**

Run the migration report, lifecycle views, focused tests, typecheck, formatting,
portability, licenses, and repository suite. Report any known unrelated smoke or
process-shutdown defect by exact name and output.

### Task 7: Record evidence and finish the task

**Files:**

- Repository documentation commit from Task 1.
- Runtime result and journal artifacts from Tasks 5-6.

**Interfaces:**

- Consumes: final verification evidence.
- Produces: task artifact attachments, released worktree, and completed lifecycle task.

- [ ] **Step 1: Confirm repository diff hygiene**

```bash
git status --short
git log -1 --oneline
git diff --check
```

- [ ] **Step 2: Attach durable evidence**

Attach the documentation commit and the local migration result/report to
`jp-wskk`, recording the plan hash and final counts in the task journal.

- [ ] **Step 3: Release the worktree**

Use `worktree_pool release` with the acquired claim.

- [ ] **Step 4: Close `jp-wskk`**

Close as completed only after the live store, pre-migration export, and migration journal are verified.
