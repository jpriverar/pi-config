# Task lifecycle

**Writer version:** lifecycle writes still default to v1. The transition and
resource-hook procedures on this page describe that legacy mode unless stated
otherwise. For the opt-in ownership/condition/pause model and block/resume/release
API, read [Durable ownership: lifecycle v2](task-lifecycle-v2.md). Readers and
displays understand both schemas; enabling a writer never converts records.
Do not confuse lifecycle v2 with the independent catalog or WM configuration
versions described below.

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
scoped hidden summary marked as untrusted data. A separate bounded block adds
the full description and `metadata.next_step` of the uniquely owned task. V2
ownership is discovered across all phases, including Done/Deferred. Non-active
context explicitly does not authorize execution.
With an active catalog, a global/area/project selection changes the view, not
ownership: an owned task outside that view retains its mission context with an
outside-view warning. Invalid task membership is diagnosed, never guessed.
Without an active catalog, legacy project matching still applies; version-2
scope without its required catalog is unavailable rather than global.
Ambiguous ownership across projects supplies no mission. Overview snapshots
exclude these fields for other tasks. Compaction refreshes context without
starting a turn. Store failures are
redacted and never interrupt compaction. Missing records or a null next step
never establish that a mission is complete.

## Task-scoped tool guards

A Pi session is attached to a task when that task is explicitly Active and its
execution lease names the current Pi session ID. Attachment is derived from
Beads lifecycle metadata; there is no separate binding record or identifier.

The lifecycle extension enforces these initial pre-dispatch rules:

- `subagent` child and workflow execution requires an attached Active task;
- `subagent` management actions such as list, status, guidance, and control
  remain available while unattached;
- `task_attach_artifact`, `task_log`, `task_wait`, `task_defer`, `task_close`,
  and `task_update` when changing description/next_step must name the session's
  attached task in their structured `taskId` argument; content updates also
  revalidate active ownership inside the store lock;
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

## Areas, projects, and views

An area is a durable responsibility/reporting home with an explicit publication
policy. A project is a persistent effort or catch-all within an area; it exists
without tasks. Tasks remain the unit of execution and ownership.

After reviewed activation, `/area` and `/project` select global/area/project
views and manage descriptions, names, moves, policies, archive, and restore.
`/project` retains its legacy picker before activation. Catalog selection changes
only browsing, never session identity, ownership or new-task placement. A
session-owned task outside the view stays visible with an outside-current-view
marker. Filtered counts and model context label the browse view separately from
working identity.

A unique owned task supplies the working project and area. Pi's status shows
that context beside the actual session name and task. V1 ownership exists only
while Active; v2 preserves it across Ready, Blocked, Deferred and Done. Successful
claim adopts the project view once. Only a transition that actually relinquishes
ownership makes the session unassigned and adopts a global view: v1 wait/defer/close,
or v2 explicit release. Creating another task does neither.

Session names are independent: lifecycle, project operations and session setup do
not generate, repair or clear them. Pi's native naming and explicit user names are
preserved; existing generated names are not migrated or rewritten.

Startup/resume reconstructs working identity from ownership. Later explicit browsing
is preserved during ordinary refreshes, manual name changes and catalog renames/moves.
Failed/ambiguous reads or invalid membership are unavailable, not proof of no owner;
they do not release work. A post-commit scope/marker projection failure reports
partial success and remains recoverable without undoing ownership.

Catalog-backed fork, clone and clear initialize a new ID as unassigned/global,
without transferring or releasing parent ownership. Their setup does not change
cwd or allocate a worktree. The session-bound `jp-working-identity` entry is only
rebuildable presentation bookkeeping; it is never an ownership or placement
source. Legacy/no-catalog scope behavior remains separate; it likewise persists
project selections and migrations without changing session names.

For browse compatibility only, a session without scope metadata can resolve an
exact registered display name or alias. Generated suffixes are not guessed, and
explicit browse scope takes precedence. Neither compatibility path supplies
working identity or a default for catalog-backed creation.

