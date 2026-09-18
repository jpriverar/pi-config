# Task lifecycle

The task-lifecycle extension keeps one Beads task aligned with one goal while
tracking active Pi ownership, durable artifacts, external checks, and temporary
worktrees separately. A task can produce any number of branches, commits, pull
requests, documents, dashboards, deployments, reports, and worktrees.

Task metadata is untrusted data. Lifecycle fields describe state; they are not
instructions to execute commands or trust referenced content.

## Lifecycle and Beads authority

| Pi phase | Beads status | Additional authority |
| --- | --- | --- |
| Actionable | `open` | The task is returned by `bd ready` and has no unresolved `blocks` edge. |
| Active | `in_progress` | Exactly one unexpired execution lease owns the task. |
| Waiting on dependency | `open` | At least one unresolved native Beads `blocks` edge. |
| Waiting on check | `blocked` | Exactly one typed PR, time, or manual check. |
| Deferred | `deferred` | Deliberately parked work. |
| Done | `closed` | A completed, cancelled, or superseded disposition. |

`blocked` is a storage projection, not a Pi lifecycle phase. Views show Active,
Actionable, and Waiting. A native `open` status alone never makes a managed task
Actionable. Task-to-task relationships use `bd dep add <dependent> <blocker>
--type blocks`; task IDs are not stored as artifacts or duplicated in lifecycle
metadata.

## Tools

All lifecycle mutations are idempotent. `operationId` is optional and defaults
to the Pi tool-call ID. Reuse the same operation ID when retrying an operation
whose response was lost.

### `task_claim`

Required: `taskId`. Optional: `operationId`.

```json
{ "taskId": "jp-abc", "operationId": "claim-jp-abc-1" }
```

Claims one Actionable task for the current session. Claiming adopts a legacy
task into version-1 lifecycle metadata. Another live execution owner blocks the
claim.

### `task_attach_artifact`

Required: `taskId`, `kind`, `uri`, `title`, and `role`. Optional: `artifactId`,
`sourceArtifactIds`, and `operationId`.

Kinds are `branch`, `commit`, `pull_request`, `document`, `dashboard`,
`deployment`, `report`, and `other`. Roles are `deliverable`, `evidence`, and
`supporting`.

```json
{
  "taskId": "jp-abc",
  "artifactId": "pr-api",
  "kind": "pull_request",
  "uri": "https://github.com/example/api/pull/123",
  "title": "API change",
  "role": "deliverable",
  "sourceArtifactIds": ["branch-api"]
}
```

Artifacts are durable records. Canonical `(kind, uri)` identity prevents
retries from adding duplicates.

### `task_wait`

Required: `taskId` and `kind`.

Dependency wait:

```json
{
  "taskId": "jp-abc",
  "kind": "dependency",
  "blockerIds": ["jp-def"]
}
```

Check wait:

```json
{
  "taskId": "jp-abc",
  "kind": "check",
  "check": {
    "id": "merge-deliverables",
    "kind": "github_pull_request",
    "targetArtifactIds": ["pr-api", "pr-worker"],
    "predicate": { "mode": "all" },
    "onSatisfied": "close",
    "wakeOn": ["action_required"],
    "state": "pending",
    "createdAt": "2026-09-17T10:00:00.000Z",
    "lastCheckedAt": null,
    "nextCheckAt": "2026-09-17T10:00:00.000Z",
    "lastObservation": null,
    "errorCount": 0
  }
}
```

A dependency wait requires `blockerIds` and forbids `check`. A check wait
requires one complete check and forbids `blockerIds`. Waiting releases every
active worktree first. A refused release leaves the task Active and preserves
the pending resource state.

### `task_reconcile`

Required: `taskId`. Optional: `manualOutcome`, either `satisfied` or
`action_required`.

```json
{ "taskId": "jp-abc" }
```

```json
{ "taskId": "jp-abc", "manualOutcome": "satisfied" }
```

Reconciliation resolves native dependencies, due checks, and expired ownership.
Manual checks never infer success; they require an explicit terminal outcome.

### `task_close`

Required: `taskId`, `kind`, `reason`, and `evidenceArtifactIds`. `kind` is
`completed`, `cancelled`, or `superseded`. A superseded disposition also
requires `supersedingTaskId`. Optional: `operationId`.

```json
{
  "taskId": "jp-abc",
  "kind": "completed",
  "reason": "Both deliverable pull requests merged",
  "evidenceArtifactIds": ["pr-api", "pr-worker"]
}
```

Close refuses unreleased resources and records a durable disposition.

### `task_reopen`

