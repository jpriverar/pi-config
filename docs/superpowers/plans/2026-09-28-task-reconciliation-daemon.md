# Local Task Reconciliation Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Honor the parent harness's worktree and approval rules.

**Goal:** Ship an opt-in, login-started local reconciler with safe asynchronous checks, without duplicate reconciliation or startup blocking across Pi sessions.

**Architecture:** Share lifecycle rules between the extension and a standalone Node daemon. The daemon owns one deduplicated queue per canonical Beads store; slow observations happen outside mutation locks and are conditionally applied after fresh reads. Pi retains ordinary task operations and uses a private local client for explicit reconciliation and health.

**Tech Stack:** Node.js `>=22.19.0`, TypeScript/NodeNext ESM, existing `node:test`/`tsx` development tooling, Beads and GitHub CLIs, Unix-domain sockets, macOS launchd. No new runtime framework, AI dependency, or durable job database.

**Spec:** [Approved daemon design](../specs/2026-09-24-task-reconciliation-daemon-design.md).

**Task / baseline:** `jp-nqwc`; inspect against `cf230ef`. Planning branch `jpriverar/task-reconciler-design`. This plan is pending review; it does not authorize implementation or service activation.

## JP's review summary

Eight deliverables: **due selection → safe application → bounded commands → queue → daemon/API → opt-in installer → Pi integration → end-to-end verification**.

The important boundaries remain unchanged: no implicit background installation; no fallback reconciler; no new task ownership authority; no desktop alerts or model turns. `install` prepares files, `start` enables login startup, and `stop` disables it. The bundled CLI is also reachable through a Pi command, because installing a Git-sourced Pi package does not put its executable on the shell's global `PATH`.

The engineering detail below fixes interfaces and tests. Review the sequence and approval gates; implementation-level defaults are not additional product decisions.

## Global Constraints

- One work item, `jp-nqwc`; one writer per managed worktree. Use `worktree_pool`, not direct worktree lifecycle commands.
- Platform: macOS user LaunchAgent; Node.js `>=22.19.0`. Pure engine tests remain platform-independent.
- Scan every `60_000ms`; one local lane, two concurrent external commands, at most 100 admitted task jobs.
- Command timeout `30_000ms`; whole external observation deadline `120_000ms`; Pi request timeout `60_000ms`. Command capture defaults to 16 MiB; protocol frames are capped at 64 KiB.
- Heartbeat every `10_000ms`, stale after `30_000ms`; heartbeat updates do not query Beads.
- Existing check polling interval `900_000ms`, maximum external-error backoff `21_600_000ms`; local-recovery backoff starts at `60_000ms` and caps at `900_000ms`.
- Unknown dependency status is unresolved. Preserve current lifecycle semantics, exact-expired-lease cleanup reservations, and safe pool release.
- Runtime directory mode `0700`; configuration, health, and socket mode `0600`. Reject unsafe path ownership/symlinks and canonical-store collisions.
- No installation, enablement, launchd mutation, or live mutating reconciliation in unit tests, ordinary package operations, or extension startup.
- No scope expansion into task rendering, automatic agent execution, legacy migration, or a general workflow system.
- Every implementation task follows red → green → focused verification → a logical commit. Before every commit run `git diff --cached --name-only` and verify only intended paths are staged.

## Review Focus

1. List-result dependency edges lack target status: preserve them as unknown; a missing target must not unlock a task. Pinned by Task 1.
2. A lost manual response followed by a replacement check: retry must retain its original identity/fingerprint and never satisfy the replacement. Pinned by Tasks 2, 5, and 7.
3. A timed-out process or retained output pipe: termination must not release a mutation lock before its direct child has exited, and capture must not hang forever. Pinned by Tasks 3 and 8.
4. Aliased store paths, stale sockets, and oversized local requests: no duplicate daemon or cleanup of another live instance's resources. Pinned by Task 5.
5. A stopped service being updated, missing account configuration, or a minimal launchd environment: no implicit activation, global account switching, or credential exposure. Pinned by Tasks 3 and 6.

---

## File and interface map

Existing domain types remain in `lib/task-lifecycle/types.ts`. New code lives next to its responsibility; each new production module below gets an adjacent `.test.ts` unless an explicit integration-test path is named.

