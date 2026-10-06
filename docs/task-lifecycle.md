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

| Pi phase              | Beads status  | Additional authority                                                                              |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| Actionable            | `open`        | The task is returned by `bd ready` and has no unresolved `blocks` edge.                           |
| Active                | `in_progress` | Exactly one session owns the task until an explicit transition; one Waiting condition may remain. |
| Waiting on dependency | `open`        | At least one unresolved native Beads `blocks` edge.                                               |
| Waiting on check      | `blocked`     | Exactly one typed PR, time, or manual check.                                                      |
| Deferred              | `deferred`    | Deliberately parked work.                                                                         |
| Done                  | `closed`      | A completed, cancelled, or superseded disposition.                                                |

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
task_claim -> worktree_pool acquire -> worktree_pool release -> task_wait/task_defer/task_close
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
typed-check condition while becoming Active. Re-claiming an Active task already
owned by the current session refreshes activity metadata, including after the
legacy expiry timestamp or a failed explicit release. It preserves the owner, original claim timestamp, retained conditions,
artifacts, and resource history; it does not inspect or repair worktrees.
Same-timestamp retries do not write again. Another execution owner blocks the
claim, even if that owner's legacy expiry timestamp passed or the operation ID was previously used.

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
to that existing Waiting condition. All associated worktrees must already be
released with `worktree_pool`. Otherwise the tool refuses without adding blockers,
changing the condition, or releasing ownership. The error identifies the repository
and claim and gives the exact release call. Native dependency writes and the
resource/ownership precondition share the existing store mutation lock.

### `task_defer`

Required: `taskId` and non-empty `reason`. Optional: `operationId`.

Moves the Active task to Deferred and clears execution ownership only after all
associated worktrees have been explicitly released. It never performs cleanup.
An unreleased resource leaves the task unchanged and returns release guidance.

### `task_reconcile`

Required: `taskId`. Optional: `manualOutcome`, either `satisfied` or
`action_required`, plus `requestId` and `expectedCheckFingerprint` for retries.
Optional fields may be omitted or null for ordinary reconciliation. Execution
goes through the local daemon, never an in-session fallback.

```json
{ "taskId": "jp-abc" }
```

```json
{ "taskId": "jp-abc", "manualOutcome": "satisfied" }
```

A new manual request captures the current check fingerprint before sending. If
the reply is lost or times out, the tool throws an **unknown** error containing
the exact retry request as JSON. Resend that request, including its request ID,
outcome, and fingerprint; do not recapture a replacement check. An explicit manual
`requestId` without its original fingerprint is rejected. Unknown does not mean
cancelled: the daemon may already have committed the transition.

