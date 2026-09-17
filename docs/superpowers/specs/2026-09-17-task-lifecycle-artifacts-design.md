# Goal-Preserving Task Lifecycles, Dependencies, Artifacts, and Checks

**Status:** Approved by JP on 2026-09-17.

**Design work item:** `jp-blph` (closed)

**Implementation work item:** `jp-mkt4`

**Repository:** `jpriverar/pi-config` is the sole source repository for the lifecycle and worktree-pool implementation, tests, and design documents. Beads and worktree lease data remain external runtime state.

**Extends:**

- `docs/specs/2026-08-11-l1-work-state-design.md`
- `docs/superpowers/specs/2026-09-01-thin-worktree-pool-design.md`

## Purpose

Keep one task as the durable record of one goal while separating three lifetimes that are currently conflated:

1. the goal's lifecycle;
2. an agent's active execution lease;
3. temporary resources such as a worktree.

A task remains open until its acceptance condition is satisfied, cancelled, or superseded. It does not remain `in_progress` merely because a pull request, deployment, person, date, or other external condition is pending. When active execution ends, the agent releases temporary resources and moves the task either back to actionable work or into a structured waiting state.

Tasks also retain typed references to durable artifacts they produce, including branches, pull requests, documents, dashboards, deployments, reports, and commits. A deterministic check may target an artifact, but an artifact does not imply a check or completion condition by itself.

## Evidence

The design is based on the Beads store, raw Trajectory session JSONL, current worktree lease records, and live GitHub state observed on 2026-09-17.

### Task state

- The store contained 269 tasks: 228 closed, 23 open, 12 in progress, 3 blocked, and 3 deferred.
- In-progress tasks had a median start age of 7.4 days and p90 of 14.2 days.
- The oldest in-progress task had not been updated for 21.3 days.
- All three blocked tasks had been untouched for about 28 days and had no Beads dependency records.
- Closed tasks were usually fast: median created-to-closed time was under one day and p90 was 4.1 days.
- `bd status --json` reported zero blocked issues while `bd list --status blocked` returned three, and those three had no dependency edges. The mismatch is consistent with Beads distinguishing dependency-derived blockedness from manually stored `status=blocked`; implementation must verify that behavior and derive lifecycle state from issue rows plus the native dependency graph rather than one aggregate count.
- Installed Beads 1.1.2 rejects `status=waiting`; valid native statuses are `open`, `in_progress`, `blocked`, `deferred`, `closed`, `pinned`, and `hooked`. The explicit Waiting phase must therefore live in versioned Pi lifecycle metadata rather than a new native status.

### Session behavior

Across 1,104 sessions and 254,219 unique events since 2026-08-01:

- 387 transitions claimed work as `in_progress`.
- 186 task closes were recorded.
- 28 of 103 tasks with a visible claim ended their last claim session without a same-session close.
- For tasks that did close after a claim, claim-to-close latency was p50 0.1 days, p90 1.5 days, and maximum 5.4 days.
- 77 of 103 visibly claimed tasks were claimed more than once.
- At least 20 transitions reopened work after it had been closed.

Waiting is common and is not synonymous with a task dependency:

- 46 blocked episodes were observed.
- 24 were related to PR or review state.
- 10 were related to CI or QA.
- 6 were related to deployment or runtime evidence.
- 2 required a human decision.
- Only 1 was an actual dependency.
- Resolved blocked episodes were normally short: p90 0.9 days and maximum 7.6 days. The current 28-day blocked tasks are clear stale outliers.

### Worktree behavior

- Session events contained 133 worktree acquisitions and 86 releases.
- Only 14 of 29 task-closing sessions released a worktree.
- Of 20 sessions that created a PR, 15 closed a task but only 5 released a worktree.
- The current pool contained nine clean lease records. Eight owner PIDs were dead.
- Five dead-owner worktrees pointed to merged PRs; three pointed to open PRs.
- Four in-progress tasks had every linked PR merged or closed.

These observations show that task completion, active agent ownership, and worktree retention need independent state.

### Evidence limitations

The Trajectory SQLite cache could not be opened by the query tool (`unable to open database file (14)`), so session analysis used raw JSONL. Some historical tool events had empty inputs, and five current in-progress tasks lacked a visible claim event in the analyzed records. Session-derived counts are therefore lower bounds. Current Beads, worktree, and GitHub observations were read directly.

## Decision

Use one task for one goal by default. A pull request, review, deployment, or document is part of that task's delivery history, not automatically a second task.

Relationships between goals use Beads' native dependency graph, not artifact records or duplicated task-check targets. A task waiting on another task uses a native `blocks` edge. Other native relationship types such as `tracks`, `parent-child`, `discovered-from`, `validates`, and `supersedes` preserve task-to-task meaning without pretending either task is an artifact.

One goal task may produce zero to many branches, commits, pull requests, documents, and temporary worktrees, sequentially or concurrently. Artifact or resource cardinality alone does not justify splitting the goal.

Create a separate task only when the new work has an independently reviewable deliverable, owner, or acceptance condition. Examples include a distinct production rollout, a follow-up migration, or a new investigation. Do not create a task merely to watch another task's PR merge.

## Alternatives considered

### Close the original task and create a tracking task

This separates implementation from follow-up, but duplicates context and creates another record that can become stale. It also makes goal history harder to read. Rejected as the default.

### Keep one goal task with typed lifecycle state

The original task stays authoritative. It can be actionable, active, waiting, deferred, or done without retaining an agent or worktree unnecessarily. Chosen as the default.