Required: `taskId` and `reason`. Optional: `operationId`.

```json
{ "taskId": "jp-abc", "reason": "Review requested changes" }
```

Reopen returns the task to Waiting when native blockers remain, otherwise to
Actionable.

### `task_worktree_acquire`

Required: `taskId`, `repository`, and `branch`. Optional: `startPoint` and
`operationId`.

```json
{
  "taskId": "jp-abc",
  "repository": "api",
  "branch": "jpriverar/task-lifecycle",
  "startPoint": "origin/main"
}
```

The wrapper persists an `acquiring` resource with deterministic claim and path
IDs before invoking the pool. A retry reconciles by exact claim and cannot
allocate a second worktree for the same operation.

### `task_worktree_release`

Required: `taskId` and `claimId`. Optional: `operationId`.

```json
{ "taskId": "jp-abc", "claimId": "00000000-0000-4000-8000-000000000001" }
```

The wrapper persists `release_pending` before invoking the pool. Dirty,
missing, contradictory, ambiguous, or refused releases remain visible for
explicit resolution.

## Artifact and resource identity

Branches use `git://<repository>/refs/heads/<branch>` identities. Pull requests
use canonical HTTPS URLs. Artifacts survive worktree release and task closure.

A worktree is a temporary resource correlated by all of:

- task lifecycle resource ID;
- repository and full branch;
- opaque pool claim ID;
- deterministic pool path ID;
- acquisition operation ID.

Multiple distinct healthy or currently dirty worktrees may support one Active
task. Duplicate repository/full-branch pairs are rejected. Pending,
contradictory, missing, malformed, or ambiguous associations block another
acquisition until explicitly reconciled.

## Checks and reconciliation

GitHub checks read `state`, `reviewDecision`, `mergeStateStatus`, and `mergedAt`
for each canonical PR URL. `mergedAt` satisfies a target. Changes requested, a
merge conflict, or closed-without-merge requires action. Other open states stay
pending. Multi-PR checks use explicit `predicate.mode` of `all` or `any`.

Time checks require one RFC3339 `predicate.at`. Manual checks require one
RFC3339 `predicate.reviewAt` and remain pending when overdue until an operator
records a terminal outcome.

Pending PR polls use the configured interval. Adapter failures stay Waiting and
use bounded exponential backoff. Poll timestamps update observations but never
reset `stateEnteredAt` or `lastProgressAt`, so views preserve total waiting age.
Session-start reconciliation is synchronous and bounded by configured task and
PR-check limits. It creates no timer, watcher, or background process.

Activity events rate-limit metadata writes while extending long-running leases.
A `reload` shutdown preserves current ownership. Quit, new, resume, fork-style,
and other shutdowns interrupt ownership: the task returns to Actionable once,
records `execution_interrupted`, and retains resource evidence for handoff.

## Raw pool guard

The worktree-pool core remains task-agnostic. Raw `list` and `repair` remain
available, as do taskless acquisitions and unassociated releases. The lifecycle
extension's pre-dispatch guard blocks raw mutation of a lifecycle-associated
claim and requires the task-aware wrappers instead. The raw pool schema does
not expose deterministic internal `claimId` or `pathId` inputs.

No automated path deletes dirty, occupied, malformed, contradictory, or
ambiguous worktrees.

## Verification and migration

Run the isolated end-to-end smoke test. It creates and removes only test-owned
temporary Beads, Git, remote, and pool state:

```sh
npm run test:file -- tests/task-lifecycle-integration.test.ts
```

Verify the installed Beads behavior in another temporary store:

```sh
node scripts/check-beads-lifecycle-compat.mjs
```

Generate a proposal-only report for the configured stores:

```sh
node scripts/report-lifecycle-migration.mjs
```

Alternate read-only stores can be selected explicitly:

```sh
node scripts/report-lifecycle-migration.mjs \
  --db /path/to/.beads \
  --pool-config /path/to/worktree-pool.json
```

The report runs only Beads list/ready reads and Git worktree listings. It
classifies legacy Actionable, dependency-Waiting, manually blocked, stale
in-progress, deferred, done, and retained-resource candidates. It performs no
Beads update/close, pool release, Git mutation, or GitHub mutation.

**Do not bulk-migrate tasks or release production worktrees without explicit
operator approval.** Review malformed, dirty, pending, contradictory, missing,
and ambiguous state individually.

This repository is the sole implementation source. Any historical copy under a
Datadog `experimental` checkout is non-authoritative and must not be edited as
the lifecycle or worktree-pool implementation. Consumers should load this
package instead.