| Path                                                                                       | Responsibility                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `lib/task-lifecycle/reconciliation.ts`                                                     | Pure due selection and check fingerprinting; bounded snapshot enrichment.                                         |
| `lib/task-lifecycle/service.ts`, `beads-store.ts`, `checks.ts`                             | Shared prepare/observe/apply behavior and fresh locked mutations; retain all existing non-reconciliation methods. |
| `lib/task-reconciler/config.ts`                                                            | Validated daemon paths, account map, and numerical defaults.                                                      |
| `lib/task-reconciler/commands.ts`                                                          | Bounded argv-only subprocess execution and signal handling.                                                       |
| `lib/task-reconciler/github.ts`                                                            | Per-repository noninteractive account selection and check-adapter composition.                                    |
| `lib/task-reconciler/queue.ts`                                                             | Deduplication, fairness, admission bounds, and local/remote scheduling.                                           |
| `lib/task-reconciler/runtime.ts`                                                           | Compose existing store/service/pool and adapters; scan/heartbeat lifecycle.                                       |
| `lib/task-reconciler/protocol.ts`, `server.ts`, `client.ts`                                | Narrow versioned requests, singleton/socket ownership, and clients.                                               |
| `lib/task-reconciler/health.ts`, `notices.ts`                                              | Bounded atomic health snapshots and per-session notice selection.                                                 |
| `lib/task-reconciler/service-manager.ts`, `cli.ts`                                         | launchd administration and CLI dispatch.                                                                          |
| `bin/task-reconciler.mjs`, `scripts/build-task-reconciler.mjs`, `tsconfig.reconciler.json` | Node launcher and standalone ESM build.                                                                           |
| `extensions/task-lifecycle/index.ts`, `work-state.ts`                                      | Explicit client routing, management command, and read-only health/notices.                                        |
| `tests/task-reconciler-integration.test.ts`                                                | Process-level temporary-store verification.                                                                       |

Do not split files further just to match layers. Do not rewrite the pool: `loadWorktreePoolRuntime` already accepts an asynchronous `runGit` dependency.

### Common contracts introduced by this plan

These are new exported types, not claims that the interfaces exist today.

```ts
// lib/task-lifecycle/reconciliation.ts
interface ReconciliationCandidate {
  taskId: string;
  eligibleAtMs: number;
  reasons: readonly ("execution" | "resource" | "dependency" | "check")[];
}
interface ReconciliationScan {
  candidates: readonly ReconciliationCandidate[];
  diagnostics: readonly { taskId?: string; code: string }[];
}
interface ReconcileRequest {
  requestId: string;
  taskId: string;
  manualOutcome?: "satisfied" | "action_required";
  expectedCheckFingerprint?: string;
}
interface PreparedCheck {
  taskId: string;
  operationId: string;
  fingerprint: string;
  check: LifecycleCheck;
  artifacts: readonly Artifact[];
  manualOutcome?: "satisfied" | "action_required";
}
type ReconciliationPreparation =
  | {
      kind: "complete";
      issue: LifecycleIssue;
      outcome: ReconcileResult["outcome"];
    }
  | { kind: "observe"; prepared: PreparedCheck };
interface ReconcileResult {
  outcome: "applied" | "unchanged" | "already_applied" | "stale";
  issue: LifecycleIssue;
}
```

`LifecycleIssue`, `LifecycleCheck`, and `Artifact` are the existing exported types. A preparation contains copied immutable inputs, not a mutable alias into the store. Curated transport errors are separate from `ReconcileResult`; raw lifecycle metadata does not become an unrestricted RPC payload.

## Task 1: Preserve dependency edges and select only eligible work

**Files:** Modify `lib/task-lifecycle/types.ts`, `beads-store.ts`, their tests, and `service.test.ts`'s `FakeStore`. Create `lib/task-lifecycle/reconciliation.ts` and its test.

**Interfaces:** Extend `NativeDependency.status` to `LifecycleStatus | "unknown"` and add `LifecycleStore.showMany(ids: readonly string[]): Promise<LifecycleIssue[]>`. Export `selectDueCandidates(issues, blockerStatuses: ReadonlyMap<string, LifecycleStatus>, nowMs): ReconciliationCandidate[]` and `scanReconciliation(store: LifecycleStore, nowMs: number): Promise<ReconciliationScan>`.

