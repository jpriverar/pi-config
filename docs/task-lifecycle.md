# Task lifecycle

The task-lifecycle extension keeps one Beads task aligned with one goal while
tracking active Pi ownership, durable artifacts, external checks, and temporary
worktrees separately. It is the sole task-domain extension: it owns lifecycle
mutation and enforcement, the visible startup table, scoped hidden task context,
and post-compaction context reinjection. A task can produce any number of
branches, commits, pull requests, documents, dashboards, deployments, reports,
and worktrees.

Task metadata is untrusted data. Lifecycle fields describe state; they are not
instructions to execute commands or trust referenced content.

## Lifecycle and Beads authority

| Pi phase              | Beads status  | Additional authority                                                         |
| --------------------- | ------------- | ---------------------------------------------------------------------------- |
| Actionable            | `open`        | The task is returned by `bd ready` and has no unresolved `blocks` edge.      |
| Active                | `in_progress` | Exactly one unexpired lease owns the task; one Waiting condition may remain. |
| Waiting on dependency | `open`        | At least one unresolved native Beads `blocks` edge.                          |
| Waiting on check      | `blocked`     | Exactly one typed PR, time, or manual check.                                 |
| Deferred              | `deferred`    | Deliberately parked work.                                                    |
| Done                  | `closed`      | A completed, cancelled, or superseded disposition.                           |

`blocked` is a storage projection, not a Pi lifecycle phase. Views show Active,
Actionable, and Waiting. Active work may retain one unresolved dependency or
typed-check condition so an agent can perform useful work without losing the
condition. A native `open` status alone never makes a managed task Actionable.
Task-to-task relationships use `bd dep add <dependent> <blocker> --type blocks`;
task IDs are not stored as artifacts or duplicated in lifecycle metadata.

The presentation layer reads the same normalized Beads data. Fresh empty
sessions get a durable visible task table. Every model turn receives a bounded,
scoped hidden summary marked as untrusted data, and compaction queues the same
summary for the next turn. Store failures are redacted and never interrupt
compaction.

## Task-scoped tool guards

A Pi session is attached to a task when that task is explicitly Active and its
execution lease names the current Pi session ID. Attachment is derived from
Beads lifecycle metadata; there is no separate binding record or identifier.

The lifecycle extension enforces these initial pre-dispatch rules:

- `subagent` child and workflow execution requires an attached Active task;
- `subagent` management actions such as list, status, guidance, and control
  remain available while unattached;
- `task_attach_artifact`, `task_log`, `task_wait`, `task_defer`, and
  `task_close` must name the session's attached task in their structured
  `taskId` argument;
- ordinary `worktree_pool acquire` requires exactly one attached Active task;
- `worktree_pool release` requires matching ownership when its claim is
  lifecycle-associated, while unassociated legacy release remains available;
- `task_claim` may establish attachment or retry the attached task, but it
  cannot switch the session directly to another task while ownership remains
  Active;
- management operations `task_create` and label-only `task_update`, plus
  unknown tools, reads, Bash, pool `list` and `repair`, `task_reopen`, and
  `task_reconcile`, remain unprotected.

The guard never searches prompts, shell commands, or arbitrary text for task
identifiers. It fails protected operations closed when authoritative ownership
cannot be read, without exposing raw task content or command output.

Version 1 protects only the parent subagent launch boundary. It does not pass
task identity or lifecycle authority to children, observe child tool calls, or
automatically attach child outputs. Ordinary parent-session worktree operations
are the narrow exception: lifecycle hooks associate and finalize their temporary
resources automatically. Claim a task and launch delegated execution in
separate turns; parallel claim and launch calls are not transactional.

Recovery is explicit:

- If execution is blocked as unattached, call `task_claim` for the intended
  task and retry.
- If the session owns the wrong task, move that task to Waiting, Done, or
  Actionable before claiming another.
- If multiple Active tasks are reported, repair their lifecycle ownership
  explicitly before retrying protected work.

