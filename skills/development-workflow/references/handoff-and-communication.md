# Handoff and Communication

Preserve the commitment, not necessarily the task ID. Split work only when a
separate outcome, owner, scope, or proof makes it independently meaningful—not
for every review round, message, or delay. New tasks require approval. Optional
improvements do not block a fulfilled deliverable.

## Leave enough context to resume

Use existing task descriptions, journals and artifacts, not another state file.
Keep a compact record, omitting irrelevant fields:

```text
Deliverable and finish line:
Current result and evidence: PR/head, report, or runtime observation
Remaining action, blocker, and next actor:
Related work and approval status:
Missing proof and prerequisites:
Authority and explicit exceptions:
Communication thread, sent/drafted, and outstanding update:
Temporary resources and cleanup status:
```

Link evidence rather than copying logs. A fresh session should be able to choose
the next action without reconstructing the conversation.

## Close one deliverable without losing the next

For agreed remaining work, either continue the same task or establish an approved
successor with a real identity, sufficient context, and the correct prerequisite.
If creation/linking fails or approval is missing, disclose the incomplete handoff
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
- For a PR check, use `onSatisfied: actionable` if an agent still owes closeout,
  communication or a handoff. Auto-close is only suitable when the condition's
  satisfaction fulfills all remaining completion requirements.
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

Use the approved audience and existing thread. Record its link, the last useful
message, and which deliverable owns any outstanding update. Re-read the thread
before publishing so another session does not duplicate a message or miss a reply.

- **Review request:** change/PR link, relevant context, validation status, exact ask
  and intended merge owner. A draft is not a sent request.
- **Material progress or blocker:** short delta and next action, not a new root
  message for every push or another mention without useful information.
- **Follow-up:** a specific ask when an agreed reminder is due or new information
  warrants it; no recurring nag schedule by default.
- **Merge/result:** distinguish merged, deployed and behavior verified. Send only
  the updates that are part of the agreed communication, with relevant limits.

Read back uncertain publication rather than blindly resend. Communication normally
belongs to the deliverable it advances, not its own task or lifecycle state.