### Use a goal parent with execution child tasks

This is useful for multi-deliverable programs with separate owners and acceptance conditions. It is unnecessary overhead for ordinary work and remains an explicit decomposition option, not the default lifecycle.

### Store dependency waiting as native `blocked`

This would make raw status output look intuitive, but it would override Beads' blocker-aware readiness model. Closing the blocker would still require a lifecycle write to return the dependent task to `open`. Rejected in favor of preserving the native `open` plus unresolved `blocks` representation while displaying the explicit Pi lifecycle phase **Waiting**.

### Derive waiting without persisting a lifecycle phase

This avoids one metadata field, but leaves timestamps and subtypes without an explicit state and makes it easier for clients to present native `status=open` as actionable. Rejected. Version 1 persists the Pi lifecycle phase and waiting subtype while treating native status and dependencies as the compatibility projection and task graph.

## Goals

1. Preserve one task's goal, decisions, artifacts, checks, and outcome history in one record.
2. Make `in_progress` mean that an agent is actively executing work, not that an external event remains pending.
3. Make every waiting task explain what it is waiting for, how it will become ready or complete, and when an external check will run next when applicable.
4. Release clean worktrees when an owning agent deliberately leaves active execution.
5. Surface stale execution leases, overdue checks, and resource mismatches deterministically.
6. Let any future session reconcile a task; progress must not depend on the original agent staying alive.
7. Keep the thin worktree pool ignorant of task and PR semantics.
8. Preserve external artifacts as typed references without copying their contents into Beads.
9. Correlate task-owned resources deterministically while keeping raw pool inspection, repair, and taskless allocation available.

## Non-goals

1. Build a general project-management system or replace GitHub, Google Drive, Jira, Conductor, or Datadog.
2. Create a child task for every PR, branch, document, or deployment.
3. Automatically infer every artifact from arbitrary shell output in the first implementation.
4. Copy external artifact contents into Beads.
5. Add arbitrary Boolean check graphs or multiple simultaneously active wake conditions in version 1.
6. Run a permanently resident background agent.
7. Automatically delete dirty, occupied, malformed, or ambiguous worktrees.
8. Move worktree safety, process supervision, or task semantics into `worktree_pool`.
9. Treat ordinary polling as task progress or reset stale-state age on every check.
10. File follow-up implementation tasks without explicit approval.
11. Modify Beads to add a new native `waiting` status.
12. Hide or replace the raw `worktree_pool` tool globally.

## Lifecycle model

### Explicit Pi phases and Beads representation

| `piLifecycle.phase` | Waiting subtype | Native Beads representation | Meaning |
| --- | --- | --- | --- |
| `actionable` | — | `status=open`, no unresolved `blocks` edge, no active check | The goal is unresolved and an agent can make progress now. |
| `active` | — | `status=in_progress` | A live execution lease owns the next action. |
| `waiting` | `dependency` | `status=open` plus one or more unresolved native `blocks` edges | Another goal must complete before this one is ready. |
| `waiting` | `check` | `status=blocked` plus one structured external or internal check | A non-task condition must change. |
| `deferred` | — | `status=deferred` | JP intentionally parked the goal until a review date or explicit decision. |
| `done` | — | `status=closed` | The goal was completed, cancelled, or superseded with a recorded disposition. |

The Pi phase and optional waiting subtype are persisted in the issue's versioned lifecycle metadata. Native status is a compatibility projection, while the native dependency graph remains authoritative for task-to-task relationships and blocker satisfaction.

A dependency-waiting task therefore has low-level `status=open`, but Pi must always display it as **Waiting — blocked by `<task-id>`**, never as Open or Actionable. Any query or view that equates every `status=open` issue with ready work is incorrect; readiness must account for unresolved native blockers.

### State machine

```text
                         claim
             ┌────────────────────────┐
             │                        ▼
        actionable                  active
             ▲                      │   │
             │ action needed        │   │ acceptance satisfied
             │                      │   ▼
             └──── waiting ◄────────┘  done
                    │       yield
                    │
                    ├─ check satisfied ─────► done
                    └─ action required ─────► actionable

        actionable / active / waiting ─────► deferred
        deferred review date reached ──────► actionable
        active ownership timeout ──────────► actionable + interruption event
```

Closing and reopening remains valid. A reopen records why the previous acceptance no longer holds or what new action appeared.

### Invariants

These invariants apply after an issue adopts version-1 lifecycle metadata. Legacy issues remain visible as migration candidates rather than being treated as corrupt.

1. Every lifecycle-managed task persists exactly one recognized `piLifecycle.phase`.
2. `phase=active` requires `status=in_progress` and exactly one current execution lease.
3. `phase=actionable` requires `status=open`, no unresolved native `blocks` edge, and no active check.
4. `phase=waiting` requires exactly one waiting subtype and one authoritative wait mechanism.
5. `waiting.kind=dependency` requires `status=open`, at least one unresolved native `blocks` edge, and no `activeCheck`; blocker IDs are read only from the native graph.
6. `waiting.kind=check` requires `status=blocked` and exactly one active external or internal structured check.
7. `phase=deferred` requires `status=deferred`; `phase=done` requires `status=closed` and a disposition.
8. Every phase except `active` has no live execution lease.
9. A deliberately waiting or done task has no unreleased active worktree resource; released resource history remains attached.
10. An Active task may own zero to many reconciled worktree resources without creating additional task execution leases.
11. An Actionable task may retain zero to many resources only after an active ownership timeout, and the complete resource set must be shown to the next agent before claim.
12. Additional task worktree acquisition is blocked only by a pending, malformed, contradictory, or ambiguous association; other healthy task-linked worktrees, including dirty worktrees owned by the current execution, do not block it.
13. No task has two unreleased worktree resources for the same canonical repository and full branch ref.
14. Dirty or ambiguous resource state is preserved and surfaced; it is never silently released.
15. Polling updates `lastCheckedAt`, not `stateEnteredAt` or `lastProgressAt`.
16. A done task records a disposition: `completed`, `cancelled`, or `superseded`.
17. A superseded task records the native `supersedes` relationship when the replacing task exists; an artifact reference is used only when no replacing task exists.
18. Pi never presents `phase=waiting` as Open or Actionable, regardless of native status.
19. Reconciliation is idempotent. Repeating the same observation cannot append duplicate artifacts, checks, dependencies, interruption events, or transitions.

