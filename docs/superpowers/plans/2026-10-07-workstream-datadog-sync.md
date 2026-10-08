# Workstream Datadog Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Recommend direct execution here; delegate only if JP selects it.

**Goal:** New tasks in configured workstreams create linked Datadog work items, with local status updates and explicit task logs sent in the background.

**Architecture:** Add one Datadog-specific module to the existing reconciliation daemon. Native tasks and comments remain the durable source; a small metadata record tracks delivery and one in-flight operation. Reuse the existing store lock, scheduler, process runner, and displays rather than introduce another framework.

**Tech Stack:** TypeScript, Node's built-in test runner through `tsx`, Beads CLI, existing daemon, `dd-auth`, and curl >= 8.3.0 (installed `/usr/bin/curl` is 8.7.1).

**Spec:** [Approved small-v1 specification](../specs/2026-10-07-workstream-datadog-sync-design.md), approved at commit `8b9f1ea`.

## Global Constraints

- Only tasks created after linking a workstream enroll. Existing and unlinked tasks remain unchanged.
- Datadog failure must not interrupt local work.
- No Herdr changes, separate service, generic provider framework, or new event system.
- Native task/comment identities are sufficient for local tracking.
- Perform one outbound mutation at a time per task.
- There is no remote polling or drift correction.
- If a write's outcome is uncertain, stop synchronization for that task; no automatic replay or remote search.
- No live Datadog writes, daemon installation, or real mapping activation without JP's separate approval.
- Keep all source changes in the managed worktree. Do not edit the live package checkout or add dependencies.

## Review Focus

Each concern is covered by the task indicated below:

1. Completion before first delivery must not drop an enrolled task (Task 3).
2. A log append can succeed even if its caller never receives the result; discovery must use the native journal (Tasks 1 and 3).
3. A lifecycle update during an HTTP request must not be overwritten or acknowledged as already sent (Task 3).
4. A slow or failing Datadog request must not monopolize daemon slots or prevent lifecycle work (Task 3).
5. Hostile message text, invalid targets, missing credentials, and redirects must not leak secrets or become commands (Tasks 1, 2, and 4).

## File Map

Create four small source files, with colocated `.test.ts` files:

| File                             | Responsibility                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `lib/work-management/model.ts`   | Config/state types, validation, status mapping, source-tag parsing, compact display summary |
| `lib/work-management/config.ts`  | Read the one private per-store configuration                                                |
| `lib/work-management/datadog.ts` | Three documented request shapes and bounded credential-injected transport                   |
| `lib/work-management/sync.ts`    | Choose and deliver the next operation from durable task/journal state                       |

Modify existing store, runner, scheduler, and display files in the tasks below. Do not reorganize unrelated lifecycle code or build generic plugin interfaces. These four modules are responsibilities, not separate services.

## Task 1: Enroll tasks and preserve publishable logs locally

**Files:**

- Create: `lib/work-management/model.ts`, `config.ts`, and their `.test.ts` files.
- Modify: `lib/task-lifecycle/beads-store.ts` and `beads-store.test.ts`.
- Modify: `extensions/task-lifecycle/index.ts` and `lib/task-reconciler/runtime.ts` only to inject the shared config reader.
- Extend: `tests/task-lifecycle-integration.test.ts` using its temporary Beads store, never the real store.

**Interfaces:**

