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
mission or lifecycle. Writes require current active ownership. Update before
waiting/deferring; claim before changing content on resume.

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

## Wait without retaining an idle checkout

Save durable work, finish child use of the checkout, resolve local changes, and
explicitly release managed worktrees before waiting, deferring or closing.
Preserve failed cleanup/ownership facts rather than hiding them with a transition.

Use the existing lifecycle:

- Claim waiting work when there is a useful authorized fix, then return to its
  retained condition. Do not create a task per comment.
- Use `onSatisfied: actionable` if an agent still owes validation, communication,
  cleanup or a handoff after the check. For example, deployment becoming available
  leaves behavior validation and the final reply actionable in this same task.
  Auto-close is only suitable when the condition's satisfaction fulfills all
  remaining completion requirements.
- Use the supported dependency, PR, time or manual wait for the current blocker;
  record later conditions in the handoff. A manual wait needs no invented polling
  deadline or reminder. Add reminders only when requested.
- Defer intentionally parked work. Cancel or supersede abandoned work explicitly;
  a PR closed without merge is not successful delivery. Revisit related commitments
  rather than automatically completing them.

The current task checks observe merges, requested changes and conflicts, not every
ordinary comment, approval or CI transition. There is no deployment-specific
check. The daemon updates state/notices; it does not launch an agent. Do not
promise unattended follow-through or silently add a watcher to compensate.

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