## Durable task metadata

Beads remains the source of truth. The lifecycle extension stores one versioned metadata subtree while preserving unknown metadata keys owned by other tools.

Conceptual version-1 shape:

```json
{
  "piLifecycle": {
    "version": 1,
    "phase": "waiting",
    "waiting": {
      "kind": "dependency"
    },
    "stateEnteredAt": "2026-09-17T04:00:00Z",
    "lastProgressAt": "2026-09-17T04:00:00Z",
    "execution": null,
    "artifacts": [],
    "activeCheck": null,
    "checkHistory": [],
    "transitionHistory": [],
    "resources": [],
    "disposition": null
  }
}
```

The lifecycle phase and waiting subtype are authoritative fields inside the Beads issue's versioned metadata. Native Beads status remains a required compatibility projection, and native dependency edges remain authoritative for task relationships and blocker satisfaction. Lifecycle operations update the phase, subtype, and compatible native status together; reconciliation surfaces and repairs drift.

The adapter performs read-modify-write under one machine-local lifecycle operation lock, preserves unrelated metadata, and verifies the resulting issue. Every operation is retry-safe because Beads and worktree removal cannot share one transaction.

Before implementation, a focused compatibility test must verify that the installed Beads version round-trips nested metadata through `bd create`, `bd update`, `bd show --long --json`, and `bd list --json`. If Beads cannot patch the `piLifecycle` subtree without replacing unrelated metadata, the adapter must merge the full object under the operation lock rather than flattening the model into labels or notes.

## Active ownership

The `execution` object is a temporary ownership marker meaning “this Pi session is currently working on this task.” It represents active work, not long-term responsibility:

```json
{
  "sessionId": "...",
  "claimedAt": "...",
  "lastActivityAt": "...",
  "expiresAt": "...",
  "resourceSnapshot": {
    "observedAt": "...",
    "resourceIds": ["resource-uuid-1", "resource-uuid-2"]
  }
}
```

The extension obtains the session ID from Pi's session context/environment. Relevant tool or turn activity refreshes active ownership. A captured shutdown for quit, new-session, resume, or fork ends ownership; reload preserves and revalidates ownership for the same session. If no shutdown is captured because Pi crashes or disappears, a bounded timeout ends ownership later. A live current session or long-running operation prevents premature timeout.

When active ownership times out, reconciliation clears the execution lease, sets `phase=actionable` and native `status=open`, and appends one idempotent `execution_interrupted` transition containing the prior session ID, last activity time, and observation time. It does not infer that the goal is complete or create a synthetic waiting check.

Before another agent claims the task, lifecycle context is reconciled against authoritative resource state and presented with the task:

- branches, commits, PRs, documents, and other durable outputs remain attached as artifacts;
- every unreleased worktree includes its repository, path, claim ID, branch, recorded cleanup state, current pool claim/registration state, and current read-only Git branch, HEAD, and cleanliness;
- the claim operation records the complete reconciled resource snapshot shown to the new execution;
- clean old claims may be explicitly released before normal work continues;
- dirty retained worktrees may be resumed after the new execution receives the snapshot;
- malformed, contradictory, or ambiguous associations are preserved and become the first explicit action for the newly owning agent.

Lifecycle metadata is correlation evidence, not authority for whether a worktree still exists or is safe to release. `worktree_pool` remains authoritative for managed claim and registration state; Git remains authoritative for current checkout contents.

The exact inactivity interval is configuration, not lifecycle semantics. It must be longer than ordinary gaps between tool events and must be tested with a long-running operation before rollout.

## Artifacts

An artifact is a durable result or reference produced while pursuing the goal.

```json
{
  "id": "artifact-uuid",
  "kind": "pull_request",
  "uri": "https://github.com/org/repo/pull/123",
  "title": "Fix bug X",
  "role": "deliverable",
  "sourceArtifactIds": ["branch-artifact-uuid"],
  "producedAt": "2026-09-17T04:00:00Z",
  "producedBySession": "session-id",
  "supersededAt": null
}
```

### Initial artifact kinds

- `branch`
- `commit`
- `pull_request`
- `document`
- `dashboard`
- `deployment`
- `report`
- `other`

### Artifact roles

- `deliverable` — directly satisfies some or all acceptance criteria;
- `evidence` — supports verification or a decision;
- `supporting` — useful context that does not determine completion.

A task may contain zero to many artifacts of every kind. Artifacts are deduplicated by canonical `(kind, uri)` identity. A branch URI includes repository identity and full ref, not only the branch name. Optional `sourceArtifactIds` relate a PR or other output to the branches or artifacts that produced it without turning the artifact set into a second task graph. Removing a worktree does not remove its branch artifact. Artifact references remain visible after task closure.

