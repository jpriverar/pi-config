# Local Task Reconciliation Daemon

**Date:** 2026-09-24

**Task:** `jp-nqwc` — Move automatic task reconciliation to a local daemon

**Status:** Proposed written design; conversational sections approved, written review pending.

**Baseline:** `pi-config` at `a655fa6`. This document does not authorize implementation or installation.

## Goal

Keep the personal Beads store current while multiple Pi sessions are open, or while none are open, without blocking session startup or running duplicate reconciliation in each session. Design efficient reconciliation and its daemon together; implement them in separately verifiable stages within this work item.

Success means one local reconciler, bounded asynchronous checks, safe lifecycle transitions, useful failure visibility, and no dependency on an AI run.

## Approved product contract

- Full unattended reconciliation, including configured automatic closure and safe expired-execution/worktree cleanup.
- One daemon per local Beads store, supervised as a macOS user LaunchAgent, starting at login after explicit installation.
- Pi sessions retain ordinary task mutations, execution-lease renewal, and direct reads of Beads. They stop performing automatic startup reconciliation at cutover.
- Explicit `task_reconcile` requests also use the daemon, not an independent in-session execution path.
- Results and important failures appear in Pi on subsequent interaction. No desktop notifications, automatic model turns, or agent launches.
- Beads remains the durable task authority. The daemon's in-memory queue is reconstructed after restart.
- A stopped or unavailable daemon does not disable ordinary task operations. Reconciliation requests fail explicitly rather than silently falling back to another reconciler.
- Installation and activation require separate approval after implementation and verification.

## Current implementation and reusable pieces

[`TaskLifecycleService`](../../../lib/task-lifecycle/service.ts) already accepts injected store, clock, check adapters, and pool operations. [`checks.ts`](../../../lib/task-lifecycle/checks.ts) implements PR, time, and manual observations. [`beads-store.ts`](../../../lib/task-lifecycle/beads-store.ts) serializes mutations with a store-scoped file lock and fresh reads. Existing expiry cleanup reserves an exact execution lease and preserves refused worktree releases.

The Pi extension currently constructs these dependencies and synchronously calls `reconcileDue` at `session_start`. That method lists unfinished tasks, then reconciles up to ten entries in source order. It counts tasks/checks before determining whether they need work. `reconcileTask` fetches each task again; active tasks can require additional reads. PR observation occurs before the final mutation lock. The current apply guard checks phase and check ID, not every input to the observation.

The display batching fix in `a655fa6` is separate: it removed classification's per-task dependency queries. It did not add a timer or fix reconciliation selection.

## Architecture

```text
Pi sessions                         macOS launchd
  | ordinary task operations              |
  | direct task reads                     v
  | reconcile request ----------> one daemon per canonical store
  |                               | scanner / due selector
  |                               | deduplicated task queue
  |                               | bounded observations
  |                               | fresh-state validation / apply
  |                               v
  +---------------------------> Beads + existing worktree pool
  |
  +---- local health / results <---- daemon
```

### Component boundaries

1. **Shared reconciliation engine:** candidate selection, preparation of immutable observation inputs, check adapters, and conditional application through the lifecycle service. No timers, socket server, Pi UI, or launchd dependency.
2. **Daemon runner:** clock-driven scanning, queue ownership, cancellation, subprocess execution, singleton ownership, local request handling, and health publication.
3. **Pi client:** forwards explicit requests and presents health/results. Normal lifecycle tools continue using the shared service directly.
4. **Service administration:** explicit build/install/start/stop/status/update/uninstall commands. No implicit installation during an extension load or user turn.

Reuse lifecycle semantics, locks, pool safety checks, and adapters. Do not duplicate their implementations inside the daemon or introduce a general workflow framework.

## Selecting due work

Run one scan on startup and every 60 seconds while running. Never overlap scans. After sleep or restart, inspect current state once rather than replaying missed ticks. A minute is a discovery cadence, not a promise to poll each PR every minute.

List unfinished tasks across all workstreams once. Filter using decoded lifecycle state before spending execution limits. Unknown or malformed lifecycle metadata produces a bounded diagnostic; it is never silently adopted or repaired.

| Candidate                                              | Selection rule                                                                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expired execution                                      | Managed Active task whose execution expiry has passed.                                                                                                                                                           |
| Pending worktree bookkeeping                           | Managed Active task with `acquiring` or `release_pending` resources.                                                                                                                                             |
| Dependency wait                                        | Managed Active/Waiting task retaining a dependency condition whose blockers may be satisfied. Resolve target statuses in deduplicated, bounded bulk reads. Missing or unknown targets are not treated as closed. |
| Typed check                                            | Managed Active/Waiting task retaining a check with absent or elapsed `nextCheckAt`.                                                                                                                              |
| Ordinary actionable, deferred, done, or unmanaged task | No automatic reconciliation candidate.                                                                                                                                                                           |