- `WorkManagementTarget`: `{ site, orgUuid, projectId, typeId, statuses }`; status keys are `actionable`, `active`, `waiting`, `deferred`, `completed`, `cancelled`, `superseded`.
- `WorkManagementConfig`: `{ version: 1, ddAuthPath: string, curlPath: string, workstreams: Record<string, WorkManagementTarget> }`. Executable paths must be absolute.
- `loadWorkManagementConfig(storePath: string): WorkManagementConfig | null` reads `<storePath>/pi-work-management.json`; absence means no new enrollment. Malformed/unreadable content throws an error identifying that path. Do not create this private file in the repository or live store during implementation.
- `WorkManagementState`: version 1; captured target and initial title/description; `remote: { id, key?, url } | null`; `lastSentStatus: string | null`; `deliveredCommentIds: string[]`; `inFlight: WorkManagementOperation | null`; and one error/retry record (`code`, attention/retryable classification, failure count, next retry time). No histories or generated event IDs.
- `WorkManagementOperation`: `{ kind: "create" } | { kind: "status", statusName: string } | { kind: "comment", commentId: string }`.
- `NativeTaskComment`: `{ id: string, issueId: string, text: string, createdAt: string }`.
- Keep `LifecycleStore`'s existing required interface unchanged. Return `LifecycleStore & WorkManagementStore` from `createLifecycleStore`, where the additional store methods are:
  - `comments(taskId: string): Promise<NativeTaskComment[]>`
  - `mutateWorkManagement(taskId: string, owner: LockOwner, update: (issue: LifecycleIssue) => WorkManagementState | null): Promise<LifecycleIssue>`; a null result means no mutation, not deletion.
- Add an optional `readWorkManagementConfig(): WorkManagementConfig | null` callback to `LifecycleStoreOptions`. Both production callers provide the same per-store reader; existing fixtures without it remain unlinked.

- [ ] **Write failing tests:**
  - `enrollment shares the native create command`: `assert.equal(createCalls.length, 1)`; assert both `createMetadata.piLifecycle` and `createMetadata.piWorkManagement` exist.
  - `unlinked tasks remain unchanged`: `assert.equal(createMetadata.piWorkManagement, undefined)` and `assert.equal(appendedText, originalMessage)`.
  - `configuration cannot silently reroute enrolled tasks`: assert the stored target remains unchanged after config/label changes.
  - `invalid config creates no task`: assert command count is zero after invalid config; reject unknown sites, incomplete status mappings, and case-insensitive duplicate workstream keys.
  - `journal entry survives lost append response`: simulate successful persistence followed by command failure; assert a subsequent native comment read finds the entry with its original ID.
  - `sync writes preserve lifecycle`: `assert.deepEqual(after.metadata.piLifecycle, before.metadata.piLifecycle)`, `assert.equal(after.status, before.status)`, and equivalent assertions for unrelated metadata.
- [ ] **Run red:** `npm run test:file -- lib/work-management/model.test.ts lib/work-management/config.test.ts lib/task-lifecycle/beads-store.test.ts`. Expect missing-interface/behavior failures, not environment errors.
- [ ] **Implement the minimal store support:** Create the binding under the existing store lock, before the single native create. Keep `task_create` parameters unchanged. For enrolled tasks, `appendComment` adds the exact footer `\n\n[pi-task-log:v1]` after ownership validation and within the native append; no second write. Match workstreams case-insensitively as existing displays do. Read comments using `bd comments <id> --json`, preserving provider order and validating unique IDs. `mutateWorkManagement` writes only the integration namespace, preserving lifecycle and unrelated metadata; it must not use `-s` to change status.
- [ ] **Run green:** Repeat the focused command and `npm run test:file -- tests/task-lifecycle-integration.test.ts`; expect zero failed tests. Add the native-journal assertions to the integration fixture to verify IDs and append/read ordering with the installed Beads version.
- [ ] **Commit:** Stage only Task 1 files, inspect `git diff --cached --name-only`, and commit `tasks: enroll Datadog-linked workstreams`.

## Task 2: Send the three operations using existing credential tools

**Files:**

- Create: `lib/work-management/datadog.ts` and `datadog.test.ts`.
- Modify: `lib/task-reconciler/commands.ts` and `commands.test.ts`.

**Interfaces:**

