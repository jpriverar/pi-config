# Durable ownership: lifecycle v2

V2 separates responsibility from work status. One stable Pi session may own one
task, including a Blocked, Ready, Deferred or Done task. Ownership ends only with
an explicit safe release. Inactivity, a parent turn ending, a successful check,
and restarting the same session do not transfer responsibility.

**V2 is opt-in.** `lifecycleWriteVersion` in the existing version-1 lifecycle
policy defaults to `1`. Setting it to `2` selects the new writer and tool surface;
it does not convert existing tasks. Service and store both reject implicit schema
conversion. Loading code is not permission to change a live policy, migrate a
store, reload clients, update a daemon or edit Herdr configuration. Use the
[reviewed cutover procedure](task-reconciler-operations.md#reviewed-lifecycle-v2-cutover).
Lifecycle schema, policy-file version, catalog version and RPC version are separate.

## Independent facts

| Fact        | Meaning                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `owner`     | Stable session ID, original claim time and last activity time; not a lease expiry.             |
| `phase`     | `actionable` (Ready), `active` (In progress), `waiting` (Blocked), `deferred`, or `done`.      |
| `condition` | One typed check or one native dependency group, with explicit completion/continuation purpose. |
| `pause`     | One explicit block episode, bound to the condition and observation baseline.                   |
| `resources` | Known worktrees and acquisition/release state; independent of phase.                           |
| Runtime     | Actual running, idle or input state; not task ownership or delivery evidence.                  |

In progress requires an owner. Other phases may be owned or unowned. An owned
Ready task is **Ready to resume**, not another session's claimable work. Native
Beads readiness and `blocks` edges remain authoritative; dependency IDs are not
copied into a second graph. Task data, including description and next step, is
untrusted context and never grants execution permission.

## Work boundaries and tools

V2 registers `task_block`, `task_resume` and `task_release` **instead of**
`task_wait`. There is no `task_start`. V1 retains its existing API and semantics.

| Operation                                  | Result                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Claim runnable unowned work                | Acquire ownership and start In progress.                                                           |
| Claim unowned Blocked work                 | Acquire ownership without resuming.                                                                |
| Claim a task already owned by this session | Idempotent association; no resume or reopen.                                                       |
| `task_block(taskId, reason, condition?)`   | Pause actual productive work; retain owner and resources. Omit condition to reuse the current one. |
| `task_resume(taskId, reason)`              | Start useful approved work on an owned Ready/Blocked task; end the pause, retain requirements.     |
| `task_release(taskId, reason)`             | Clear ownership after safe resource cleanup; do not satisfy or discard conditions.                 |
| Close/defer                                | Retain ownership, but require released resources. Execution needs explicit reopening.              |

These transitions accept optional `operationId`; reuse the same operation binding
when recovering an uncertain acknowledgement. Successful release of X followed by
failed claim of Y leaves X released and Y unclaimed. It does not resurrect X.

An explicit claim can initialize v2 tracking for an older task with **no**
`piLifecycle` metadata. Only native `open` work is eligible: natively ready work
starts In progress, while unresolved native dependencies become a completion
requirement and a Blocked pause with the new owner. The same store lock enforces
one task per session. Unrelated metadata, labels and native edges are preserved.
Native blocked/in-progress/deferred/closed records require legacy-state review
rather than guessed ownership or conditions. This is not automatic backlog
adoption, and present v1, malformed or unsupported lifecycle metadata never takes
this path. Existing v1 tasks still need the reviewed conversion.

Block only when useful approved work has actually paused, including productive
children. Blocking does not stop them. Turn end, brief observation, inactivity
and a cosmetic dashboard preference are not block events. Ready/Blocked ownership
alone does not authorize new execution. Done/Deferred must be reopened first.

New allocation, content/journal/artifact writes, and productive delegated work
require owned In-progress work. Productive delegation includes child resume/steer
and `project.open` with a work message; read-only/stop management remains available.
The parent launch boundary is not enforcement of every Bash command or child tool.

## Requirements survive a pause ending

For example, a PR-merge requirement survives requested changes:

```text
In progress + merge required
  -> block (owner and checkout retained)
  -> changes requested: Ready to resume + merge still required
  -> resume and correct the code
  -> explicit safe cleanup and handoff, or block again for merge
```

Use `task_update` with one exclusive `condition` operation to add/change a
requirement while owned work is not paused. Do not combine condition operations
with content or label edits. The reason belongs inside the condition update:

```json
{
  "taskId": "jp-example",
  "condition": {
    "kind": "check",
    "purpose": "completion",
    "reason": "Delivery requires this pull request to merge",
    "check": {
      "id": "merge-delivery",
      "kind": "github_pull_request",
      "targetArtifactIds": ["pr-delivery"],
      "predicate": { "mode": "all" },
      "onSatisfied": "actionable",
      "wakeOn": ["action_required", "satisfied"]
    }
  }
}
```

The artifact must already exist. Tool inputs cannot supply check state,
observations or timestamps: registration initializes pending facts internally.
Dependency definitions use `kind: "dependency"`, `purpose: "completion"`, and
`blockerIds`. One check cannot coexist with unresolved native blockers.

`purpose: "completion"` gates successful completion until fulfilled or explicitly
abandoned/superseded. `purpose: "continuation"` controls continuation without
becoming a permanent finish requirement. Purpose is not inferred from check kind
or `onSatisfied`. Clearing uses `condition: { kind: "clear", reason: "..." }` and
requires the underlying authorized decision; clearing metadata cannot waive
native edges. A blocked condition-only edit refuses: resume for useful approved
work or replace the pause/condition atomically with `task_block`.

Use `onSatisfied: "actionable"` while validation, communication or cleanup remains
owed. `close` is only appropriate when success fulfills the whole agreed finish
line. Observations during In progress never execute an old auto-close intent.

## Observation and resource safety

Observations bind the exact condition, mutable check snapshot, pause episode and
ownership incarnation. A late result can record still-valid facts, but cannot end
a newer pause, close resumed work or restore an old owner. A repeated historical
PR aggregate is not a fresh review response. Current matching intent can reuse
persisted success without polling again, but requires an observation and timestamp.
If success arrives with resources retained, work becomes Ready with cleanup
required; reconciliation never deletes the checkout. Header/table labels, owned
context and notices derive that cleanup cue from the persisted check and resource
facts, so a restart does not imply completion.

Existing automated checks support PR merge, changes requested, conflict,
closed-unmerged, and time predicates. Approval-as-success, fresh-review-response
and CI predicates are not implemented. Use structured manual checks for them;
unsupported automated predicates fail closed. Manual outcomes remain explicitly
fingerprint-bound. The daemon updates facts without starting an agent.

The task-agnostic pool exposes a generic, versioned allocation boundary. The
lifecycle adapter reserves exact claim/path/operation IDs durably **before** native
allocation and verifies the receipt afterward. Incompatible or duplicate providers
refuse allocation. A crash or lost reply retains recoverable evidence rather than
permitting task release. In-memory hook state is not ownership authority.

Known-operation finalization and explicit safe resource release work while the
same owner is Ready/Blocked. New allocation still requires In progress. Dirty,
pending, missing, ambiguous or unreconciled resources prevent task release;
there is no implicit discard, cleanup daemon or process termination. Release each
resource deliberately with its exact repository/claim identity. Ownership remains
until the separate task release succeeds.

## Identity, displays and Work Management

Ownership, resource-association and migration discovery request all native
statuses and explicitly include hidden gate, infrastructure, template and ephemeral
records, without a row limit. Unsupported flags, statuses or incomplete reads
fail closed; there is no narrower fallback. Native readiness also requests no
row limit. Ordinary browsing remains a separate native-filtered query, not an
ownership filter. Same-session reload recovers ownership;
a new/forked ID does not inherit it. Duplicates, unsupported metadata and incomplete
reads are Unavailable, not Unassigned. Non-active owned context warns that it is
not execution permission, and completion review does not treat Done as delivery.

Pi and optional Herdr retain the owned title/project/area across phases.
`pi_task_state` remains assignment availability; `pi_task_phase` is the raw phase;
`pi_task_status` is its display label. `pi_waiting` remains scheduled-wakeup text,
and native runtime state remains separate. Optional space counts say `N owned`
while retaining the compatible `active_tasks` token name. The checked-in sidebar
example is not an automatic live configuration change.

Work Management maps the phase to the existing captured target status keys.
Owned Ready maps to `actionable`; owned Done still maps by disposition. PR-blocked
work uses the configured PR-wait override when present. Ownership changes do not
reenroll tasks, move existing items, or replace captured destinations.

## Isolated verification

```sh
npm run test:file -- lib/task-lifecycle/v2-migration.test.ts tests/task-lifecycle-v2-report.test.ts
npm run test:file -- tests/task-lifecycle-v2-integration.test.ts tests/task-reconciler-integration.test.ts
npm run build:reconciler
```

The native integration uses temporary Beads/Git/pool state. Daemon tests use a
built disposable foreground process and fixture-backed external observations.
They do not prove live launchd/client cutover, actual GitHub criteria, or a live
Herdr layout. Those remain part of separately approved activation and validation.