A Beads task is never stored as an artifact. Task-to-task relationships use native dependency edges: `blocks` for readiness, `supersedes` for replacement, and the other native relation types when their documented meaning fits.

Version 1 supports explicit typed attachment and deterministic branch attachment by `task_worktree_acquire`. Automatic capture from GitHub, Google Workspace, Conductor, and arbitrary tool results is a later integration phase. High-confidence capture may be added adapter by adapter; the system must not scrape arbitrary assistant prose or shell output into authoritative task history.

## Resources

A resource is temporary working capacity, not a produced artifact. Version 1 recognizes managed worktree claims:

```json
{
  "id": "resource-uuid",
  "kind": "worktree",
  "repository": "dd-source",
  "claimId": "...",
  "operationId": "...",
  "path": "...",
  "branch": "jpriverar/example",
  "branchArtifactId": "branch-artifact-uuid",
  "acquiredAt": "...",
  "releasedAt": null,
  "cleanupState": "active"
}
```

The lifecycle layer records task correlation and policy. The existing `worktree_pool` core remains the sole allocator and remover and continues to enforce capacity, path, Git-registration, claim, and conservative clean-release behavior. Read-only Git inspection remains authoritative for branch, HEAD, and worktree cleanliness.

A task may contain zero to many resource records, including multiple simultaneously active worktrees in different repositories or on different branches. Each resource links to its durable branch artifact. A resource is:

- **reconciled** when its task record, pool claim/registration state, and read-only Git identity agree;
- **released** when pool removal succeeded or reconciliation proves the claim and registration are absent;
- **unresolved** only when acquisition is pending or recorded, pool, and Git identity are malformed, contradictory, missing unexpectedly, or ambiguous.

Healthy reconciled resources do not prevent additional task worktree acquisition. Pool capacity and the existing one-writer-per-worktree rule remain the bounds.

### Public operation boundary

The raw `worktree_pool` tool remains exposed. Its operations retain their thin meanings:

- `list` and `repair` remain directly available for inspection and explicit recovery;
- `acquire` and `release` remain directly available for work with no lifecycle-managed task or for unassociated claims;
- the pool never reads or writes Beads and never infers task ownership.

Lifecycle-managed task work uses coordinated wrappers around the same pool core:

```text
task_worktree_acquire(taskId, repository, branch, startPoint?)
task_worktree_release(taskId, claimId)
```

`task_worktree_acquire` verifies that the current session actively owns the task, rejects unresolved resource associations and duplicate canonical repository/full-branch pairs, records an idempotent pending acquisition intent, calls the existing pool acquire implementation, finalizes the task resource with the returned claim ID and path, attaches or reuses the branch artifact, and returns the complete task/resource context. Other reconciled resources do not block the operation.

`task_worktree_release` verifies that the claim belongs to the task, calls the existing pool release implementation, and marks the resource released only after pool success. A pool refusal leaves both the task association and resource intact and reports the exact reason.

The tools are contextually fail-closed rather than globally hidden:

- direct raw `acquire` is rejected while the current session actively owns a lifecycle-managed task;
- direct raw `release` is rejected for a claim linked to a lifecycle-managed task;
- the error identifies the coordinated wrapper to use;
- raw `list` and explicit `repair` remain available in every context;
- reconciliation observes repair or other out-of-band state changes and updates task correlation without moving task semantics into the pool.

The task-lifecycle extension owns this contextual guard through Pi's pre-execution `tool_call` hook and rejects a disallowed call before dispatch. The raw `worktree_pool` extension and core receive no task ID, import no Beads adapter, and perform no task lookup. Both the raw tool adapter and lifecycle wrappers depend one-way on the same task-agnostic pool core:

```text
task-lifecycle extension ──► Beads
task-lifecycle extension ──► WorktreePool core
worktree-pool extension  ──► WorktreePool core
WorktreePool core        ──► Git and filesystem only
```

A partial coordinated operation remains explicit and recoverable. If pool acquisition succeeds before task finalization, the pending intent and exact pool claim consume capacity until reconciliation links or surfaces them; additional task acquisition is blocked until that unresolved association is repaired, and retries cannot duplicate the same allocation. Other reconciled resources remain valid. If pool release succeeds before task metadata is updated, reconciliation observes the missing claim and marks the task resource released. Exact implementation wiring belongs to the implementation plan; these outcomes are the required contract.

When the owning agent deliberately transitions from active to waiting or done:

1. durable branch/commit/PR references are attached as artifacts;
2. relevant verification evidence is recorded;
3. each known task-linked worktree claim is explicitly released through `task_worktree_release`;
4. only after the coordinated wrapper confirms pool release does the task leave `in_progress`;
5. a release failure keeps the task active with a visible cleanup error so the agent cannot silently abandon capacity.

If the agent dies, reconciliation does not perform unattended destructive cleanup. It ends active ownership, returns the task to Actionable, records the interruption, and surfaces the exact resource to the next agent. A later agent may inspect and explicitly release a clean claim. Dirty or uncertain state remains preserved.

This design does not restore worktree-pool session supervision, PID authorization, writer gates, automatic shutdown release, or automatic stale reclamation removed by the thin-pool design.

## Checks and task dependencies

`phase=waiting` has two explicit subtypes:

1. `dependency` — one or more unresolved native Beads `blocks` dependencies; or
2. `check` — exactly one active lifecycle check for a non-task condition.

