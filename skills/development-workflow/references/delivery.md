# Delivery

A task names a deliverable with an observable finish line. Confirm a short
interpretation from established context; ask only about a material missing choice.
A request for a review-ready PR does not silently become a production rollout.

## Make the change reviewable

Keep focused tests, CI fixes, PR creation, rebases, review fixes, and agreed
pre-merge proof with implementation. Publish or refresh the PR when that is part
of the approved scope, rather than making the user repeat the request. Keep its
title, description, related PRs, and merge order accurate. Planning notes belong
in task evidence unless they are intended repository deliverables.

Review and validation may overlap. The diagram is a navigation aid, not new task
states or a rule against early human feedback:

```text
Implement / PR → review + CI + applicable proof → ready for authorized merge
                    ↑              |
                    └─ affected fixes / rechecks
```

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

Merge only under the applicable explicit authorization. A watcher's auto-merge or
feedback options are capabilities, not permission. When invoking a specialist,
retain its result and limitations, then return to this workflow; “nothing left
to babysit” is not evidence that every commitment is complete.

After merge, verify the merge and remaining closeout conditions. If communication
or a handoff still needs an agent, resume actionable work rather than auto-close.
Use [handoff and communication](handoff-and-communication.md) before ending the
producing task. Merged code is not deployment or feature-behavior proof.