Blocker reads must include closed/deferred targets; do not infer target completion from absence in the unfinished-task list. Chunk large ID sets rather than creating unbounded command arguments. Do not restore per-task dependency-list fan-out.

The initial snapshot only selects candidates. Fresh reads still decide whether work is valid. A not-yet-due external check must not suppress overdue execution cleanup or pending resource recovery on the same task.

Preserve the current PR polling interval of 15 minutes and bounded error backoff up to six hours. Preserve time/manual check predicates and their existing observation semantics. In particular, an overdue manual check remains pending until explicit operator input; elapsed time is not permission to satisfy it.

Order scheduled candidates by eligibility time, with task ID as a stable tie-breaker. Work without a deadline uses its waiting/resource state timestamp. Queue saturation must retain fairness: deferred admissions keep their place ahead of newly discovered scheduled work, rather than restarting at the first tasks on every scan.

## Queue and observation execution

Maintain at most one queued or running job per task. A later scan reuses the existing job instead of duplicating it. A fresh read at dispatch invalidates obsolete candidates.

Separate local reconciliation from remote observations. The proposed defaults are one local reconciliation lane, two concurrent external commands, and at most 100 admitted task jobs. Additional candidates remain discoverable on the next scan. Multi-PR checks share the external-command limit; two checks must not each create an unlimited fan-out.

Explicit requests join the same queue with bounded priority: when both classes are waiting, alternate explicit and scheduled admissions. Equivalent requests may share a result. Requests with conflicting explicit outcomes are rejected rather than silently coalesced. If an automatic observation is already running, serialize the explicit request after it and revalidate its captured check identity.

Do not hold the lifecycle store write lock while waiting for GitHub. Remote observation returns data only; it never independently changes task state. Local lifecycle and pool operations keep their existing locks and safeguards. One task's failure is recorded without abandoning the rest of the scan or queue.

Use a cancellable command executor with an explicit 30-second default timeout and bounded output for Beads, GitHub, and pool subprocesses. Also bound each complete external observation to 120 seconds, including multi-PR checks. Timeouts must terminate and reap child commands, not merely stop awaiting a promise. Wrapping synchronous pool operations in a Promise does not make them cancellable. Retry uncertain mutations only after read-back; do not assume a killed command made no changes.

Local recovery failures use an in-memory per-task backoff from one minute up to 15 minutes, separate from persisted external-check backoff. A restart may retry a local failure sooner. Repeated identical failures update bounded health counters rather than appending an observation or task comment every minute.

A frozen event loop is not solved by request timeouts. Health must expose an unresponsive service; v1 does not add a second watchdog or promise recovery from every live-process hang.

## Safe application and authority

Preparation captures the task identity and relevant observation inputs: check ID/kind, predicate, target artifact identities and URIs, completion policy, and check schedule/state. Application reacquires the existing mutation lock, reads the latest task, and compares those inputs. A removed or changed check, changed target, newer observation, or superseding transition invalidates the result.

Not every unrelated task edit invalidates an observation. For example, a title edit or a valid execution-lease refresh must not starve a long-lived check. Apply against the latest phase, preserving existing behavior: a satisfied retained condition on Active work is cleared without automatically closing the actively owned task.

Revalidate dependency closure against authoritative blocker data before clearing a dependency condition; queued list data is insufficient. Beads CLI reads are not a cross-issue transaction: v1 does not promise atomicity against an independent blocker reopen after the last read. Preserve native dependency authority in claim/readiness checks and do not advertise exactly-once or cross-issue transactional semantics.

Use stable operation identities for retried logical transitions. Read back persisted results. If command completion is uncertain, report uncertainty and inspect durable state before retrying. A repeated read-only PR request after a crash is acceptable; applying an obsolete result is not.

The daemon has a distinct maintenance identity for locks and diagnostics. It never impersonates a task's owning Pi session or claims actionable work to obtain authority. Existing exact-lease cleanup uses the recorded execution identity, including its expiry, and continues to reject concurrent renewal or unsafe releases.

Preserve these boundaries:

- Manual outcomes require explicit input bound to the current check; they cannot satisfy an unrelated replacement check.
- Automatic closure requires the saved check's `onSatisfied: close` policy and the applicable existing lifecycle rules.
- Dirty, occupied, ambiguous, contradictory, or otherwise unsafe worktrees are not force-released.
- No new work, agent launches, merges, arbitrary task-supplied commands, bulk legacy migration, or changes to execution ownership policy.
- Daemon shutdown does not call Pi's session-interruption handler or relinquish tasks owned by Pi sessions.

## Local requests and singleton ownership

