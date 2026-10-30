# Handoff and Communication

Preserve the agreed delivery loop in the **same task by default**, including PR
sharing, review follow-through, deployment/behavior validation, final communication
and cleanup. Split only for a genuinely separate outcome or owner, with approval
and an explicit handoff—not for every review round, message or delay. Optional
improvements do not block a fulfilled deliverable.

## Leave enough context to resume

Use the existing task record, not a new checkpoint template or journal parser:

| Existing place    | Purpose                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Description       | The agreed mission, observable finish criteria and scope; a phase finishing does not rewrite it. |
| `next_step`       | One current action/check, revalidated against current facts and the latest agreement.            |
| Lifecycle         | Ownership, readiness, concrete waits and disposition.                                            |
| Journal/artifacts | Evidence, decisions/exceptions, remaining commitments, thread receipts and cleanup facts.        |

At material transitions and handoff, update the current action while the task is
actively owned. For example, after an authorized merge with rollout still pending:

```js
task_update({
  taskId: "jp-example",
  next_step: "Confirm staging contains the merged abc123 change",
});
```

The description still owns the whole agreed outcome; validation and the final
update have not vanished. If it needs correction, `task_update` can also change
`description` to reflect the user's agreement—not the most recently completed
phase. Omit a field to preserve it; `next_step: null` clears only the hint, not the
mission or lifecycle. Content/journal writes require current In-progress
ownership. Record the next action before blocking or deferring. On useful
approved resumption, use `task_resume` for an already-owned v2 task, then update
content; a same-owner claim does not resume it. With v1 tools, claim waiting
work before changing content. Resource cleanup is independent and does not
require resuming an owned Ready/Blocked v2 task.

Native description, next-step and comment writes use plain single-line text;
next steps are limited to 2000 Unicode code points. Link longer evidence instead
of copying logs. Missing, stale, malformed or oversized context is a reason to retrieve/reconcile
the full agreement, not to infer completion or adopt another session's task.

## Close only the agreed outcome

PR publication, merge, deployment, behavior verification and communication are
different conditions. Close when the agreed conditions are fulfilled or the user
has explicitly dispositioned what remains. A PR-only mission can end at its
agreed finish line; a full-delivery mission cannot silently become PR-only.

Continue agreed remaining work in the same task. For a genuinely separate,
approved successor, establish a real identity, sufficient context and the correct
prerequisite. If creation/linking fails or approval is missing, disclose the incomplete handoff
and ask for its disposition. Do not claim the work is covered by a proposed task.
The user may explicitly drop, defer or replace a commitment.

Follow the tools' ownership rules. Creating a task does not grant permission to
log, attach artifacts or install a wait on a task owned elsewhere. A successor's
creation description can carry its initial context; subsequent writes require a
valid claim. Use native dependencies for genuine prerequisites, not every related
link. Completing an implementation task that ends at PR publication does not
prove its PR merged.

## Pause work and manage resources independently

Use the actual available tools and matching record/writer version. A mismatch is
a compatibility problem, not permission to migrate, reload or fall back to a
conflicting API.

### V2: block, resume, release

| Observed boundary                                                                 | Action                                                                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| All useful approved work has actually paused, including productive children       | `task_block` with the exact existing or atomically registered condition; retain ownership.                                              |
| Owned Ready/Blocked work has a useful approved next action                        | `task_resume`, then perform the work. Same-owner `task_claim` is idempotent, not a resume.                                              |
| Owned Done/Deferred work needs more agreed execution                              | `task_reopen`, then resume; terminal association alone is not execution permission.                                                     |
| Intentional handoff or switch                                                     | Safely release every resource, `task_release` X, then `task_claim` Y. If Y fails, X stays released; do not invent or restore ownership. |
| Only a parent turn ends, the pane is idle, or a productive child is still running | No lifecycle transition merely for appearance or inactivity. Blocking does not stop children.                                           |

Claim unowned work rather than resuming it. Claiming unowned Blocked work acquires
responsibility without resuming; execution still needs a useful approved next
action and an explicit resume.