- [ ] **1. Write failing selection/store tests.** Use `node:test`, fixed UTC time, and recording executors. Add list-edge decoding as unknown, malformed lifecycle diagnostics, future checks, expired ownership with a future check, pending resource repair, closed/open/deferred/missing blockers, deduplication, and eligible tasks after ten irrelevant entries. Pin representative assertions:

  ```ts
  assert.equal(listed.dependencies[0].status, "unknown");
  assert.deepEqual(
    scan.candidates.map((c) => c.taskId),
    ["due-after-ten"],
  );
  assert.equal(calls.filter((c) => c[0] === "dep").length, 0);
  assert.equal(calls.filter((c) => c[0] === "show").length, 1);
  assert.equal(selectDueCandidates([waiting], new Map(), now).length, 0);
  ```

- [ ] **2. Verify red.** `npm run test:file -- lib/task-lifecycle/reconciliation.test.ts lib/task-lifecycle/beads-store.test.ts`; expect missing exports or the discarded-edge assertion to fail, not fixture setup errors.
- [ ] **3. Implement bounded enrichment.** Decode list summaries into native dependencies with unknown status; detailed `show` records still require valid real statuses. `showMany` uses one argv-only `bd show ... --long --json` per call. The scanner lists unfinished tasks once, deduplicates relevant blocker IDs, and chunks requests at 100 IDs and 16 KiB of ID argument bytes, whichever comes first. Failed/partial batches leave absent statuses unknown with diagnostics; unrelated expiry/check candidates still progress. Preserve unmanaged-vs-malformed distinction using existing raw metadata. Sort eligible candidates by deadline/state timestamp and ID; do not impose queue limits here.
- [ ] **4. Verify green.** Run the two suites plus `lib/task-lifecycle/service.test.ts`, `lib/task-lifecycle/model.test.ts`, and `npm run typecheck`. Extend tests to 101 unique blockers and one oversized ID to prove bounds. Missing targets must never be inferred closed.
- [ ] **5. Commit the verified deliverable.** Stage only Task 1 files, inspect staged names, commit `tasks: select due reconciliation work`.

## Task 2: Separate observation from conditional application

**Files:** Modify `lib/task-lifecycle/service.ts`, `checks.ts`, `beads-store.ts`, and their tests. Extend `reconciliation.ts`/test. Avoid a general service-class refactor.

**Interfaces:** Export `fingerprintCheck(issue: LifecycleIssue): string | null`. Add service methods `prepareReconciliation(request: ReconcileRequest, owner: LockOwner): Promise<ReconciliationPreparation>` and `applyReconciliation(prepared: PreparedCheck, observation: CheckObservation, owner: LockOwner): Promise<ReconcileResult>`. Preserve `reconcileTask` temporarily as a compatibility wrapper over the same methods; do not keep a second implementation. Extend the locked store mutation callback to return `Mutation | null`, where null explicitly abstains without a write or a fabricated transition. Extend `ObserveCheckInput` with `signal?: AbortSignal` and define `GitHubExecutor(args: readonly string[], options?: { signal?: AbortSignal }): Promise<GitHubExecutionResult>`, preserving call sites that omit options.

- [ ] **1. Write failing race/idempotence tests.** Pause an observation, change each relevant predicate/target/URI/policy/check field, then apply. Also edit a title or renew a valid lease. Cover a superseding observation, manual replacement-check retry, wrong-kind manual input, Active retained-check satisfaction, and expiry-renewal races:

  ```ts
  assert.equal(stale.outcome, "stale");
  assert.equal(store.mutations, writesBeforeApply);
  assert.equal(afterLeaseRefresh.outcome, "applied");
  assert.equal(retry.outcome, "already_applied");
  assert.equal(store.saved.lifecycle?.phase, "active");
  ```