The `work_catalog` tool provides bounded `list_areas`, `list_projects`, `get_area`,
`get_project`, and `select` actions plus catalog mutations. Lists expose summaries,
not raw targets or executable configuration, and return `nextOffset` for additional
pages. Get returns a bounded description. Mutations require `expectedRevision`;
responses distinguish the applied revision from any later concurrently read revision.
Approval comes from the operator conversation, never an `approved: true` field.

Catalog descriptions explain fit and boundaries. Like task metadata and retrieved
content, they are untrusted data, not permissions or executable instructions.
For new tracked work, follow the
[project-selection recipe](../skills/development-workflow/references/project-selection.md)
to resolve placement and present a combined task/entity/destination approval.
Reuse a clear existing fit without a separate placement question; an unresolved
choice remains a decision for the operator, not inferred authority.

New entities require descriptions. Migration may retain explicitly acknowledged
missing descriptions/unclassified projects for later review. Unknown/conflicting
legacy membership is diagnosed rather than silently inferred.

Moves and policy edits affect grouping and future tasks only. Existing captured
Datadog destinations, including pending creates, stay unchanged and can display a
previous-destination warning. Renames retain reserved aliases and immutable keys.
Archival checks include deferred work and ambiguous legacy labels conservatively;
reopened work makes archived parents visible with a warning.