- Extend `runBoundedCommand` options with optional `input?: string`. No input retains today's ignored-stdin behavior. Bound input bytes, close stdin after writing, and handle early exit/EPIPE without an unhandled exception.
- `DatadogOperationRequest`: target, local task ID, `operation: WorkManagementOperation`, and the payload needed by that operation (initial title/description, remote ID, or native comment).
- `sendDatadogOperation(request: DatadogOperationRequest, runtime: { ddAuthPath: string; curlPath: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }, signal?: AbortSignal): Promise<DatadogOutcome>`.
- `DatadogOutcome`: success (remote identity for create), safely retryable rejection (optional retry delay), definitive attention/rejection, or unknown outcome. Return sanitized codes, not raw process errors or response bodies. Transport injection for tests uses the existing `BeadsExecResult` shape; no generic provider abstraction.

**Verified request contracts:**

| Operation | POST path                    | JSON:API payload                                                                                                                                      |
| --------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create    | `/api/v2/cases`              | `data.type="case"`; attributes `title`, `description`, required `type_id`, `status_name`; project relationship `{data:{id:projectId,type:"project"}}` |
| Status    | `/api/v2/cases/{id}/status`  | `data.type="case"`; attributes `{status_name}`; do not use deprecated `status` enum                                                                   |
| Comment   | `/api/v2/cases/{id}/comment` | `data.type="case"`; attributes `{comment}`                                                                                                            |

Creation sets the configured actionable status and includes the local task ID in the description. Expected successes: create 201, status/comment 200. Create returns `data.id` and optional `data.attributes.key`. Build the human link as the supported site's app origin plus `/cases/` and the encoded case ID; `/cases/:id` is confirmed in the local frontend route definitions.

- [ ] **Write failing tests:** for the status body, `assert.deepEqual(body, { data: { type: "case", attributes: { status_name: "In Progress" } } })`. Assert exact creation/comment bodies, required type ID/project binding, footer removal, and two identical messages with different native IDs. Assert payload text and credential values never occur in argv or diagnostics. Cover stdin early close, absent variables, 429/Retry-After, 401, 5xx, timeout, malformed success JSON, and 3xx without following redirects. Unknown outcomes must never be reported as safe retries.
- [ ] **Run red:** `npm run test:file -- lib/work-management/datadog.test.ts lib/task-reconciler/commands.test.ts`.
- [ ] **Implement transport:** Invoke `dd-auth --org-uuid <uuid> --site <site> -- <curlPath> ...` without a shell. Use curl's native environment expansion: `--variable %DD_API_KEY`, `--variable %DD_APP_KEY`, and literal `--expand-header` arguments containing `{{DD_API_KEY}}`/`{{DD_APP_KEY}}`. Send JSON through stdin with `--data-binary @-`. Put `-q` first in curl's argv to ignore user curl configuration; explicitly disable redirects and automatic retries, enforce HTTPS, and use a curl deadline shorter than the outer command deadline. Select origins from a fixed supported-site map, not arbitrary config URLs. Capture only the response body, status, and Retry-After needed for classification; never print headers or use verbose mode.
- [ ] **Run green:** Repeat the focused tests. Use only fake credentials and a local transport fixture to verify environment expansion/redirect behavior; never real Datadog credentials in unit tests. Verify the actual configured curl version supports variables (>=8.3.0). Check `dd-auth` stdin forwarding and expired-auth behavior with a bounded, explicitly approved read-only probe before activation; if it fails, stop rather than adding a fallback.
- [ ] **Commit:** Inspect staged paths and commit `tasks: add bounded Datadog writes`.

## Task 3: Deliver from durable state on the existing daemon cadence

**Files:**

- Create: `lib/work-management/sync.ts` and `sync.test.ts`.
- Modify: `lib/task-reconciler/{runtime,queue}.ts` and their existing `.test.ts` files.

**Interfaces:**