- [ ] **2. Verify red.** `npm run test:file -- lib/task-lifecycle/service.test.ts lib/task-lifecycle/reconciliation.test.ts`; expect absent preparation/application methods or stale-write assertions to fail.
- [ ] **3. Implement the split and request binding.** Move existing local expiry/resource/dependency logic into preparation, retaining exact-lease reservation and fresh blocker reads. Build a canonical SHA-256 fingerprint from observation-relevant check/target fields, excluding title and execution heartbeat. Bind explicit manual input to that fingerprint; reject mismatches and non-manual checks. Compare fresh inputs inside the existing store mutation lock before applying; no network observation inside that lock. Recognize stable request-derived operation IDs in transition history before replay. Make the store return unchanged state without a `bd update` when status and metadata are identical; stale results must not write. Encode a request-ID hash and input-binding digest in the existing transition `operationId` (`reconcile:<request-hash>:<binding-hash>`), rather than adding another request database or lifecycle schema. Search by request hash first: conflicting completed bindings are rejected, exact completed bindings return `already_applied` before evaluating a now-cleared check.
- [ ] **4. Verify green.** Run `service.test.ts`, `model.test.ts`, `checks.test.ts`, `beads-store.test.ts`, and `reconciliation.test.ts`, then typecheck. Keep existing cleanup/refusal/phase timestamp tests unchanged in meaning. Test authoritative dependency revalidation; do not claim a cross-issue transaction.
- [ ] **5. Commit.** Inspect staged names, commit `tasks: guard reconciliation observations`.

## Task 3: Bound commands and construct noninteractive adapters

**Files:** Create `lib/task-reconciler/config.ts`, `commands.ts`, `github.ts`, and adjacent tests. Extract the existing lifecycle config decoder into `lib/task-lifecycle/config.ts`/test and import it from `extensions/task-lifecycle/index.ts`; the daemon must not import the extension to read policy. Update `checks.ts` only for signal propagation. Add controlled fixture programs under `tests/fixtures/task-reconciler/` for timeout/output tests.

**Interfaces:** Export `loadDaemonConfig(path: string): Promise<DaemonConfig>` and `loadLifecycleConfig(path: string): LifecycleConfig` (the existing lifecycle fields, unchanged). `DaemonConfig` has `version: 1`, `store`, `poolConfigPath`, `lifecycleConfigPath`, `runtimeRoot`, `executables: { node, bd, git, gh }` (absolute string paths), `githubAccounts: Readonly<Record<string, string>>`, and `limits: { scanIntervalMs, externalConcurrency, maxQueuedTasks, commandTimeoutMs, observationTimeoutMs, requestTimeoutMs, heartbeatIntervalMs, heartbeatStaleMs, localFailureBaseMs, localFailureMaxMs, maxOutputBytes }` (positive numbers with the exact defaults above). Export `runBoundedCommand(file: string, args: readonly string[], options: { signal?: AbortSignal; env: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number }): Promise<BeadsExecResult>` and `createDaemonCheckAdapters(config: DaemonConfig): CheckAdapterRegistry`. Export numerical defaults and `daemonEnvironment(config: DaemonConfig): NodeJS.ProcessEnv` from config; lifecycle policy remains in the shared lifecycle config.

- [ ] **1. Write failing boundary tests.** Pin timeouts, shutdown abort, nonzero exits, missing executables, output overflow, retained output pipes, correct account selection, missing mappings, credential failure, and secret redaction. Assert the direct child has exited before the command promise settles, and a hostile argument remains one argv element. Use fake credentials only.
- [ ] **2. Verify red.** `npm run test:file -- lib/task-reconciler/config.test.ts lib/task-reconciler/commands.test.ts lib/task-reconciler/github.test.ts`; expect absent modules/exports.
- [ ] **3. Implement execution and account selection.** Spawn without a shell or detached children. Default to 30 seconds and 16 MiB combined captured output; propagate abort, TERM then bounded KILL escalation, await direct-child exit, and close captured streams. Never kill the daemon's own process group. Keep children in the supervised group for launchd crash cleanup. Produce curated errors without argv secrets or raw credential output. Acquire the configured account token with `gh auth token --hostname github.com --user <account>` and inject it only into the relevant GitHub child; never switch global accounts. Require explicit owner/account mappings; shared runtime code has no hard-coded work-org defaults. Use a reviewed minimal child environment and explicit paths, not shell initialization.
- [ ] **4. Verify green.** Run those suites, `checks.test.ts`, typecheck, and fixture cleanup assertions. Validate nonfinite/negative limits and missing paths. Killing a timed-out mutation does not prove rollback; callers retain unknown-outcome handling.
- [ ] **5. Commit.** Inspect staged names, commit `tasks: bound reconciler command execution`.