The version-1 catalog lives in Beads `custom.pi-work-catalog`, with stable UUIDs,
a revision, `prepared`/`active` state, and a 63 KiB UTF-8 limit. This is private
store data, not package configuration. See the
[reviewed migration runbook](task-reconciler-operations.md#reviewed-area-and-project-activation).

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

Required: `title`, `why`, and `needs_jp`. Catalog-backed creation also requires
an explicit `projectId` or `workstream` (a registered project name, immutable
compatibility key or alias). If both selectors are supplied, they must agree.

Creates an explicitly approved Actionable task. With an active catalog, every
new task belongs to exactly one project and inherits its area's explicit
local-only or Datadog publication policy. There is no default destination.

- Every creation explicitly chooses a project. There is no default from a claim,
  session name, browser filter or board.
- The selected project may differ from both current work and browsing. Creation
  records the task without claiming it or changing the session.
- Conflicting ID/name selectors, archived parents and unclassified projects fail
  before creation. Catalog availability and publication policy are checked again
  under the shared mutation lock. Browse scope is not part of that validation.

Creation records `piProject: { version: 1, projectId }`, the immutable workstream
label, lifecycle metadata, and any captured publication target atomically.
`needs_jp` maps to `needs:jp`. Catch-all projects are valid; new unscoped tasks are
not. Existing unscoped tasks remain usable without rewriting their metadata.

Before catalog activation, legacy behavior remains: workstream is optional in
global scope and inherited in project scope; explicit mismatches are rejected.
Legacy display names are consulted only without explicit scope metadata. A v2
scope whose required catalog is unavailable never falls back to global.

### `task_update`

Required: `taskId`. Optional: `add_labels`, `remove_labels`, `description`,
and `next_step`; at least one change must be requested.

Label-only updates retain administrative behavior. Description and next-step
updates require current active ownership, checked again under the native store
lock. The existing description holds the agreed mission, finish criteria and
scope; change it only to reflect the user's agreement. `metadata.next_step` is
the only new persisted value: one current action/check, not a plan or authority.

Omitted fields are preserved. `next_step: null` clears the hint without changing
lifecycle state. Next-step strings are trimmed, nonempty, single-line, free of
control characters and limited to 2000 Unicode code points. Description writes
retain the existing nonempty single-line guard. An identical content update
still checks ownership but does not write.

The update uses one native write and verified read-back, preserving unrelated
metadata. An uncertain write is not automatically retried. Status, phase,
ownership, waits, artifacts, progress timestamps and lifecycle history are not
changed by a content update; arbitrary metadata writes are not accepted.
Closing/cancelling/superseding clears an existing next step, and reopening a
Done task cannot revive an obsolete hint.

Managed project/workstream membership cannot be changed through generic label edits.

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

A successful claim adds bounded owned context independently of its returned
tool result. Context-only delivery includes it after the current tool batch
without waking an idle agent; SDK `nextTurn` delivery is not used because it
waits for another submitted prompt. A failed refresh leaves the claim successful
and provides a diagnostic. This does not make a claim and subsequent operations
in the same batch transactional.

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

### `task_wait` (v1 only)

V2 registers `task_block`, `task_resume` and `task_release` instead; see the
[v2 tool contract](task-lifecycle-v2.md#work-boundaries-and-tools).

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
    "onSatisfied": "actionable",
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

Use `onSatisfied: actionable` while validation, communication or cleanup remains
owed after the condition. Auto-close is appropriate only when satisfying that
condition fulfills the entire agreed finish line.

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

The example above assumes a PR-only finish line. Merge receipts alone do not
fulfill agreed deployment validation or final communication.

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
worktree_pool release(repository, claimId, force?)
```

Normal release supports clean initialized and deinitialized submodules. It
reports tracked changes, non-ignored untracked files, and submodule commits or
stashes not reachable from local remote-tracking refs, without deleting them.
Status checks override submodule-ignore and untracked-file display settings.
No fetch or backup is performed; dangling objects/reflogs are not an archive.
Ignored files are disposable in either release mode, as with ordinary Git
worktree removal. The parent repository's branches and shared Git data remain.

Use `force: true` only to intentionally discard local work within the approved
task. It removes those files and worktree-local submodule Git data, without a
second terminal prompt. It never bypasses managed-path, repository, claim, or
task-ownership checks. Submodule Git data outside the worktree's ownership, or
used by another checkout outside it, remains protected even with force.
A refusal never automatically retries with force, and the flag is not persisted
as permission for later calls. No background cleanup is introduced.

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

Time checks require one RFC3339 `predicate.at`. Manual checks wait for explicit
human input and are never automatically polled. Omit `predicate.reviewAt` when
no reminder was requested; if supplied, it must be an RFC3339 timestamp. Existing
Pi notices evaluate this optional reminder during work-state refreshes. Becoming
overdue does not satisfy the manual condition. New manual waits have
`nextCheckAt: null`; legacy polling deadlines do not make them eligible. Resource
cleanup still reconciles independently of a retained manual wait.

New check inputs validate required time predicates and explicitly supplied manual
reminders before entering Waiting. Legacy records remain readable for inspection
and repair. Explicit manual outcomes remain fingerprint-bound and do not wait
for any reminder or polling deadline.

Pending PR polls use the configured interval. Automatically observed adapter
failures stay Waiting and use bounded exponential backoff. Exceptions retain
their original message with check context, and repeated-error notices include
the recorded cause. Poll timestamps update observations but never
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
The internal `TaskLifecycleService.releaseWorktree` transaction holds the pool
lock before the store mutation lock through removal and persistence; claim
renewal waits for that transaction. The public `worktree_pool release` tool has
separate lifecycle prepare, pool removal, and lifecycle finalize steps. Its pool
removal does not hold the task-store lock, so same-owner claim/activity metadata
may be refreshed while removal is in progress. That refresh is not evidence that
the checkout is usable: the resource stays `release_pending` until finalization
or reconciliation observes completed removal. Already released resources remain
released.

## Pool boundary and recovery

The worktree-pool core and extension remain task-agnostic. Their public schema
does not expose `claimId` or `pathId` inputs for acquisition, and lifecycle hooks
do not inject private arguments. Pool `list`, `repair`, and unassociated legacy
release remain available without attachment; ordinary acquisition does not.

In v1, acquire correlation is process-local until a validated successful result
records the generated claim. If Pi stops after pool allocation but before that result is
finalized, use pool `list` or `repair` and explicit lifecycle reconciliation;
automatic interrupted-acquire inference is deferred. Preflight reduces known
failures but does not close the allocation-to-persistence crash/race window;
post-allocation association validation still runs. Known association failures
identify the obstructing claim without exposing raw store errors. If recording
fails after allocation, the checkout is retained; do not acquire another copy
as a recovery shortcut.

V2 closes that acquisition reservation gap through the pool's generic versioned
allocation hook: lifecycle policy durably reserves exact identities before Git
allocation. The pool remains task-agnostic; no private IDs enter its public tool
schema. See [v2 resource safety](task-lifecycle-v2.md#observation-and-resource-safety).

Associated release still persists `release_pending` before pool mutation and
reconciles exact safe evidence. Normal release inspects local work before
changing the pool lease or unlocking, then rechecks before removal. For clean
submodules, the pool uses Git's required `--force` removal option internally;
this does not grant permission to discard local work. That requires the separate
explicit `force: true` tool argument. A local-work refusal preserves the checkout
and native owner and explains how to save the work or intentionally discard it.
Explicit releases stay pending for explicit recovery; obsolete expiry releases
can be cancelled by ordinary resource reconciliation without an owner renewal.

If removal fails after unlock, the pool restores the original native claim only
when the exact managed registration, branch, HEAD, and lack of another lock
still match. Ordinary release also requires cleanliness before restoring the
claim; an explicitly forced release may restore ownership of dirty content it
was already authorized to discard. It retains the `removing` journal so an exact
release retry can finish after the cause is resolved. A later call must opt into
force again. Missing, unverifiable, changed-HEAD, or newly locked state is not
relocked. This does not adopt or repair historical unlocked claims. Reconciliation
never retries deletion; no background path gains forced-discard authority.

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

## Optional Datadog work items

With an active catalog, new tasks inherit their project area's explicit local-only
or Datadog Work Management policy. Legacy mode supports a default destination
and explicit workstream overrides or local-only opt-outs. The local Beads task remains
authoritative: creation produces a linked item, local lifecycle changes update
its status, and explicit `task_log` entries become comments. The existing
reconciliation daemon performs delivery; local operations do not wait for
Datadog. Existing tasks are never enrolled automatically.

The private configuration lives at `<Beads store>/pi-work-management.json` (the
same store selected by `BEADS_DIR`). Do not commit it to this package. No file
means no new enrollment in legacy mode; active catalog mode requires v2. An
invalid file fails creation before a task is written. Configure absolute paths
for `dd-auth` and curl >= 8.3.0. The legacy v1 example is:

```json
{
  "version": 1,
  "ddAuthPath": "/opt/homebrew/bin/dd-auth",
  "curlPath": "/usr/bin/curl",
  "defaultTarget": {
    "site": "datadoghq.com",
    "orgUuid": "11111111-1111-1111-1111-111111111111",
    "projectId": "44444444-4444-4444-4444-444444444444",
    "typeId": "33333333-3333-3333-3333-333333333333",
    "assigneeId": "55555555-5555-5555-5555-555555555555",
    "workstreamAttributeKey": "pi_workstream",
    "statuses": {
      "actionable": "Open",
      "active": "In Progress",
      "waiting": "Open",
      "deferred": "Open",
      "completed": "Done",
      "cancelled": "Done",
      "superseded": "Done"
    }
  },
  "workstreams": {
    "local-only": null,
    "example-workstream": {
      "site": "datadoghq.com",
      "orgUuid": "11111111-1111-1111-1111-111111111111",
      "projectId": "22222222-2222-2222-2222-222222222222",
      "typeId": "33333333-3333-3333-3333-333333333333",
      "statuses": {
        "actionable": "Open",
        "active": "In Progress",
        "waiting": "Open",
        "deferred": "Open",
        "completed": "Done",
        "cancelled": "Done",
        "superseded": "Done"
      }
    }
  }
}
```

Legacy v1 routing is selected only when the task is created:

1. A matching workstream target overrides `defaultTarget`.
2. A matching workstream set to `null` stays local, even when a default exists.
3. An unmatched workstream, or a task without a workstream, uses `defaultTarget`.
4. Without a default or matching target, the task stays local.

Catalog activation replaces this file with v2, keeping only executable helpers:

```json
{
  "version": 2,
  "routingMode": "catalog",
  "ddAuthPath": "/opt/homebrew/bin/dd-auth",
  "curlPath": "/usr/bin/curl"
}
```

Targets belong to area publication policies, not this file. Active catalog + v1,
or prepared/missing catalog + v2, blocks new creation. Older v1 parsers reject
v2 rather than falling back to a personal/default board. Existing captured
bindings still deliver through compatible daemon code during partial cutover.

`defaultTarget` is optional; omit it to retain explicit-workstream-only behavior.
An empty `workstreams` object is valid. Remove `defaultTarget` rather than setting
it to `null`. Null is only a workstream opt-out.

Replace every sample UUID and status with explicitly approved values for the
actual project/type. Nothing creates projects or statuses for you. Supported
sites are `datadoghq.com`, `datadoghq.eu`, and the `us3`, `us5`, `ap1`, `ap2`, and
`uk1` subdomains of `datadoghq.com`. Workstream matching uses the same label
normalization as task displays, then compares case-insensitively. Mappings that
collide after normalization are rejected. No credentials belong in this file.
`statuses.waiting` applies to all waits by default. An optional
`statuses.waitingOnPullRequest` (for example, `"In Review"`) overrides it only
while the task is Waiting on a `github_pull_request` check. Dependency, manual,
and time waits still use `waiting` (for example, `"Blocked"`). Active tasks use
`active` even when retaining a PR check. Omitting the override preserves the
single-waiting-status behavior, including for previously captured targets.
Completed, cancelled, and superseded outcomes have their own mappings.

A target may set `assigneeId` to a Datadog user UUID for assignment on creation.
It may also set `workstreamAttributeKey` to an existing, single-value TEXT custom
attribute on its case type. Catalog-backed tasks capture the project's current
display name as that attribute's value, preserving case and spaces. Their project
UUID, compatibility workstream key/aliases, and local workstream labels are
unchanged. Legacy tasks still use the canonical Pi workstream; tasks without one
omit the attribute.
Provision the field separately with explicit approval: custom attributes belong
to the shared case type, not just one project. Omit either option to retain its
previous behavior. Workstream overrides are complete targets and do not inherit
these optional fields from `defaultTarget`.

Assignment and workstream metadata are sent only on creation. Later remote
reassignment or field edits are not overwritten by status/comment delivery;
later project renames do not rewrite the captured value, even when initial
delivery is still pending. Enabling these options does not update existing items.
Correcting existing labels is a separately approved, field-only remote edit;
it does not require recreating items or changing their captured destinations.

The task snapshots its target, status mapping, and publication label at creation.
Editing/removing the default, a mapping, or task labels does not reroute previously
enrolled tasks.
A later workstream opt-out does not stop delivery for tasks already enrolled.
Keep the configuration file and executable paths available for those tasks even
if the default is removed and the `workstreams` object becomes empty.

`piWorkManagement` metadata stores only the binding, current external identity,
delivery receipts, and pending/error state. It is separate from `piLifecycle` and
has no ownership authority. Tool results, scoped work state, and the existing
startup table display compact WM status and a validated link when available.
`WM linked` means an item exists, not that the native journal has just been
scanned. New log entries are discovered on the daemon's next scan.

For enrolled tasks, native progress entries carry a `[pi-task-log:v1]` footer.
The external comment omits it; native journal output may display it. A malformed
sync record does not prevent owned local logging; those entries retain their tag
for delivery after repair. Only tagged entries publish, identified by native
comment ID, so identical messages can be
legitimate separate comments. Neither transcripts nor arbitrary native comments
are published. Enabling a default or workstream target makes the routed tasks' new
titles/descriptions and explicit logs publishable; do not put secrets in them.
A personal project is not necessarily private. There is no automatic secret
detection.

There is no remote polling, drift correction, backlog import, or comment editing.
Remote manual edits remain until a later local status change requires delivery.
Reopening uses the same item. Confirmed comments are not replayed after restart.
An uncertain write pauses that task's entire sync, including status updates.
See [daemon operations](task-reconciler-operations.md#work-management-delivery)
for activation and manual recovery.

### Datadog browser login

Work Management authentication uses stock `dd-auth`; browser login is normal.
Authentication runs before the durable write reservation. If it times out or
cannot obtain credentials, local work stays independent and queued for retry.
`WM login needed` and the existing Pi task notice provide the configured
org/site login command. Finish login with that command and allow the existing
backoff to expire; no task-state repair is needed for an authentication failure.
Credentials stay in process memory and stock dd-auth's cache, never in task
metadata, configuration, notices, or reports. An ambiguous **write** still pauses
sync for manual inspection; logging in does not replay it.