Use a versioned, length-bounded JSON protocol over a user-private Unix-domain socket. Expose only health/status and task reconciliation, not arbitrary commands or generic store writes. Reject unknown fields and unsupported versions. Task IDs and metadata remain untrusted data; construct subprocess argument arrays without shell interpolation.

Resolve the real Beads store path and derive one stable store key from it. Use a short user-private runtime directory indexed by that key, with directory mode `0700` and private files/socket. Reject unsafe ownership, symlink substitutions, store-key collisions, and socket paths exceeding platform limits. The same canonical store must not get separate daemon identities through path aliases.

A reconcile request carries a unique request ID, task ID, and optional explicit manual outcome. Explicit outcomes also bind the request to the observed check fingerprint. The response is a verified final result, a curated rejection, or an error. Wait at most 60 seconds in the Pi client; disconnect/timeout reports an **unknown result**, not cancellation or guaranteed non-execution. A retry retains the request identity and expected check so it cannot apply the old instruction to new work. Completed mutations are recognized from durable operation history; uncommitted requests are not promised durable delivery after a crash.

Reuse the existing file-lock mechanism in a dedicated daemon namespace for singleton ownership, never the normal task-mutation lock. Hold it for the process lifetime. Reject a second live instance. Recover a stale local owner only when death is established; ambiguous or live owners are not stolen. There is no leader lease or leadership transfer among Pi sessions.

Normal Pi tools and the daemon still share the lifecycle write lock. The singleton prevents duplicate daemon work, not concurrent user edits; conditional application remains mandatory.

## Runtime, authentication, and service lifecycle

Provide a standalone Node ESM entry point built from the shared TypeScript modules. Explicit service install/update builds and verifies its runtime and required config assets. The service must not rely on a developer worktree, a global `tsx`, an AI provider, or a running Pi process. Source and built-runtime identity appear in health output.

The proposed administration surface is `task-reconciler install|start|stop|status|update|uninstall`, with a foreground `run` mode for temporary integration tests. Commands resolve one explicit store and report the affected paths and service identity before mutations. Installation does not modify Beads task state as a setup step.

The LaunchAgent uses absolute executable/config paths, a controlled environment, continuous supervision, and a finite shutdown deadline. Its restart behavior is subject to launchd throttling; do not promise immediate restart or execution while logged out. Do not detach command children or set `AbandonProcessGroup`: launchd's normal process-group cleanup is part of crash recovery. `stop` unloads the service so supervision does not immediately restart it. Uninstall removes only verified service-owned registrations/runtime files, never the Beads database, worktrees, or task history.

Configuration supplies the canonical store, pool configuration, executable paths, scan/concurrency limits, and timeouts. Reuse existing lifecycle policy values; avoid copying policy constants into the runner. Paths must not depend on the foreground Pi session's cwd or a shell startup file.

Authentication is noninteractive. Use the correct configured GitHub account for each repository; for this profile, use `jpriverar` for `DataDog` and `jpriverar`, and `jp-riveraruiz_ddog` for `ddoghq`/`ddoghq-sandbox`. Other owners require an explicit mapping, not a global account switch. Obtain credentials at execution time and pass them only to the relevant child process. Do not embed credentials in plist files, config, health output, logs, or task observations. Missing credentials, locked credential storage, and denied access become bounded errors with recovery guidance and backoff.

On graceful shutdown: stop admissions and scans, cancel observations, finish or safely abort/reap in-flight commands, and only then release the socket/singleton. Work interrupted before a durable transition is reconstructed from Beads on restart. Partial worktree operations retain their existing recovery evidence.

Updates are explicit, not a side effect of `/reload`. Stop/drain the old service before changing its runtime, build and verify the replacement, then start and check its health. Preserve the prior runtime for explicit rollback. A failed update remains stopped with a clear error; do not silently resume obsolete policy or fallback reconciliation in Pi. Surface protocol/runtime mismatch to the user.

## Health and Pi-only notices

Publish an atomically replaced, bounded health snapshot containing protocol/runtime identity, process identity, start time, last scan attempt/success, queue counts, and curated recent failures. Refresh the local heartbeat every ten seconds without querying Beads; treat a heartbeat older than 30 seconds as stale. Keep diagnostics user-private and size-bounded. Raw command output, credentials, and arbitrary task metadata are not health payloads.

Pi checks health without waiting for reconciliation. A missing socket, incompatible protocol, stale heartbeat, or failed scan is a visible degraded state, not an empty task list. Distinguish daemon liveness from successful reconciliation: an available socket does not prove scans are succeeding.

Use durable lifecycle transitions/check observations for results and the daemon health snapshot for operational failures. At startup establish a baseline from current state, including unresolved attention conditions, rather than replaying all historical transitions. During later interactions, present newly observed important transitions/errors once per session using a persisted session cursor. Reuse the task-state snapshot where possible instead of adding per-task queries.