A pause and a completion requirement are separate. Requested PR changes may make
X Ready for corrections without satisfying its merge requirement: resume X and
retain that exact requirement. Clear or replace an unmet completion requirement
only through an explicitly authorized, reasoned abandonment/supersession. Do not
create a checkpoint task for each comment, or treat stale task text as approval.

Release idle checkouts when work is durable and no child uses them. A v2 block may
retain a dirty or otherwise unreleasable checkout while productive work is truly
paused; record the cleanup facts and retain ownership. Do not discard work, commit
unfinished material, terminate a process, or delay an approved pause just to make
a cleanup precondition pass. Closing, deferring, and releasing the task still
require safe resource cleanup. Pending/uncertain releases require exact native
observation or authorized retry, not a second checkout or a forced task release.

Done/Deferred and readiness retain ownership until explicit release. A fresh
session ID does not inherit the old owner's task; an Unavailable display is not
proof of no owner. Keep failed/ambiguous facts visible and use the original owner
and established recovery path. There is no inactivity takeover.

### V1: legacy wait and claim

When only `task_wait` exists, save durable work, finish child use, resolve local
changes, and explicitly release managed worktrees before waiting, deferring or
closing. `task_wait` relinquishes v1 ownership. Claim waiting work for a useful
approved fix, retaining its condition. Do not invent `task_block`, `task_resume`,
or `task_release` calls on this surface, or enable v2 to avoid a refusal.

### Conditions and remaining delivery

Use `onSatisfied: actionable` when validation, communication, cleanup or handoff
remains owed after a check. Auto-close is suitable only when the condition fulfills
the whole remaining finish line; Done is not independent delivery evidence.
Use one supported dependency group or typed PR/time/manual check. The current PR
adapter observes merge, requested changes and conflicts, not arbitrary comments,
approval-as-success, fresh review responses or CI transitions. Unsupported
observations require a structured manual check; never invent predicate fields or
polling deadlines. Add reminders only when requested.

Defer intentionally parked work; explicitly cancel or supersede abandoned work.
A PR closed without merge is not successful delivery. The daemon updates facts
and notices but does not launch an agent. Do not promise unattended follow-through
or silently add a watcher to compensate.

## Propose communication throughout the work

Do not wait until a PR exists to notice a coordination need:

- During Intent, identify relevant owners/initiatives and propose a concrete
  question when available evidence cannot resolve ownership or requirements.
- During Design, surface shared-contract changes and required cross-team alignment
  early, with the decision and evidence the reviewers need.
- During Build and Test, request appropriate draft feedback or ready-PR review;
  keep validation gaps explicit.
- During Deploy, consider operator/user impact and propose an announcement,
  documentation or rollout coordination when warranted, then the final result.

Proposing outreach is not permission to send it. Reuse an established audience
and authorization; ask for the concrete missing decision rather than repeatedly
asking to send already-approved updates. Do not broadcast every small change.

## Communicate where it advances the work

Use the approved audience and existing thread. If no external audience was
approved, report in the current conversation. A visible destination ID is not
approval: do not add it to the description, next step or journal as a commitment.
Record an approved thread's link, the last useful message, and which deliverable
owns any outstanding update. Re-read the thread before publishing so another
session does not duplicate a message or miss a reply.

- **Ready-PR review request:** change/PR link, relevant context, validation status,
  exact ask and intended merge owner in the approved thread. Drafting a message
  is not sending it.
- **Material progress or blocker:** short delta and next action, not a new root
  message for every push or another mention without useful information.
- **Follow-up:** a specific ask when an agreed reminder is due or new information
  warrants it; no recurring nag schedule by default.
- **Final result:** distinguish merged, deployed and behavior verified. Send the
  agreed final update after the relevant proof, with remaining limits and cleanup
  status. Record a publication receipt; a prepared message is still owed.

Read back uncertain publication rather than blindly resend. Communication normally
belongs to the deliverable it advances, not its own task or lifecycle state.