The native graph is authoritative for task-to-task blocking. Lifecycle metadata persists `waiting.kind=dependency`, transition timestamps, and policy but does not copy a blocker task ID into `activeCheck`.

A task may attach multiple PRs or other checkable artifacts. One lifecycle check may target an explicit subset of artifacts of the same kind with a simple `all` or `any` aggregation; version 1 does not support arbitrary Boolean check graphs. Under `all`, the task remains waiting until every target satisfies the predicate, while an action-required observation on any target wakes the task. Attaching an artifact never adds it to a check implicitly.

```json
{
  "id": "check-uuid",
  "kind": "github_pull_request",
  "targetArtifactIds": ["artifact-uuid-1", "artifact-uuid-2"],
  "predicate": { "operator": "all", "state": "merged" },
  "onSatisfied": "close",
  "wakeOn": ["changes_requested", "closed_unmerged"],
  "state": "pending",
  "createdAt": "...",
  "lastCheckedAt": "...",
  "nextCheckAt": "...",
  "lastObservation": "open",
  "errorCount": 0
}
```

### Check outcomes

- `pending` — remain waiting and schedule the next bounded check;
- `satisfied` — close the task or make it actionable according to `onSatisfied`;
- `action_required` — make the task actionable and record the observation;
- `error` — remain waiting, apply bounded backoff, and show an inline warning after repeated failure.

### Native task dependencies

Waiting on another task creates a native edge in the documented direction:

```text
bd dep add <dependent-task> <blocking-task> --type blocks
```

The dependent task uses native `status=open` but persists `phase=waiting` and `waiting.kind=dependency` while the edge is unresolved. Pi displays it as **Waiting — blocked by `<task-id>`**, never Open or Actionable. Closing the blocker must make the dependent task ready through Beads' normal behavior. Lifecycle reconciliation then changes its persisted phase to `actionable` and records the transition; it does not poll a parallel `task` adapter or reproduce the edge in metadata. Cycle detection and dependency satisfaction remain Beads' responsibility.

Non-blocking task relationships also remain native. In particular, replacement uses `supersedes` rather than an artifact reference when a replacing task exists.

### Initial check adapters

1. `github_pull_request`
   - satisfied when the configured PR predicate holds, initially `merged`;
   - action required on changes requested, merge conflict requiring edits, or closed-unmerged;
   - pending while review or merge is still external.
2. `time`
   - becomes actionable at a fixed timestamp.
3. `manual`
   - records a human decision or external event that cannot be polled;
   - requires a review time and is surfaced when overdue.
Artifact targets are optional for `time` and `manual` checks, which carry their target directly in the adapter-specific predicate.

CI, deployment, Datadog telemetry, Google Workspace, and Jira adapters follow the same interface but are not required for the first implementation. A document can be an artifact without having an automated check.

## Lifecycle operations

The lifecycle extension owns strict, high-level operations. Raw status mutation remains available for repair, but agent instructions route ordinary work through these operations.

### Claim

1. Lock and read the issue.
2. Require `phase=actionable` with no unresolved `blocks` edge.
3. Reconcile every retained resource against pool and read-only Git state and present the complete artifact/resource handoff.
4. Surface unresolved resource associations as the task's first action; they block new worktree acquisition but do not prevent claiming the task to resolve them.
5. Create the execution lease from the current Pi session with the acknowledged resource snapshot.
6. Clear a completed waiting check into history.
7. Set `phase=active`, clear the waiting subtype, and set native status to `in_progress`.
8. Verify the resulting invariant.

### Attach artifact

1. Canonicalize and validate the typed URI or ref.
2. Deduplicate by `(kind, uri)`.
3. Append producer/session evidence when known.
4. Preserve existing artifacts and unrelated metadata.

### Wait

1. Require the current execution lease or an explicit repair override.
2. Attach supplied artifacts and verification evidence.
3. Require exactly one wait mechanism:
   - for task waiting, create or validate native `blocks` edges and no `activeCheck`;
   - otherwise, validate one active structured check and its target.
4. Explicitly release known clean task-linked worktree claims through `task_worktree_release`.
5. Abort and surface cleanup when release fails.
6. Clear the execution lease.
7. Set `phase=waiting` and `waiting.kind=dependency` or `check`.
8. Project native status as `open` for dependency waiting or `blocked` for check waiting.
9. Record `stateEnteredAt` independently from dependency observations or polling timestamps.
10. Verify that Pi presentation resolves the task to Waiting, never Open or Actionable.

### Reconcile

1. Read native dependency state and select due lifecycle checks with a bounded limit.
2. Let Beads determine whether tasks with `blocks` edges are ready.
3. When the final blocker resolves, set `phase=actionable`, clear the waiting subtype, and retain native `status=open`; use the latest blocker closure time for `stateEnteredAt` when available, otherwise the observation time.
4. Run due typed check adapters read-only.
5. Persist normalized check observations without duplicating history.
6. Keep unresolved dependencies and pending checks waiting without resetting state age.
7. Close satisfied check-waiting tasks or change action-required tasks to `phase=actionable` and native `status=open`.
8. Back off check failures and surface repeated errors.
9. Detect active ownership timeouts, return those tasks to `phase=actionable`, append one `execution_interrupted` transition, and reconcile retained resource context.
10. Detect phase/status drift and resource/state invariant violations.

### Close