Observe existing check `wakeOn` preferences when choosing attention notices. Routine pending polls and unchanged errors are not repeated notices. No cross-session global notification-deduplication service is introduced: two sessions may each show the same relevant state change. This duplicates presentation, not reconciliation work.

No desktop notification integration and no automatic model turn. A notice waits for the user's next interaction; task state itself is updated while Pi is closed.

## Verification and acceptance

| Area                | Required evidence                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate selection | Future checks and unrelated tasks consume no execution slots; due work beyond the old first-ten boundary is eventually admitted.                                                        |
| Dependencies        | Deduplicated bulk lookup; open, deferred, closed, absent, and malformed targets; no per-task `dep list` fan-out.                                                                        |
| Queue               | One job per task, bounded external commands/output, fairness at saturation, one failed task does not abort other jobs.                                                                  |
| Concurrent changes  | Replacement checks/targets, newer observations, cancellation, closure, and manual-vs-scheduled races cannot apply stale outcomes. Unrelated lease refreshes do not starve valid checks. |
| Ownership/cleanup   | Exact-lease renewal races, pending acquire/release recovery, dirty/occupied worktree refusal, and partial-operation restart recovery preserve existing safeguards.                      |
| Process lifecycle   | Two instances for the same canonical store, path aliases, crashes, live/ambiguous locks, timeout termination, shutdown, and sleep/restart catch-up.                                     |
| Local protocol      | Permissions, malformed/oversized payloads, version mismatch, conflicting outcomes, timeout/unknown result, retries, daemon unavailable.                                                 |
| Authentication      | Correct account selection, no global account mutation, unavailable credentials, noninteractive failure, and secret redaction.                                                           |
| Pi integration      | Startup no longer reconciles; normal task operations and lease refresh remain; manual reconciliation uses the daemon; no model wakeups or repeated routine notices.                     |
| Installation/update | Generated LaunchAgent validation, absolute paths, built-runtime identity, stop/uninstall ownership boundaries, failed-update behavior, and rollback.                                    |

Unit tests use fake time, stores, adapters, and executors. Process/integration tests use temporary Beads stores, Git repositories, pool roots, sockets, and command fixtures. Supervision tests use a uniquely named test service only with explicit approval; never replace the user's live service to test installation.

Benchmark selection and command counts against the real store using read-only operations. Do not call live reconciliation as a supposedly read-only benchmark: it can mutate tasks and release worktrees. Report measured latency rather than promising a sub-second scan; embedded Dolt still imposes process/query cost.

Acceptance requires fresh targeted tests, repository typecheck/format checks, the full suite or explicitly reported blockers, temporary-store end-to-end evidence, and a reviewed activation/rollback procedure. Real daemon activation remains separately approved.

## Delivery and cutover

Keep this as one work item with verifiable stages:

1. Implement/test reusable selection and safe prepare/observe/apply pieces without enabling a daemon.
2. Add the standalone runner, local client, supervision commands, and health reporting; validate against temporary stores.
3. Integrate the Pi client and remove session-start automatic reconciliation for the cutover version.
4. After separate activation approval, update/reload or close **all** old Pi runtimes, then enable the daemon and verify health and real-store outcomes.

Old loaded extensions can still execute their previous startup reconciler. A new daemon cannot magically fence code that predates its protocol; the rollout must explicitly eliminate those runtimes. Do not assume updating files alone reloads running extensions.

Do not complete this work item merely because the shared engine tests pass. Installation/activation status and any remaining operational limitations must be reported distinctly.

## Non-goals and known trade-offs

- No distributed or multi-host store coordination, Windows/Linux service installer, leader election among Pi sessions, or second durable job database.
- No exact-once network-read guarantee, cross-issue Beads transaction, or automatic recovery from every live-process hang.
- No implementation work scheduling, subagents, automatic task claiming, merges, or new task lifecycle policy.
- No redesign of task-table rendering, general caching, or Beads/Dolt deployment.
- macOS login/sleep and credential availability bound when work can run; no claim of execution while the laptop is asleep or logged out.

## References

- [Current task lifecycle contract](../../task-lifecycle.md).
- [Lifecycle service](../../../lib/task-lifecycle/service.ts), [store](../../../lib/task-lifecycle/beads-store.ts), [check adapters](../../../lib/task-lifecycle/checks.ts), and [file-operation lock](../../../lib/file-operation-lock.ts).
- [Pi lifecycle composition](../../../extensions/task-lifecycle/index.ts), [work-state presentation](../../../extensions/task-lifecycle/work-state.ts), and [pool runtime](../../../extensions/worktree-pool/runtime.ts).
- Local macOS `man 5 launchd.plist`: process supervision, absolute program paths, environment configuration, finite exit timeout, and process-group cleanup. This design uses launchd as a process supervisor, not as a task scheduler.