Rejected and unknown requests use Pi's actual tool error channel. An unavailable
or incompatible service reports setup/status guidance without running local
reconciliation. Task/check validation errors do not suggest
installing or starting the daemon. `manual_check_required` means the task has
no applicable manual check; omit `manualOutcome` and its fingerprint when
requesting ordinary resource reconciliation. `/task-reconciler status` is read-only. The same
command accepts explicit `install`, `start`, `stop`, `update`, `update --rollback`,
and `uninstall`; no command is run on startup or reload. See the
[opt-in installation and cutover guide](../README.md#optional-task-reconciliation-daemon).
`PI_TASK_RECONCILER_CONFIG` selects an explicit configuration file; otherwise
administration uses `~/.pi/task-reconciler/config.json` and clients prefer the
installed snapshot for their canonical Beads store.

Reconciliation observes pending worktree operations before native dependencies
and due checks. It never deletes checkouts or expires task ownership. One exact
valid acquisition is finalized; a release whose exact claim disappeared is
finalized. Historical expiry/shutdown release reservations are obsolete regardless
of their timestamp. They are cancelled only when the exact claim still has valid
native ownership/branch evidence. Normal acquisition preflight also resolves
these obsolete intents without requiring a repair tool or activity renewal.

Observation and persistence hold the pool lock before the store lock, so stale
evidence cannot restore a deleted checkout. An explicit release receives its own
operation identity. If its claim is still present and valid, reconciliation leaves
it pending without retrying deletion or reporting that alone as a failure.
Missing acquisitions and ambiguous or contradictory evidence remain errors.
Pool repair is inspection/recovery of pool metadata, not deletion permission.
Manual checks never infer success; they require an explicit terminal outcome.

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
conditions. Close requires every associated worktree to have been explicitly
released; it refuses otherwise without changing the task. Automatic closure on a
satisfied check obeys the same resource invariant and never deletes a checkout.

### `task_reopen`

Required: `taskId` and `reason`. Optional: `operationId`.

```json
{ "taskId": "jp-abc", "reason": "Review requested changes" }
```

Reopen accepts Done and Deferred tasks and restores native `open` status without
claiming the task. It returns the task to Waiting when native blockers remain,
otherwise to Actionable. Use this to resume deliberately parked work; do not
change only the native status with `bd update`.

### `worktree_pool acquire` and `release`

Use the ordinary pool tool after `task_claim`:

```text
worktree_pool acquire(repository, branch, startPoint?)
worktree_pool release(repository, claimId)
```

Before acquisition, the lifecycle hook verifies that the session owns exactly
one Active task and performs a read-only check of its existing worktree
associations. Pending, missing, ambiguous, or contradictory resources reject
the request before pool allocation. The hook remembers the task and request
in process by `toolCallId`; it does not alter the tool input. The task-agnostic pool generates its ordinary
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
Automatic and explicit reconciliation share the standalone daemon. Discovery
runs every minute, while existing 15-minute PR deadlines/backoff remain in the
lifecycle state. Pi startup performs no automatic reconciliation or installation.
Ordinary mutations and lease activity stay local. If the service is unavailable,
reconciliation remains unavailable; there is no hidden fallback.

Pi-only notices reuse the work-state snapshot and persisted session cursor.
Historical successes are baselined; unresolved attention is visible. Check
`wakeOn` supports outcome names (`satisfied`, `action_required`, `error`, `manual`)
and specific PR results (`merged`, `changes_requested`, `merge_conflict`,
`closed_unmerged`); an empty list uses default important notices. Repeated polls
and unchanged errors do not notify again. A cursor is scoped to the session and
project, capped at 128 KiB, and explicitly rebaselined on overflow. At most ten
notices are presented per interaction. Disappearing task IDs are resolved with
one rotating bulk lookup (up to 100 IDs/16 KiB) per refresh; missing rows never
imply completion. These notices use Pi UI notifications, not desktop messages
or model-triggering turns.

Activity events rate-limit metadata writes. Inactivity, sleep, reload, quit,
new/resumed/forked sessions, and restarts do not relinquish task ownership or
initiate cleanup. Resume the original Pi session to continue its task; another
session cannot take over just because activity stopped. Explicit wait, defer, or
close transitions relinquish ownership after the agent releases each worktree.

The v1 `expiresAt` field and `executionTimeoutMs` configuration remain readable
and are maintained for compatibility. They do not authorize deletion or owner
replacement and are not daemon scheduling deadlines. Historical
`execution_interrupted` events remain readable; no new ones are generated.
Explicit deletion still holds the pool lock before the store mutation lock
through removal and persistence. Claim renewal cannot return while an explicit
deletion is already running. Already released resources remain released.

## Pool boundary and recovery

The worktree-pool core and extension remain task-agnostic. Their public schema
does not expose `claimId` or `pathId` inputs for acquisition, and lifecycle hooks
do not inject private arguments. Pool `list`, `repair`, and unassociated legacy
release remain available without attachment; ordinary acquisition does not.

Acquire correlation is process-local until a validated successful result records
the generated claim. If Pi stops after pool allocation but before that result is
finalized, use pool `list` or `repair` and explicit lifecycle reconciliation;
automatic interrupted-acquire inference is deferred. Preflight reduces known
failures but does not close the allocation-to-persistence crash/race window;
post-allocation association validation still runs. Known association failures
identify the obstructing claim without exposing raw store errors. If recording
fails after allocation, the checkout is retained; do not acquire another copy
as a recovery shortcut.

Associated release still persists `release_pending` before pool mutation and
reconciles exact safe evidence. Initialized submodules or retained submodule
Git data are refused before changing the pool lease or unlocking the worktree.
Never-initialized submodules remain removable through ordinary Git cleanup.
Refusal preserves the checkout and native owner. Explicit releases stay pending
for explicit recovery; obsolete expiry releases can be cancelled by ordinary
resource reconciliation without requiring an owner renewal. This does not implement
submodule deletion.

If ordinary removal fails after unlock, the pool restores the original native
claim only when the exact managed registration, branch, HEAD, cleanliness, and
lack of another lock still match. It retains the `removing` journal so an exact
release retry can finish after the cause is resolved. Changed, dirty, missing,
unverifiable, or newly locked state is not relocked. This does not adopt or
repair historical unlocked claims. No automated path deletes dirty, occupied, malformed, contradictory,
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