## Task 4: Run a fair, deduplicated reconciliation queue

**Files:** Create `lib/task-reconciler/queue.ts`, `runtime.ts`, and adjacent tests. Consume the existing injectable pool runtime; no parallel pool implementation.

**Interfaces:** `createReconciler(deps: { store: LifecycleStore; service: TaskLifecycleService; adapters: CheckAdapterRegistry; owner: LockOwner; config: DaemonConfig; now: () => number; abortLocalCommands: () => void }): Reconciler`. `Reconciler` exposes `start(): void`, `reconcile(request: ReconcileRequest): Promise<ReconcileResult>`, `snapshot(): QueueSnapshot`, and `stop(): Promise<void>`. `QueueSnapshot` has `lastScanAttemptAt`/`lastScanSuccessAt` (`string | null`), `queued`/`localRunning`/`externalRunning` (numbers), and `diagnostics` (the same entries as `ReconciliationScan`). `createDaemonRuntime(config: DaemonConfig, owner: LockOwner): Promise<Reconciler>` composes the existing store/service/pool and creates the shutdown controller used by every local command. `stop()` aborts observations and calls `abortLocalCommands` before joining work; define the factory in `runtime.ts`.

- [ ] **1. Write failing fake-clock tests.** Submit the same task from scans and explicit requests; block two external observations; advance multiple scan intervals. Assert:

  ```ts
  assert.equal(observationsForTask, 1);
  assert.equal(maxExternalCommands, 2);
  assert.ok(maxLocalJobs <= 1);
  assert.ok(maxAdmittedJobs <= 100);
  assert.equal(overlappingScans, 0);
  assert.equal(unrelatedCompleted, true);
  ```

  Add 101 eligible tasks, continuous arrivals, conflicting manual inputs, one failed task, 120-second observation timeout, local backoff, shutdown, and restart reconstruction.

- [ ] **2. Verify red.** `npm run test:file -- lib/task-reconciler/queue.test.ts lib/task-reconciler/runtime.test.ts`.
- [ ] **3. Implement stateful scheduling.** A job moves through queued/preparing/observing/applying states while retaining per-task ownership. Preparation/application use the single local lane; only GitHub commands consume the shared external semaphore, including multi-target checks. Scans never await remote jobs. Alternate explicit/scheduled admission when both wait; preserve ordered deferred candidates without launching them beyond the cap, discard invalidated entries, and test bounded bookkeeping. Deduplicate scheduled scans and retries with the same request ID/payload; distinct explicit IDs retain separate result handling. Serialize explicit requests behind an active observation and reject conflicting outcomes. Reject new explicit admissions when capacity is exhausted rather than building an unbounded waiter list. Timeout records an external error/backoff; shutdown cancellation stops work without inventing a task outcome. Local failures use the approved in-memory backoff. Wrap injected `runGit` with the bounded executor.
- [ ] **4. Verify green.** Run queue/runtime, command, service, and pool runtime suites plus typecheck. Demonstrate all 101 candidates eventually run, and that a task with both expired ownership and a future check is not skipped.
- [ ] **5. Commit.** Inspect staged names, commit `tasks: queue bounded reconciliation work`.

## Task 5: Host one private daemon and expose a bounded client

**Files:** Create `lib/task-reconciler/protocol.ts`, `server.ts`, `client.ts`, `health.ts`, and adjacent tests. Reuse `lib/file-operation-lock.ts`; add focused tests there only if exposing a nonwaiting acquisition path is necessary.