- `createWorkManagementSync(deps: { store: LifecycleStore & WorkManagementStore; owner: LockOwner; readConfig: () => WorkManagementConfig | null; send: (request: DatadogOperationRequest, signal?: AbortSignal) => Promise<DatadogOutcome>; now: () => number; retryBaseMs: number; retryMaxMs: number }): WorkManagementSync`.
- `WorkManagementSync.candidates(): Promise<string[]>` returns enrolled task IDs eligible for work, across all native lifecycle statuses; it includes completed/deferred tasks.
- `WorkManagementSync.step(taskId: string, signal?: AbortSignal): Promise<"idle" | "delivered" | "retry" | "attention">` performs at most one outbound operation. It is a Datadog-specific dependency, not a generalized job API.
- Add an optional `workManagement?: WorkManagementSync` dependency to the existing reconciler; absent preserves existing behavior and test fixtures.

- [ ] **Write failing tests:**
  - `completed before first scan still creates`: assert one create followed by the current completed status, not a dropped task.
  - `restart discovers native logs`: reconstruct the worker after append; assert one send per eligible ID, excluding untagged native comments and already delivered IDs.
  - `status changes during request`: complete an older request after a local transition; assert `lastSentStatus` equals the value actually sent, lifecycle is unchanged, and the newer status remains pending.
  - `persisted in-flight attempt stops replay`: restart after dispatch or after remote success but before receipt; `assert.equal(additionalWrites.length, 0)` and `assert.equal(result, "attention")`.
  - `unknown comment pauses task sync`: assert no later status/comment sends for that task; unrelated tasks still progress.
  - `slow sync shares limits fairly`: hold one remote call while an explicit lifecycle request completes; assert shared external work never exceeds `externalConcurrency`, and later sync candidates eventually receive a slot.
- [ ] **Run red:** `npm run test:file -- lib/work-management/sync.test.ts lib/task-reconciler/queue.test.ts lib/task-reconciler/runtime.test.ts`.
- [ ] **Implement one-operation delivery:** Under the store lock, re-read state and persist the selected in-flight identity; release the lock before auth/network work. Confirm success under the lock, updating only the receipt actually earned. A pre-existing in-flight record becomes attention, never an automatic retry. Known safe rejection clears the attempt and schedules bounded backoff using the existing limits; rejected configuration/auth requires attention; unknown outcomes retain the attempt. Missing current config for an already bound task is visible attention, not deletion of its binding. No remote GETs or searches.
- [ ] **Integrate narrowly into `queue.ts`:** Discover sync candidates on the existing scan tick independently of lifecycle eligibility. Give ready lifecycle work and sync work fair access to the existing external slot count. Reuse tracked promises, diagnostics, and shutdown handling; add no second interval, new daemon, generic scheduler, or event bus. Keep per-task deduplication and admit more candidates as slots free rather than permanently truncating the first batch. A sync-only failure must not prevent lifecycle scans. Capture a sent request's result if available during shutdown; otherwise leave the in-flight marker.
- [ ] **Run green:** Repeat the focused tests; retain all existing fairness, timeout, shutdown, and ownership tests unchanged unless the optional dependency requires fixture wiring.
- [ ] **Commit:** Inspect staged paths and commit `tasks: sync work items in the daemon`.

## Task 4: Surface status and finish the thin end-to-end integration

**Files:**

- Modify: `lib/beads.ts`, `extensions/task-lifecycle/{index,work-state}.ts`, and existing tests in `tests/beads.test.ts` and `extensions/task-lifecycle/{index,work-state}.test.ts`.
- Extend: `tests/task-lifecycle-integration.test.ts`, `lib/task-reconciler/runtime.test.ts`.
- Modify: `docs/task-lifecycle.md`, `docs/task-reconciler-operations.md`.
- Existing build entry: `scripts/build-task-reconciler.mjs` and `tsconfig.reconciler.json`; change only if the new runtime imports are not included automatically.

**Interfaces:**