1. Require a reason and disposition.
2. Require no active execution lease or worktree resource.
3. Record acceptance evidence and artifact references.
4. Move any active check into history; preserve native dependency edges as task history.
5. Set `phase=done`, clear the waiting subtype, and set native status to `closed`.
6. Preserve the complete artifact and transition history.

### Reopen

1. Record why the previous disposition no longer applies or what new action appeared.
2. Clear the terminal disposition.
3. Without assigning an execution lease, set native status to `open` and derive the Pi phase:
   - `waiting` with subtype `dependency` if an unresolved native blocker remains;
   - otherwise `actionable`.
4. Preserve prior checks, native relationships, and artifacts.

## Pi integration

The implementation is a global Pi extension adjacent to the existing work-state integration.

- `before_agent_start` injects a compact state view derived from lifecycle metadata plus native dependency state: active, actionable, waiting, overdue, and resource-warning items. It must never classify an issue as actionable merely because native `status=open`.
- `session_start` performs a bounded reconciliation of due local checks and a bounded GitHub PR check batch. It does not start a permanent watcher.
- `session_shutdown` records the shutdown reason. If the session still owns an Active task during quit, new-session, resume, or fork, it ends ownership, returns the task to Actionable, and records the interruption; reload preserves and revalidates ownership for the same session. No shutdown path closes tasks or removes worktrees implicitly.
- `tool_execution_end` may later support high-confidence artifact capture. Task-linked worktree correlation is handled by coordinated wrappers in version 1 rather than inferred from arbitrary tool output.
- Custom tools implement claim, artifact attachment, task-worktree acquire/release, wait, reconcile, close, and reopen operations with strict schemas and actionable errors.
- The task-lifecycle extension's `tool_call` guard rejects raw pool acquire/release only in the task-linked contexts defined by the public operation boundary, before dispatch to `worktree_pool`; the pool extension does not participate in the task lookup or rejection.

Pi's session remains a lens over Beads, as in L1. Lifecycle state is not reconstructed from session entries and does not disappear when a session is compacted, forked, or deleted.

The extension must not run network checks in `before_agent_start`, where they would add unpredictable latency to every prompt. Network reconciliation belongs to bounded `session_start`, an explicit tool/command, or a future external scheduler.

## State presentation

The ordinary injected view stays compact:

```text
ACTIVE
  jp-123  Fix bug X · session active · branch artifact

ACTIONABLE
  jp-456  Investigate timeout
  jp-321  Fix parser · previous ownership ended · worktree claim abc at /path

WAITING
  jp-789  Fix review issue · PR #123 open · next check 14:00 · waiting 2d
  jp-654  Roll out migration · blocked by jp-600 · waiting 1d
```

A detailed task view shows:

- goal and acceptance criteria;
- lifecycle phase and age in that phase;
- active execution lease when present, or the most recent ownership interruption;
- unresolved native blockers or active check, latest observation, and next check;
- artifacts grouped by role and kind;
- retained resources with both recorded correlation and current `worktree_pool` state;
- terminal disposition or superseding task;
- transition and check history.

Polling timestamps never hide how long a task has been waiting. The injected context has a measured token budget and omits full artifact/check history unless requested.

## Staleness and warnings

Warnings annotate a task in its current phase; they are not additional lifecycle states or UI sections. A warning is shown when an invariant is violated or a promised transition is overdue:

- `in_progress` without a valid execution lease;
- active ownership timed out but has not yet been reconciled;
- missing or unknown lifecycle phase or waiting subtype;
- phase/status/dependency projection mismatch;
- waiting without either an unresolved native blocker or an active check;
- a dependency-waiting task presented as Open or Actionable;
- actionable work retains a resource but its verified context is not shown;
- due check not run;
- repeated adapter error;
- waiting or done work has an unreleased worktree;
- deferred work passed its review time;
- done work has active execution/resource state;
- malformed or unsupported lifecycle metadata.

The system distinguishes:

- `stateEnteredAt` — how long the task has been in this lifecycle phase;
- `lastProgressAt` — last evidence that changed the goal's outcome;
- `lastCheckedAt` — last observation that may have found no change;
- `updated_at` — Beads storage mutation time, not a reliable freshness signal.

This prevents a poller from making a month-old waiting task look fresh.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| PR remains open with no action | Stay waiting; no agent or worktree retained. |
| PR merges | Close idempotently with the PR artifact as evidence. |
| Review requests changes | Reopen as actionable; do not allocate a worktree until claimed. |
| PR closes unmerged | Reopen for a decision; do not report success. |
| Check adapter fails | Stay waiting, record bounded error metadata, and back off. |
| Waiting check is overdue | Annotate the Waiting task as overdue; any session can reconcile it. |
| Agent session ends while its task is still Active | Return the task to Actionable, append `execution_interrupted`, and surface retained resources. |
| Agent dies without shutdown | The active ownership timeout performs the same transition when detected. |
| Deliberate wait cannot release worktree | Abort the wait transition and show the cleanup failure. |
| Prior agent left a clean worktree | Show the exact claim to the next agent for explicit inspection/release before allocating another. |
| Worktree is dirty or ambiguous | Preserve it and show resource resolution as the first action on the Actionable task. |
| Raw pool acquire is attempted while a session owns an Active task | The task-lifecycle guard rejects before dispatch and directs the agent to `task_worktree_acquire`; the pool receives no call or task data. |
| Raw pool release targets a task-linked claim | The task-lifecycle guard rejects before dispatch and directs the agent to `task_worktree_release`; the pool receives no task data. |
| Coordinated acquire reserves a pool claim but task finalization fails | Preserve the pending intent and exact claim, consume capacity, block further task acquisition until reconciliation, and prevent a duplicate retry of that allocation. |
| Coordinated release removes the claim but task finalization fails | Reconciliation observes the missing claim and marks the task resource released. |
| Metadata write partially succeeds | Re-read and reconcile idempotently under the lifecycle lock. |
| Beads aggregate disagrees with issue rows or dependency state | Read and validate the issue plus its native dependency graph. |
| Unknown lifecycle, artifact, or check version | Preserve data, refuse unsafe transition, and surface migration guidance. |