**Interfaces:** Export `serveReconciler(config: DaemonConfig, reconciler: Reconciler, owner: LockOwner, signal: AbortSignal): Promise<void>`; `requestReconciliation(config: DaemonConfig, request: ReconcileRequest, signal?: AbortSignal): Promise<ReconcileReply>`; `readDaemonHealth(config: DaemonConfig): Promise<DaemonHealth>`. Define `ReconcileReply` in `protocol.ts` as `{ requestId: string; outcome: ReconcileResult["outcome"]; task: { id: string; status: LifecycleStatus; phase: LifecyclePhase | null } }`. This is intentionally narrower than the engine result: raw metadata never crosses RPC. Define `DaemonHealth` in `health.ts` as `{ state: "unavailable" | "incompatible"; reason: string } | { state: "available" | "stale"; protocolVersion: 1; runtimeVersion: string; pid: number; startedAt: string; heartbeatAt: string; queue: QueueSnapshot }`. Cap the embedded queue diagnostics at 20 and retain scan/count field names from Task 4. Heartbeat or queue-count changes alone do not generate attention notices. Protocol v1 accepts only `status` and `reconcile`; use a single length-prefixed JSON request/response per connection, capped at 64 KiB. Re-read via the store only when callers need full task detail.

- [ ] **1. Write failing filesystem/socket tests.** Start two hosts against a canonical store and an alias; test dead/live/ambiguous ownership, unsafe file modes, foreign ownership, malformed frames, 64 KiB + 1 input, conflicting request bindings, lost responses, stale heartbeat, and unsupported versions. Assert only one runner starts and no second host deletes the first host's socket. Simulate startup failure after lock acquisition and verify cleanup.
- [ ] **2. Verify red.** Run `server.test.ts`, `protocol.test.ts`, `client.test.ts`, and `health.test.ts` via `npm run test:file --`.
- [ ] **3. Implement the host boundary.** Resolve/verify real store identity before deriving a short runtime key. Persist/check the full canonical path to detect key collision; reject socket paths that exceed the local supported byte limit. Hold a dedicated singleton lock for the full host lifetime. Bind sockets only after owner checks; stale cleanup requires confirmed dead ownership. Refresh atomic health every ten seconds without Beads reads. Enforce 60-second client wait; on timeout/disconnect return a curated unknown-result error carrying the original request binding, never a fabricated cancellation. Check completed operation bindings before rejecting a stale retry; mismatch is a conflict, not a new mutation. Graceful shutdown stops admissions, reaps work, then releases owned endpoints/lock.
- [ ] **4. Verify green.** Run those suites, queue/runtime, file-lock tests, and typecheck. Verify state replay after a committed result and refusal to apply a timed-out manual instruction to a replaced check. No live launchd calls.
- [ ] **5. Commit.** Inspect staged names, commit `tasks: host private reconciliation daemon`.

## Task 6: Bundle an explicit installer and launchd administration

**Files:** Create `lib/task-reconciler/service-manager.ts`, `cli.ts`, adjacent tests, `bin/task-reconciler.mjs`, `scripts/build-task-reconciler.mjs`, `tsconfig.reconciler.json`, and `tests/task-reconciler-packaging.test.ts`. Modify `package.json`, `.gitignore`, and `README.md`; update manifest/portability tests only for intentional package surface changes.

**Interfaces:** `manageService(action: "install" | "start" | "stop" | "status" | "update" | "uninstall", configPath: string, deps: ServiceManagerDependencies): Promise<ServiceManagerResult>`. Inject filesystem, command execution, UID/home, and health probe; no launchctl call from module load. `runCli(argv: readonly string[]): Promise<number>` dispatches management and foreground `run`. CLI accepts `--config <absolute-path>`; installation requires store/pool/executable/account configuration, never inferred GitHub identity. Define all exported manager dependency/result types in its module.

