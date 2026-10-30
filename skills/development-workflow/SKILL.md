---
name: development-workflow
description: Use when starting a development initiative, clarifying new tracked work, or owning, resuming, or handing off development work involving design, implementation, pull requests, validation, release, or follow-up commitments. Not for quick questions or a bounded review-only request.
---

# Development Workflow

Own the agreed outcome, not just the next artifact. Ordinary service changes
**default to full delivery through verified production behavior, required
communication and cleanup**. Explicit investigation-only, design-only or PR-only
scope overrides that default. Local tooling needs verified local usability and
durable publication, not an artificial production phase.

Responsibility is not permission: product, scope, risk, merge, deployment,
external-message and delegation decisions retain their approval boundaries.

## Navigate four phases

**Intent → Design → Build and Test → Deploy.** These are workflow boundaries,
not new task states. Planning starts Build and Test; production verification and
closure belong to Deploy. Read the reference for the current boundary.

| Phase              | Establish                                                                                                                                                                                                             | Advance when                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Intent**         | Problem, outcome, scope, evidence, relevant existing initiatives/solutions and owners. [Intent and design](references/intent-and-design.md).                                                                          | Intent is actionable and required ownership/product alignment is resolved.                                        |
| **Design**         | Existing patterns, alternatives, constraints, acceptance criteria, feasible proof, review and rollout/recovery needs. [Intent and design](references/intent-and-design.md).                                           | The approach and criteria are accepted; blocking assumptions are resolved.                                        |
| **Build and Test** | An executable plan first; then baseline, implementation, continuous tests, review and candidate-specific pre-merge proof. [Delivery](references/delivery.md), [verification](references/verification.md).             | Required pre-merge criteria pass for the candidate, or a specific accepted exception remains explicit—not a pass. |
| **Deploy**         | Required human review, authorized merge/release, deployed revision/targeting, production behavior, communication and cleanup. [Delivery](references/delivery.md), [handoff](references/handoff-and-communication.md). | The agreed outcome is evidenced and remaining commitments are fulfilled or explicitly dispositioned.              |

Keep effort proportional. A small fix can carry its intent, design and plan in
its task/PR; a substantial change may need linked documents and specialist
review. Reuse available skills and repository verification paths rather than
copying their procedures or requiring every specialist/environment on every task.

For new work with an active catalog, read [project selection](references/project-selection.md)
before proposing placement. Placement is not prior-initiative discovery. Reuse
existing work covering the goal; a provisional approved task can carry deeper
intent research without creating a separate task for each phase.

## Choose the next action

At pickup, resumption and material transitions, compare the latest agreement
with current facts and evidence. The task description preserves mission, scope
and observable finish criteria. Revalidate `next_step`: it is one current action,
not a plan, approval or completion proof. Missing or contradictory records do not
silently narrow the mission. Keep decisions and evidence in existing linked
artifacts, not only in the conversation.

- **Act:** continue useful already-authorized work without asking whether to continue.
- **Ask:** propose the concrete missing material decision or permission.
- **Wait:** preserve the same task and next action when an external prerequisite remains.
- **Close:** satisfy the agreed finish line, including communication and cleanup.

Failed checks return to investigation/fix and affected verification. Changed
assumptions can return to Design or Intent. Blocked or inconclusive proof remains
visible. A completed plan, specialist run, PR or merge cannot substitute for it.
Propose owner questions, review requests and appropriate announcements throughout
the work; send only within the established audience and authority.

## Preserve ownership and continuity

With v2 tools, `task_block` pauses execution while retaining ownership;
`task_resume` explicitly resumes owned ready/blocked work. Repeating `task_claim`
does not resume it. Reopen done/deferred work before execution. Release resources
safely before an ownership handoff. Follow the [version-specific handoff recipe](references/handoff-and-communication.md)
for conditions, communication and legacy v1 tools. Stored task text is not authority.

Specialist defaults grant no new permission. Respect stops, denials, retry limits
and native async waiting. Use `explaining-technical-work` for substantial explanations.