## Migration

There is no bulk automatic conversion of current issues.

1. Add read-only classification that reports current stale states and proposed mappings.
2. Introduce versioned metadata with explicit phase/subtype and strict lifecycle operations for new transitions.
3. Migrate active issues individually:
   - attach known artifacts;
   - assign the explicit lifecycle phase and waiting subtype;
   - add a native blocking dependency, add an external waiting check, or make the task actionable;
   - identify and explicitly release clean stale worktrees;
   - close tasks whose configured acceptance condition is already satisfied;
   - record supersession where another task replaced the work.
4. Keep issues without lifecycle metadata readable through a blocker-aware legacy L1 view; never equate every native `status=open` issue with actionable work.
5. Require explicit approval before bulk closing tasks or releasing current production worktrees.

## Implementation phases

### Phase 1: lifecycle core

- Beads metadata compatibility test and adapter.
- Explicit persisted phase and waiting-subtype model.
- Phase/status/dependency projection invariants and strict claim/wait/close/reopen operations.
- Explicit typed artifact attachment.
- Active ownership timeout reconciliation and idempotent interruption history.
- Compact active/actionable/waiting injection with inline overdue and resource warnings.
- Coordinated task-worktree acquire/release wrappers, contextual raw-pool guards, pending-intent recovery, and pre-claim resource reconciliation.

### Phase 2: native dependencies and first deterministic checks

- Native Beads dependency integration plus GitHub PR, time, and manual adapters.
- Bounded session-start and explicit reconciliation.
- Idempotent close/reopen behavior.
- Error backoff and overdue surfacing.

### Phase 3: richer integrations

- High-confidence artifact capture from tool results.
- GitHub review and CI detail.
- Google Workspace, Jira, Conductor, deployment, and Datadog evidence adapters.
- Rich task/artifact UI if the compact text view proves insufficient.

Phase 3 features are not tracked obligations until separately approved.

## Testing

### Metadata and concurrency

1. Round-trip explicit phase, waiting subtype, and nested lifecycle metadata without losing unrelated metadata.
2. Reject unknown phases, subtypes, and schema versions without mutation.
3. Serialize cooperating lifecycle mutations and preserve idempotence after retries.
4. Prove polling changes `lastCheckedAt` without changing `stateEnteredAt` or `lastProgressAt`.

### Lifecycle

1. Claiming an actionable task creates one execution lease, sets `phase=active`, and sets native `status=in_progress`.
2. A second session cannot silently claim a live execution lease.
3. A deliberate task wait requires native `blocks` edges, releases known clean resources, and persists `phase=waiting`, subtype `dependency`, and native `status=open`.
4. A deliberate non-task wait requires one check, releases known clean resources, and persists `phase=waiting`, subtype `check`, and native `status=blocked`.
5. Waiting without either an unresolved native blocker or an active check is rejected.
6. Closing with a live worktree or execution lease is rejected.
7. Reopening preserves artifacts, native relationships, and prior check history.
8. Completed, cancelled, and superseded dispositions are distinguishable.
9. Session shutdown and active ownership timeout return unfinished work to Actionable, append one interruption event, and preserve resource context without claiming completion.
10. Before the next claim, every retained resource is reconciled with pool and Git state, shown to the agent, and recorded in the new execution's acknowledged snapshot.
11. Multiple reconciled resources do not prevent claim or additional allocation; unresolved associations block only new task worktree acquisition until repaired.

### Dependencies and checks

1. A native `blocks` edge leaves the dependent task at native `status=open` but persists and displays `phase=waiting`, subtype `dependency`.
2. No Pi view presents that dependency-waiting task as Open, Ready, or Actionable.
3. Closing the blocker makes the dependent task ready through Beads and reconciliation persists `phase=actionable` without a lifecycle `task` adapter.
4. Dependency cycles are rejected by Beads and blocker IDs are not duplicated in lifecycle metadata.
5. Task relationships are native edges and never artifact records.
6. Open PR remains waiting.
7. A two-PR `all merged` check remains waiting until both merge and wakes for action when either target requires changes.
8. Merged PR completion closes exactly once.
9. Changes requested and closed-unmerged reopen exactly once.
10. Time checks transition at the configured condition.
11. Manual checks become overdue without pretending they were checked.
12. Adapter failures back off and surface after the configured threshold.
13. Concurrent reconciliation cannot append duplicate observations or transitions.

### Artifacts

1. Canonically identical artifacts deduplicate.
2. Branch identity includes repository and full ref.
3. Removing a worktree preserves its branch artifact.
4. Multiple branches, commits, and PRs remain distinct, ordered, related through `sourceArtifactIds`, and visible after closure.
5. Multiple artifacts of different kinds remain ordered and visible after closure.
6. A supporting document or newly attached PR does not become a completion-check target implicitly.

### Worktree boundary