- [ ] **1. Write failing packaging/admin tests.** Assert install invokes no `launchctl`, daemon, or Beads mutation; start enables and bootstraps only the expected label; stop disables/bootouts it; update of a stopped service does not start it. Assert package import, normal `npm install`, and extension loading never perform service administration. Test missing compiler/path errors, minimal environment, read-only status, failed-update stopped state, and uninstall ownership boundaries. Include a hermetic built-runtime test with no project `node_modules` available.
- [ ] **2. Verify red.** `npm run test:file -- lib/task-reconciler/service-manager.test.ts lib/task-reconciler/cli.test.ts tests/task-reconciler-packaging.test.ts`.
- [ ] **3. Implement the standalone package path.** Add a package `bin` entry and explicit `build:reconciler` script; no install/prepare hook that activates a service. Use existing TypeScript tooling to emit ESM plus reviewed JSON assets to a staged build directory; copied runtime modules must load without `tsx` or Pi runtime packages. The Node-only launcher can invoke the explicit builder for install/update before importing compiled CLI code, and otherwise gives setup guidance when the build is absent. Install places a verified runtime/config and inactive LaunchAgent template in a user-private service directory. Start explicitly publishes/enables the owned login agent and starts it; stop disables/unloads it. Keep `AbandonProcessGroup` unset and use a finite exit deadline. Update drains before replacing runtime, preserves the previous build for rollback, and restores only prior enablement; failure stays stopped. Validate generated plists with `plutil` in tests without loading them. Uninstall deletes only verified service-owned paths.
- [ ] **4. Verify green.** Run those tests, `node --test tests/manifest.test.mjs`, `npm run verify:portable`, typecheck, format check, and the hermetic build smoke. Administrative tests use injected launchctl; any actual LaunchAgent test requires separate approval. Document exact install/start/status/update/stop/uninstall commands and the foreground test mode.
- [ ] **5. Commit.** Inspect staged names, commit `tasks: bundle opt-in daemon administration`.

## Task 7: Route Pi reconciliation and present read-only health

**Files:** Modify `extensions/task-lifecycle/index.ts`, `index.test.ts`, `work-state.ts`, `work-state.test.ts`, and `docs/task-lifecycle.md`. Create `lib/task-reconciler/notices.ts`/test. Update `tests/pi-smoke.ts` and relevant tool-schema assertions for intentional additions only.

**Interfaces:** Keep `task_reconcile(taskId, manualOutcome?)` compatible and add optional retry-binding fields `requestId` and `expectedCheckFingerprint`. A new manual request captures a fresh fingerprint before sending; a retry must reuse the returned binding, never silently generate a new fingerprint. Add a Pi `/task-reconciler` command that forwards allowlisted administration subcommands to the bundled launcher by absolute path. Export `selectReconciliationNotices(issues: readonly BeadsIssue[], health: DaemonHealth, cursor: NoticeCursor | null): { notices: readonly ReconciliationNotice[]; cursor: NoticeCursor }` from `notices.ts` (existing `ClassifiedIssue` is a compatible subtype). `NoticeCursor` has `version: 1`, `knownTaskIds: readonly string[]`, `lastSeen: Readonly<Record<string, string>>`, and `healthSignature: string | null`; values are observation signatures, not task instructions. `ReconciliationNotice` has `key: string`, optional `taskId`, `level: "info" | "warning"`, and normalized `message: string`.

- [ ] **1. Write failing extension tests.** Startup/reload must make zero service `reconcileDue` calls and zero installer calls. `task_reconcile` must use the client; unavailable daemon must not invoke a local fallback. Claim/wait/close/activity hooks remain local. Test a lost manual response followed by a retry, a replaced check, setup guidance, invocation from a cwd without package bins, and protocol mismatch. Notice tests pin baseline suppression, new transitions, `wakeOn`, recovery, and no repeats/model turns/desktop calls. A previously visible task disappearing from the unfinished list must be resolved through a bounded bulk lookup, not inferred closed or silently omitted.
- [ ] **2. Verify red.** Run index/work-state/notices suites and the current lifecycle smoke fixture assertions; failures must reflect the old local reconciliation route.
- [ ] **3. Implement the cutover client.** Remove only the startup reconciliation hook and replace the explicit reconcile tool's execution path. Preserve lease refresh and shutdown ownership semantics. Curate client output; unknown outcomes include the retry binding and never claim completion. Management commands require explicit invocation and validated subcommands; normal extension startup never builds or activates the daemon. Read health alongside existing work-state refresh with a short bounded read, not by waiting for jobs. Persist a session-local notice cursor using existing session entries, baselining historical results on startup while showing unresolved attention conditions. Reuse classified issues; resolve previously known IDs absent from that snapshot through chunked `BeadsClient.showIssues` calls so completed tasks remain observable. Cap notices at ten per interaction, leaving unshown changes unacknowledged for a later interaction. Bound serialized cursor data to 128 KiB; overflow yields an explicit diagnostic/rebaseline, not invented outcomes. Honor project scoping and do not add per-task Beads queries. Both sessions may show a notice; that is presentation, not duplicate work.
- [ ] **4. Verify green.** Run the affected suites, tasks-overlay tests, typecheck, formatting, and isolated lifecycle smoke tests. Update lifecycle documentation to remove the startup-only description and explain unavailable service, retry uncertainty, and opt-in setup. Do not activate this cutover in a live Pi session before the final gate.
- [ ] **5. Commit.** Inspect staged names, commit `tasks: route Pi reconciliation to daemon`.

