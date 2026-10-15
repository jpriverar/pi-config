# Work Management Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution is the simplest path for these tightly coupled changes; no subagent has been authorized or launched.

**Goal:** Recover newly marked Work Management deliveries after unknown outcomes without replaying uncertain creates/comments.

**Architecture:** Add deterministic references to outgoing payloads and a bounded, authenticated remote observer. Feed observations into the existing reservation/receipt state machine, preserving exact-state comparisons and existing retry scheduling. Do not introduce another outbox or migrate task metadata.

**Tech Stack:** TypeScript, Node test runner through tsx, existing dd-auth/curl adapter, native Beads lifecycle store.

**Spec:** `docs/superpowers/specs/2026-10-15-work-management-recovery-design.md`

## Global Constraints

- Strict duplicate safety; no replay of uncertain create/comment writes based solely on absence.
- Forward-only references; no legacy-comment fallback, backfill, or JPR-5 repair.
- Preserve metadata schema, local lifecycle authority, captured target, operation ownership, and credential confinement.
- Page size 50; at most 20 pages; one configured external-timeout budget per observation.
- No push, runtime activation, live test writes, or unrelated UI/database changes.

## Review Focus

- A late/partial remote page must not become evidence of absence: Task 1 tests incomplete scans.
- A copied or conflicting reference must not choose an arbitrary case/comment: Task 1 tests multiple matches and binding checks.
- A native comment edited after dispatch must not be acknowledged from a different payload: Task 1 tests same reference with different content.
- A local pause or rebind during the read must win over a late observation: Task 2 tests exact-state comparison.
- A newer local lifecycle status must not be replaced by the old reserved status: Task 2 tests observed-versus-desired status handling.

---

### Task 1: Identify deliveries and observe remote state safely

**Files:**

- Modify: `lib/work-management/datadog.ts`
- Create: `lib/work-management/recovery.ts`
- Test: `lib/work-management/datadog.test.ts`
- Create tests: `lib/work-management/recovery.test.ts`

**Interfaces:**

- Existing `DatadogOperationRequest`, `DatadogRuntime`, and `DatadogPreparation` remain the sender boundary.
- Export `formatCaseDescription(request: DatadogOperationRequest): string` and `formatComment(request: DatadogOperationRequest): string` from the adapter; sender and observer use the same canonical new format.
- Export `prepareDatadogReader(target: WorkManagementTarget, runtime: DatadogRuntime, signal?: AbortSignal): Promise<DatadogReaderPreparation>`.
- `DatadogReaderPreparation` is either a ready reader with `get(path: string): Promise<DatadogReadOutcome>`, or a retryable/rejected preparation result. Paths must remain under the fixed case API host and namespace.
- `DatadogReadOutcome` is success with an unknown JSON body, retryable with code/optional retry delay, or rejected with a code. No credential-bearing values escape these closures.
- Export `observeDatadogOperation(request: DatadogOperationRequest, runtime: DatadogRuntime, signal?: AbortSignal): Promise<DatadogObservation>` from recovery.ts.
- `DatadogObservation` is observed with optional `remote: RemoteItem` and `statusName: string`, retryable with code/optional delay, or attention with a code. Create observations require identity/status; status observations require status; comment observations only confirm the existing native comment ID.

- [ ] Run existing Work Management tests as the focused baseline. Record any failures before edits.
- [ ] Add failing tests for deterministic references, distinct task/comment identities, no legacy matching, and reference collisions with changed content. Run them and confirm behavioral failures.
- [ ] Implement shared canonical formatting, retaining the existing human-readable task/comment content.
- [ ] Add failing transport tests for GET authentication, fixed host/namespace, no redirects/retries, credential isolation, cancellation, rate limiting, and the total observation deadline.
- [ ] Reuse the current authentication/command mechanism for a read-only prepared reader without weakening write-result handling.
- [ ] Add observer tests using recorded response shapes: type discriminator at `attributes.type`, text at `attributes.cell_content.message`, and pages with no metadata.
- [ ] Cover positive matches on later pages, zero/multiple matches, project/type mismatch, unreadable/deleted cases, malformed/repeated pages, hard bounds, and same marker with changed content.
- [ ] Implement bounded project-case search, bound-case verification, timeline matching, and current-status observation. Read-only paths must never call the sender.
- [ ] Run `npm run test:file -- lib/work-management/datadog.test.ts lib/work-management/recovery.test.ts` and `npm run typecheck`; all selected checks must pass.

### Task 2: Recover the reservation and continue ordinary synchronization

**Files:**

- Modify: `lib/work-management/sync.ts`
- Modify: `lib/task-reconciler/runtime.ts`
- Test: `lib/work-management/sync.test.ts`
- Extend relevant tests: `tests/task-reconciler-integration.test.ts`
- Update: `docs/task-reconciler-operations.md`

**Interfaces:**

- Add `observe(request: DatadogOperationRequest, signal?: AbortSignal): Promise<DatadogObservation>` to `SyncDependencies` and wire it to `observeDatadogOperation` with the same configured auth/runtime boundary.
- Preserve `WorkManagementSync.candidates()` and `step()` signatures and the existing metadata schema.
- Unknown sends retain `inFlight` and become eligible for a backoff-scheduled observation. Existing attention records remain excluded.
- A restart with an unfinished in-flight operation observes it instead of dispatching it again.
- Observed creates bind the remote identity and observed status; observed comments add one receipt; observed statuses record actual remote status. The next ordinary step computes current local intent.

- [ ] Add regressions for a remotely applied write with a lost local receipt, recovery after a fresh synchronizer instance, and continuation without a second POST.
- [ ] Add regressions for absent/ambiguous observations, transient read failure, preserved reservation, backoff, and unchanged old attention records.
- [ ] Add regressions for operator pause/rebind while observing and for a newer local status while an older status is uncertain.
- [ ] Run the new tests and confirm they fail because the existing implementation stops at attention.
- [ ] Implement observation routing and compare-before-persist transitions; reuse retry calculations and keep remote I/O outside the metadata lock.
- [ ] Wire the runtime reader and add an integration proof that the daemon path observes rather than reposts.
- [ ] Update operations guidance to distinguish recoverable new deliveries from old/unmarked or genuinely ambiguous operations.
- [ ] Run focused Work Management and reconciler integration tests, then typecheck, formatting, portable checks, standalone build/runtime-info, and the full suite. Save bounded result summaries and full logs outside the repository.
- [ ] Review the full diff for ownership, stale-state writes, credential exposure, false absence, replay, and accidental legacy support.
- [ ] Before a commit, run `git diff --cached --name-only` and verify only intended files are staged. Keep commits logical and subjects under 50 characters. Do not push or activate.

## Delivery boundary

Report the code and test evidence, any failures or unexercised live behavior, and the explicit activation decision still needed. Release the managed worktree only when work is durable and no process uses it. Keep all phases in `jp-7meg` rather than creating process-only tasks.