1. Coordinated task-worktree wrappers call the existing pool core and do not reimplement allocation, capacity, Git registration, release, or repair rules.
2. The pool extension and core import no Beads adapter, receive no task ID, and perform no task lookup; the task-lifecycle extension owns all correlation and pre-dispatch rejection.
3. `task_worktree_acquire` requires current task ownership, rejects duplicate repository/full-branch pairs and unresolved associations, persists a pending intent, finalizes the returned claim, and attaches the branch artifact exactly once.
4. One Active task may acquire multiple reconciled worktrees across distinct repository/full-branch pairs, bounded by pool capacity and one writer per worktree.
5. `task_worktree_release` marks one resource released only after pool success; deliberate wait and close release every active task resource and stop on any release failure.
6. Raw pool acquire/release remains available for taskless work and unassociated claims.
7. The task-lifecycle `tool_call` guard—not the pool—rejects raw acquire while the session owns an Active task and raw release for task-linked claims before dispatch.
8. Raw pool list and repair remain directly available in every context.
9. Partial wrapper failure preserves enough state for idempotent reconciliation, blocks further task acquisition only while unresolved, and cannot duplicate the failed allocation.
10. Dirty worktrees owned by the current execution are ordinary reconciled resources and do not block another acquisition.
11. Ambiguous worktrees are never automatically removed; dead-owner worktrees are shown with Actionable task context rather than reclaimed unattended.
12. The worktree pool remains free of task, artifact, PR, and check logic.

### Pi behavior

1. Fresh, resumed, forked, and compacted sessions derive the same explicit lifecycle phase from Beads metadata and dependency state.
2. A native `status=open` task with an unresolved blocker appears only in Waiting, never Actionable.
3. Session-start reconciliation is bounded and does not leave a resident watcher.
4. `before_agent_start` performs no network polling.
5. The injected block stays within a measured token budget and highlights overdue state.
6. Headless modes perform lifecycle work without invoking TUI-only methods.

## Rollout

1. Implement against a temporary Beads store and temporary worktree pool.
2. Verify metadata round trips and lifecycle invariants with focused tests.
3. Run a synthetic multi-resource flow: claim → acquire two distinct task worktrees → attach two branches and PRs → release both worktrees → wait on `all merged` → handle review action → reclaim → merge both → close.
4. Exercise taskless raw acquire/release, lifecycle-owned pre-dispatch guard rejection, duplicate branch rejection, and partial wrapper failure/reconciliation.
5. Run non-PR flows for a native task dependency, a document deliverable, a time wait, and a manual decision.
6. Produce a read-only migration report proposing explicit phases and waiting subtypes for current open, in-progress, blocked, deferred, dependency-blocked, and leased work.
7. Ask for explicit approval before applying that report.
8. Enable the lifecycle extension without bulk mutation.
9. Migrate a small set of known tasks and observe at least one full check-driven completion.
10. Measure context size and session-start latency.
11. Only then consider broader artifact auto-capture or additional adapters.

## Acceptance criteria

1. One task preserves the complete goal history from creation through completion, cancellation, or supersession.
2. Active execution persists `phase=active`, native `status=in_progress`, and exactly one valid execution lease.
3. Waiting work persists `phase=waiting` with exactly one recognized subtype and retains neither an active execution lease nor a deliberately held worktree.
4. Every waiting task has either unresolved native `blocks` edges or one typed non-task check; no task dependency is duplicated in artifact or check metadata.
5. Any session can reconcile waiting work, active ownership timeouts, and retained-resource warnings without the original agent.
6. A merged PR can close its task idempotently; actionable review state can reopen it idempotently.
7. Non-PR tasks support native task dependencies, time, manual, and manually verified completion flows.
8. A task supports zero to many typed artifacts; branches, commits, and PRs remain distinctly related and visible after worktree release and task closure.
9. Worktree claims remain resources, branches remain artifacts, and the thin pool contains no task semantics.
10. Task-linked acquisition and release use coordinated wrappers around the existing pool core and record resource/artifact correlation exactly once.
11. Raw pool list and repair remain exposed in every context; raw acquire/release remains available for taskless work and unassociated claims.
12. The task-lifecycle extension rejects raw acquire during Active task ownership and raw release of a task-linked claim before dispatch; the pool receives no task ID and imports no Beads adapter.
13. One Active task may own multiple reconciled worktrees across distinct canonical repository/full-branch pairs, bounded by pool capacity and one writer per worktree.
14. Healthy reconciled resources, including dirty worktrees owned by the current execution, do not block additional acquisition; pending or ambiguous associations do.
15. Partial coordinated operations preserve explicit, idempotently reconcilable state and cannot duplicate the same worktree allocation.
16. Deliberate transition out of active work releases every active task worktree before changing task state.
17. After an active ownership timeout, the task is Actionable and the next agent receives the interruption event plus a reconciled snapshot of every retained resource before claim.
18. Dirty, ambiguous, or retained resources are preserved and shown to the next agent for explicit resolution.
19. A multi-PR `all` check remains waiting until every explicit target satisfies the predicate and becomes actionable if any target requires work.
20. Polling cannot reset the visible age of waiting work or masquerade as progress.
21. Closed tasks distinguish completed, cancelled, and superseded outcomes; task replacement uses the native `supersedes` relationship.
22. Legacy issues remain readable and are not bulk-mutated without approval.
23. A dependency-blocked task is displayed as Waiting with its blocker and is never presented as Open, Ready, or Actionable.
24. The compact work-state injection shows active, actionable, and waiting work with inline overdue and retained-resource warnings within a measured token budget.
