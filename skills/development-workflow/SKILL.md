---
name: development-workflow
description: Use when planning new tracked work or owning, resuming, or handing off approved development work involving implementation, pull requests, review, validation, external waiting, or follow-up commitments. Not for quick questions or a bounded review-only request.
---

# Development Workflow

Carry the whole agreed outcome to its finish line, normally in the same task.
An artifact, specialist result, completed plan, or task record is not that finish
line. Scope changes come from the user's agreement, not from a phase transition.

## Navigate the delivery loop

For new tracked work with an active area/project catalog, **read
[Project selection](references/project-selection.md) before forming the placement
and approval proposal**.
Reuse an existing task when it already covers the goal; routine operations on
that task do not need another placement decision.

Under **Intent → Design → Build and Test → Deploy**, full delivery follows this
map. Arrows grant no authority. An agreed RFC-only or PR-only mission can finish
earlier; include only phases and communication within the agreed scope.

```mermaid
flowchart TD
    A["Agree on goal and finish line"] --> B["Build, test and simplify<br/>Open/update draft PR"]
    B --> C["Review, CI and pre-merge QA"]
    C -->|Changes needed| B
    C -->|Ready| S["Share PR in the approved Slack thread"]
    S --> H["Human review + authorized merge"]
    H -->|Changes requested| B
    H --> V["Confirm deployment<br/>Validate the actual behavior"]
    V -->|Fix needed| B
    V -->|Verified| U["Post final Slack update<br/>Complete agreed cleanup"]
    U --> D["Close the task"]
```

At pickup, resume, or a material transition, compare the latest user agreement
with the task description, evidence, and current facts. The description keeps the
mission, observable finish criteria, and scope. Revalidate the recorded
`next_step`; it is one current action/check, not a plan, permission, or proof of
completion. Missing or contradictory records require conversation-based judgment,
not a smaller inferred mission.

| Choice    | Condition                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| **Act**   | Useful already-authorized work remains. Take the next action without asking whether to continue.               |
| **Ask**   | A missing scope, risk, authority, or outcome decision changes the next action. Ask that question.              |
| **Wait**  | Only a concrete external prerequisite remains. Preserve the next action and release temporary resources.       |
| **Close** | The agreed finish line is met and remaining commitments are fulfilled or explicitly dispositioned by the user. |

Load the reference for the current boundary:

- [Delivery](references/delivery.md): self-review, draft PRs, independent review,
  CI/QA, fixes, ready-PR sharing and authorized merge.
- [Verification](references/verification.md): candidate-bound proof,
  post-deployment behavior, gaps and exceptions.
- [Handoff and communication](references/handoff-and-communication.md):
  `task_update(... next_step ...)`, same-task waiting, communication and cleanup.

Use repository-appropriate skills and tools; their defaults do not expand
permission. Respect explicit stops, denials, retry limits and native async waiting.
Use `explaining-technical-work` for substantial explanations, not routine status.