- `summarizeWorkManagement(metadata: Record<string, unknown>, lifecycle: LifecycleMetadataV1 | null): { url?: string; text: string } | null` in `model.ts` supplies compact linked/pending/attention text from either store projection; malformed stored state must render attention rather than disappear.
- Carry only this decoded summary through the existing `BeadsIssue`/`ClassifiedIssue` projection used by scoped work-state displays. Do not expose the whole mutable sync record to display code or reinterpret it as task readiness.

- [ ] **Write failing tests:** assert the link and pending/attention indicator appear without changing lifecycle labels; escape hostile text and reject unsafe links; for unlinked tasks, `assert.equal(rendered, existingOutput)`. Reuse the native-store integration fixture with fake outbound calls to exercise create → claim → log → close → daemon restart without duplicate confirmed delivery.
- [ ] **Run red:** `npm run test:file -- tests/beads.test.ts extensions/task-lifecycle/index.test.ts extensions/task-lifecycle/work-state.test.ts tests/task-lifecycle-integration.test.ts`.
- [ ] **Implement display/documentation wiring:** Extend current task results and scoped summaries, not Herdr UI. Document the private config shape, per-task binding semantics, native footer, automatic-secret-detection limitation, shared daemon off switch, and how to inspect/repair an uncertain attempt only after explicitly confirming its remote outcome. Preserve `piLifecycle` during any documented maintenance; no recovery commands or tools are added. List the required curl capability and the unattended-auth activation gate.
- [ ] **Run green and final gates:** repeat the focused command, then `npm test`, `npm run typecheck`, `npm run format:check`, `npm run verify:portable`, and `npm run build:reconciler`. Confirm the built runtime contains the new imported modules without installing it. Use bounded/background execution for long commands, inspect failures, and report actual results; do not claim these checks ran during planning.
- [ ] **Commit:** Inspect staged paths and commit `tasks: expose work item sync status`.

## Completion and Activation Boundary

Self-review the full branch against the approved spec, especially that excluded machinery has not crept back in. If JP chooses direct execution plus an independent reviewer, use one fresh read-only whole-branch review after implementation, not one agent per task.

Deliver code and test evidence with integration disabled. Before live validation, ask JP for the target org/site/project/type/status mapping and one disposable task. Run the bounded read-only credential/project checks first, then the separately approved create/status/comment validation. Do not install/update the running daemon, enable a mapping, push, merge, or delete the validation item as an implicit final step.

## Planning Evidence

- Source baseline `6f7875b`; the store creates metadata with the task, retains native comments, and preserves unrelated metadata on mutation.
- Existing runner has ignored stdin; adding bounded optional stdin is the only transport-runner capability required.
- Installed curl 8.7.1 documents environment expansion added in 8.3.0. This avoids a custom request-helper executable and shell expansion of credentials.
- Datadog documents required `type_id`, project relationships, `status_name`, and comment payloads at the three API links in the spec.
- The frontend route constant is `/cases/:id`. No live Datadog writes or authentication probes were run during planning.

## Review and Execution Choice

This plan is awaiting JP's review. Recommend direct execution in this session followed by one independent whole-branch review: the four tasks share store/runtime interfaces, so fresh implementers per task add handoff cost without useful parallelism. JP must choose/approve the execution approach before code changes or delegation.

## Approved stock-auth correction — 2026-10-08

The initial unattended-auth activation gate above is superseded. JP approved
ordinary browser authentication with stock dd-auth and a visible login-needed
flow. Authentication now precedes the durable write reservation; credentials
remain inside the prepared transport in memory. Authentication failures use
existing retry/backoff. Existing task notices show the exact org/site login
command, deduplicated until recovery. Unknown write outcomes still pause.

The original implementation and independent whole-branch review are complete.
The auth correction is being implemented and tested directly under `jp-w7cz`.
Local integration, the `recs` → RECS mapping, exact status mapping, and one labeled
live create/active/comment/completed validation task are already approved.
No additional activation approval, upstream publication, or deletion is implied.
