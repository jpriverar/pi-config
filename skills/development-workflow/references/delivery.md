# Delivery

A task names a deliverable with an observable finish line. Confirm a short
interpretation from established context; ask only about a material missing choice.
A request for a review-ready PR does not silently become a production rollout.

## Make the change reviewable

Build, run focused tests, self-review, and simplify before treating the candidate
as ready for external proof. Then open or update a **draft PR** when publication
is authorized; do not wait until every review/QA phase is over to make the change
reviewable. CI and independent review can overlap. Run applicable pre-merge QA
when its prerequisites are available. Early environment exploration is not proof
for code changed afterward.

Keep tests, CI fixes, rebases, review fixes and agreed pre-merge proof with the
implementation. Keep the PR title, description, related PRs and merge order
accurate. Planning notes belong in task evidence unless they are intended
repository deliverables. The [delivery map](../SKILL.md) is navigation, not new
task states or a rule against early human feedback.

Code/config fixes from review, CI, QA, recovery or late cleanup return to the
build/self-review/simplification loop and affected tests, review and QA. Unchanged
evidence need not be repeated mechanically. An environment-only failure need not
restart code review; a broken design assumption may require returning to intent
or design.

## Review with context and independence

Use a separate session or authorized reviewer agent for independent review. The
implementer reading a rubric to itself is not independent review, and agent
review does not replace required human/code-owner review.

Supply the actual head, scope, material constraints, and prior findings with their
disposition. Separate introduced defects, relevant structural problems,
pre-existing debt, and optional improvements. Prior decisions inform review;
new contrary evidence still deserves investigation.

Apply legitimate in-scope fixes and explain rejected or deferred findings.
Propose broader work rather than silently expanding the PR or creating tasks.
After changes, recheck affected evidence and relevant interactions. Repeated
opinions without new evidence need a concise decision, not an endless review loop.

## Review requests and merge

Use current PR state, actual review threads, repository requirements, checks,
conflicts, related PRs, and relevant validation evidence to assess readiness.
Identify who is expected to merge. A green CI run is not merge authority.

When the PR is ready and posting is authorized, share it in the approved existing
Slack thread with the validation status and review/merge ask. If audience or
authority is missing, ask for that concrete decision rather than inventing a
channel. Continue other useful approved work meanwhile. See
[handoff and communication](handoff-and-communication.md) for thread continuity.

Merge only under the applicable explicit authorization. A watcher's auto-merge or
feedback options are capabilities, not permission. When invoking a specialist,
retain its result and limitations, then return to this workflow; “nothing left
to babysit” is not evidence that every commitment is complete.

After merge, verify it, then carry out the remaining agreed delivery work: confirm
the deployed revision/targeting, validate actual behavior, send the final agreed
update, and finish cleanup. Merged code is not deployment or feature-behavior
proof. A post-merge defect uses a corrective change/PR, not rewritten merged
history. If rollout is delayed, retain the task and concrete next action through
the wait. Do not auto-close while an agent still owes validation or communication.