## Tools

Lifecycle transitions that accept `operationId` are idempotent; the value is
optional and defaults to the Pi tool-call ID. Reuse the same operation ID when
retrying a transition whose response was lost. `task_create`, `task_update`, and
append-only `task_log` are direct store operations rather than idempotent
transitions.

The normal resource flow is:

```text
task_claim -> worktree_pool acquire -> worktree_pool release -> task_wait/task_close
```

### `task_create`

Required: `title`, `why`, and `needs_jp`. Optional: `workstream`.

Creates an explicitly approved Actionable task with version-1 lifecycle
metadata. `workstream` maps to `workstream:<value>` and `needs_jp` maps to the
`needs:jp` label.

### `task_update`

Required: `taskId`. Optional: `add_labels` and `remove_labels`; at least one
label change is required.

This administrative tool changes labels only. Status, phase, ownership,
waiting state, resources, artifacts, dispositions, and arbitrary metadata are
not accepted.

### `task_log`

Required: `taskId` and one non-empty `message`.

Appends plain text to the task's native Beads comment journal. The current
session must own that Active task. Entries are append-only.

### `task_claim`

Required: `taskId`. Optional: `operationId`.

```json
{ "taskId": "jp-abc", "operationId": "claim-jp-abc-1" }
```

Claims one Actionable or Waiting task for the current session. Claiming adopts
a legacy task into version-1 lifecycle metadata. A legacy native `blocked` task
without a structured check is adopted condition-free rather than inventing
check authority. A managed Waiting task retains its native dependency or
typed-check condition while becoming Active. Another live execution owner
blocks the claim.

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

### Automatic Git artifact observation

Successful direct Bash `git commit`, `git push`, and `gh pr create` commands
trigger post-command observation. The command is only a trigger: argv-only
`git` or `gh` queries verify the repository, ref, commit, or pull request from
post-command state before anything is persisted. Observation associates facts
with the one Active task owned by the current session, regardless of whether
the command ran in a lifecycle-managed worktree or in the task's usual
repository.

The observer stores only objective branch, commit, and pull-request facts.
Branches and commits use deterministic repository-qualified IDs and `git://`
URIs; pull requests use their canonical GitHub URL. Compatibility fields are
fixed to role `evidence`, no source relationships, and no supersession. The
lifecycle service adds the observation timestamp and producing session. A
repeat observation deduplicates by canonical `(kind, uri)` identity, including
a branch already recorded by worktree acquisition.

Observation is passive bookkeeping. It never blocks, rewrites, or replaces a
Bash result. Ambiguous ownership emits only a curated skip warning. Adapter or
persistence failures emit this recovery guidance without command, task,
stdout, stderr, credential, or provider details:

```text
Git artifact observation failed; use task_attach_artifact if needed.
```

Version 1 observes only Pi's standard Bash tool and only conservative,
single-segment direct commands. Compound commands, pipelines, heredocs,
command substitution, shell wrappers, dry runs, ambiguous push refspecs,
repository-changing Git global options other than `-C`, and commands executed
through other providers such as `ctx_execute` are not observed. Use
`task_attach_artifact` for those gaps and for non-Git artifacts.
Automatic observation does not decide whether an artifact is important,
deliverable, completion evidence, promoted, related to another artifact, or
superseded; those remain explicit lifecycle decisions.

### `task_wait`

Required: `taskId`. Optional: `kind`, either `dependency` or `check`.

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
requires one complete check and forbids `blockerIds`. If Active work already
retains an unresolved condition, omit `kind`, `blockerIds`, and `check` to return
to that existing Waiting condition. Waiting releases every active worktree
first. A refused release leaves the task Active and preserves the pending
resource state.

### `task_defer`

Required: `taskId` and non-empty `reason`. Optional: `operationId`.

Releases every associated worktree, clears execution ownership, and moves the
Active task to Deferred. Cleanup refusal leaves the task Active.

