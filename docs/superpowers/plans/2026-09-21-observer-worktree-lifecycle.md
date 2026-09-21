# Observer Worktree Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary worktree lifecycle coordination a pure task-lifecycle observer while preserving strict action validation and existing release cleanup.

**Architecture:** The task-lifecycle extension correlates `worktree_pool` calls and results in memory by `toolCallId`. Successful acquire receipts are validated against the pool and recorded on the Active task; no private arguments enter the worktree tool. The worktree tool independently removes empty provider placeholders before applying its existing action-specific validator.

**Tech Stack:** Node.js 22, TypeScript, NodeNext, `tsx --test`, Beads metadata, Pi extension hooks.

**Spec:** `docs/superpowers/specs/2026-09-21-observer-worktree-lifecycle-design.md`

## Global Constraints

- Keep `worktree_pool` free of task-lifecycle imports and hidden inputs.
- Preserve exactly-one-Active-task admission for ordinary acquire.
- Preserve associated-release preparation before pool mutation.
- Continue rejecting non-empty arguments that do not belong to the selected worktree action.
- Treat tool input, result details, task metadata, and pool observations as untrusted.
- Keep all reconciliation synchronous and bounded.
- Do not push without explicit approval.

## Review Focus

- Empty irrelevant fields must be removed, while non-empty irrelevant fields remain rejected.
- A failed acquire must not create a lifecycle resource.
- A successful acquire must associate the pool-generated claim with the task selected at `tool_call`, even if later ownership lookup changes.
- A malformed successful receipt must become a curated tool-result error and must not mutate task metadata.
- Release failure/refusal must retain recoverable `release_pending` state.

---

### Task 1: Normalize provider placeholders

**Files:**
- Modify: `extensions/worktree-pool/index.ts`
- Modify: `extensions/worktree-pool/index.test.ts`

- [x] Add a failing test where acquire receives all public fields with irrelevant fields set to `""` and reaches `pool.acquire` with only acquire fields.
- [x] Add or preserve a test proving a non-empty top-level acquire `claimId` is rejected.
- [x] Verify the RED tests fail for the strict field-presence validator.
- [x] Add `prepareArguments` normalization that copies the object and removes only empty fields irrelevant to the selected action.
- [x] Update the test harness to execute argument preparation before `execute`, matching Pi.
- [x] Run `npm test -- extensions/worktree-pool/index.test.ts`.

### Task 2: Record pool-generated acquisitions

**Files:**
- Modify: `lib/task-lifecycle/service.ts`
- Modify: `lib/task-lifecycle/service.test.ts`
- Modify: `lib/task-lifecycle/types.ts` only if a dedicated input type improves clarity

- [x] Add a failing service test that starts with an Active task and an existing pool claim, then records the successful receipt as one Active resource.
- [x] Cover duplicate/idempotent receipt handling and contradictory claim observations.
- [x] Verify RED.
- [x] Implement one locked full-object mutation that validates owner, canonical repository, claim/path/branch/HEAD, and records the resource using the pool-generated claim and path identity.
- [x] Run `npm test -- lib/task-lifecycle/service.test.ts`.

### Task 3: Convert hooks to a pure observer

**Files:**
- Modify: `extensions/task-lifecycle/index.ts`
- Modify: `extensions/task-lifecycle/index.test.ts`
- Modify: `extensions/worktree-pool/index.ts`
- Modify: `extensions/worktree-pool/index.test.ts`
- Delete or simplify: `lib/task-lifecycle/worktree-tool-context.ts`

- [x] Add failing hook tests proving acquire input is unchanged, no metadata prepare call occurs, and success records the receipt against the task captured at `tool_call`.
- [x] Add failing tests for acquire error, malformed receipt, release correlation, and finalization cleanup.
- [x] Verify RED.
- [x] Replace hidden input mutation with a bounded in-memory map keyed by `toolCallId`.
- [x] Keep release preparation persistent but store its context in the map rather than in tool input.
- [x] Remove lifecycle context parsing/imports from `worktree_pool`; ordinary acquire calls `pool.acquire(request, owner)`.
- [x] Move any remaining prepared-operation type into task-lifecycle-owned types and remove dead hidden-context code.
- [x] Run focused extension and lifecycle tests.

### Task 4: Update contract documentation

**Files:**
- Modify: `docs/task-lifecycle.md`
- Modify: `docs/superpowers/specs/2026-09-18-ordinary-worktree-lifecycle-design.md` or add a pointer to the correction spec

- [x] Document result-driven acquire association and process-local correlation.
- [x] Document that interrupted acquire auto-recovery is deferred.
- [x] Confirm no public task-specific worktree wrapper or hidden worktree argument is documented.

### Task 5: Verify and integrate locally

- [x] Run focused RED/GREEN suites after each task.
- [x] Run `npm test`.
- [x] Run `node --test tests/manifest.test.mjs`.
- [ ] Run typecheck and Prettier checks from `package.json`.
- [ ] Run Beads compatibility and portability gates.
- [ ] Run `git diff --check` and inspect the final diff.
- [ ] Commit focused logical changes after checking staged paths.
- [ ] Fast-forward local `main`; do not push.
- [ ] Reload Pi and live-test unattached acquire rejection, attached acquire, release, and close.