## Task 8: Prove restart, concurrency, and activation readiness

**Files:** Create `tests/task-reconciler-integration.test.ts`, `tests/task-reconciler-readonly-probe.ts`, and `docs/task-reconciler-operations.md`. Extend fixture programs and README/package scripts as necessary to make these exact verification paths repeatable.

**Interfaces:** Consume the built CLI, config, local client, health, and existing temporary Beads/pool test conventions. The read-only probe imports only store reads and `scanReconciliation`; it does not construct a mutating service or invoke queue execution. No new production interface.

- [ ] **1. Write failing end-to-end scenarios.** With isolated Beads/Git/pool/socket roots and fake GitHub: use two clients, due work beyond ten entries, more than 100 tasks, successful and failed checks, dirty resources, renewed leases, request disconnect/retry, shutdown/crash/restart, and a retained child output pipe. Assert no duplicate application, no wrong-check manual satisfaction, no release of renewed/dirty resources, eventual queue progress, and clean test-owned process teardown. Install/start tests remain injected; real supervision tests are opt-in only.
- [ ] **2. Verify red.** `npm run test:file -- tests/task-reconciler-integration.test.ts`; failures must expose the targeted integration gap, not unavailable global tools or live-store configuration. Check prerequisites explicitly.
- [ ] **3. Close integration gaps and document operations.** Keep repairs in the owning modules, with regression tests there. Document health, authentication recovery, unknown outcomes, explicit runtime rollback, normal stop/uninstall, and elimination of every old loaded Pi reconciler before activation. Provide a non-mutating probe requiring explicit `--db` and reporting selection/command counts and elapsed time. Never call `reconcileTask` while calling a probe read-only.
- [ ] **4. Run final verification.** Execute targeted suites, `npm run typecheck`, `npm run format:check`, `npm run verify:portable`, `npm test`, and the hermetic build/integration smoke. Report actual counts, failures, and skipped platform checks. Run the approved read-only real-store probe separately with bounded timeout. Request a fresh whole-branch review with particular attention to stale result application, process lifetime, cleanup, and opt-in administration.
- [ ] **5. Commit and stop at activation approval.** Inspect staged names, commit `tasks: verify daemon recovery end to end`. Attach verification evidence to `jp-nqwc`. Present exact installation/start paths, expected unattended actions, cutover sequence, and rollback before requesting permission. Do not install, start, release live worktrees, or close live tasks as part of verification.

## Plan self-review and execution gate

Coverage: selection/bulk status (Task 1); semantics/races (Task 2); auth/timeouts (Task 3); fairness/async work (Task 4); singleton/protocol/health (Task 5); packaging/supervision (Task 6); Pi behavior/notices (Task 7); recovery and measured verification (Task 8). Each Review Focus item has an owning test task. Shared signatures are defined above or in their owning Interfaces block; later tasks consume those names rather than inventing parallel APIs.

Before starting, verify the chosen branch is rebased on the approved target and inspect changes since this baseline. If an assumption breaks, stop and amend this plan rather than building workarounds or silently widening scope.

**Recommended execution:** Native, one writer in this session, because these eight stages share lifecycle and runtime interfaces closely. Use one independent whole-branch review after implementation. Subagent-driven execution is an alternative if JP prefers per-stage implementation/review isolation; do not launch it without that choice.

**Next approval:** JP reviews this plan and selects the execution approach. The implementation gate is distinct from the later installation/activation gate.