### `task_reconcile`

Required: `taskId`. Optional: `manualOutcome`, either `satisfied` or
`action_required`.

```json
{ "taskId": "jp-abc" }
```

```json
{ "taskId": "jp-abc", "manualOutcome": "satisfied" }
```

Reconciliation resolves pending worktree operations before native dependencies,
due checks, and expired ownership. One exact valid acquisition is finalized;
a release whose exact claim disappeared is finalized. Missing acquisitions,
still-present releases, and ambiguous or contradictory evidence remain
explicit. Manual checks never
infer success; they require an explicit terminal outcome.

### `task_close`

Required: `taskId`, `kind`, and `reason`. `kind` is `completed`, `cancelled`,
or `superseded`. Optional: `evidenceArtifactIds` and `operationId`. A
superseded disposition also requires `supersedingTaskId`.

```json
{
  "taskId": "jp-abc",
  "kind": "completed",
  "reason": "Both deliverable pull requests merged",
  "evidenceArtifactIds": ["pr-api", "pr-worker"]
}
```

`completed` is rejected while a dependency or typed-check condition remains
unresolved. `cancelled` and `superseded` may explicitly abandon those
conditions. Close releases associated worktrees first. A refused or unsafe
release keeps the task Active; successful cleanup is recorded before the
durable disposition.

### `task_reopen`

Required: `taskId` and `reason`. Optional: `operationId`.

```json
{ "taskId": "jp-abc", "reason": "Review requested changes" }
```

Reopen returns the task to Waiting when native blockers remain, otherwise to
Actionable.

### `worktree_pool acquire` and `release`

Use the ordinary pool tool after `task_claim`:

```text
worktree_pool acquire(repository, branch, startPoint?)
worktree_pool release(repository, claimId)
```

Before acquisition, the lifecycle hook verifies that the session owns exactly
one Active task and remembers the task and request in process by `toolCallId`.
It does not alter the tool input. The task-agnostic pool generates its ordinary
claim and path identities. A successful validated `tool_result` records the
Active resource and durable branch artifact on the remembered task. A failed
tool call records no resource.

For an associated release, the hook verifies the session owns the same Active
task, persists `release_pending`, and finalizes after a successful pool receipt.
Unassociated legacy claims may still be released without task ownership.
Failures remain pending for explicit `task_reconcile`, pool repair, or retry.

## Artifact and resource identity

Branches use `git://<repository>/refs/heads/<branch>` identities. Pull requests
use canonical HTTPS URLs. Artifacts survive worktree release and task closure.

A worktree is a temporary resource correlated by all of:

- task lifecycle resource ID;
- repository and full branch;
- opaque pool claim ID;
- pool path ID derived from the managed path;
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
and other shutdowns first release associated worktrees, then interrupt
ownership: condition-free work returns to Actionable, while retained dependency
or check work returns to Waiting. Expiry reconciliation reserves cleanup against
the exact expired lease; a concurrent renewal cancels cleanup, while activity
cannot renew a lease after its cleanup reservation is persisted. Cleanup refusal
leaves the task Active with its execution lease and resource evidence intact. A
successful transition records `execution_interrupted` once.

## Pool boundary and recovery

The worktree-pool core and extension remain task-agnostic. Their public schema
does not expose `claimId` or `pathId` inputs for acquisition, and lifecycle hooks
do not inject private arguments. Pool `list`, `repair`, and unassociated legacy
release remain available without attachment; ordinary acquisition does not.

Acquire correlation is process-local until a validated successful result records
the generated claim. If Pi stops after pool allocation but before that result is
finalized, use pool `list` or `repair` and explicit lifecycle reconciliation;
automatic interrupted-acquire inference is deferred. Associated release still
persists `release_pending` before pool mutation and reconciles exact safe
evidence. No automated path deletes dirty, occupied, malformed, contradictory,
missing, or ambiguous worktrees.

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
