# Intent and Design

## Intent: establish the problem before choosing the solution

Start with the source request and current behavior. Establish who is affected,
why the change matters, the desired outcome, scope/non-goals and relevant
constraints. A suggested architecture is an option, not an approved design.

Do bounded discovery to identify existing work and propose the task. Follow the
operator's task-approval policy before substantial research. A provisional
approved task can hold the investigation and be refined as intent becomes clear;
do not require finished research before permitting the research itself.

Look for relevant initiatives, tickets, design documents, code, platforms and
maintained discussions using the sources available in the operator/repository
context. Scope the search to the problem and likely owners; do not search the
whole organization for every small fix. Record useful sources, overlap and reuse
options. An unavailable source means coverage is incomplete, not that no prior
work exists. Project placement alone does not establish whether a solution
already exists or another owner is building it.

Use available `brainstorming` guidance when intent or scope needs clarification.
Answer factual questions from available evidence before asking the engineer.
Identify material product or cross-team decisions, and propose a concrete owner
question when investigation cannot resolve them. Sending it requires the
applicable authorization; continue independent authorized research meanwhile.

**Ready for Design:** a clear problem/outcome, named owner, useful evidence,
bounded scope and required alignment. Design may investigate explicitly open
technical questions. Keep the mission and evidence in the existing task and
linked artifacts, with the default or explicitly narrower finish line intact.

## Design: choose an approach and how to prove it

Read the relevant implementation, repository instructions, canonical examples,
contracts and maintained standards before inventing a mechanism. Check existing
platforms and helpers. Precedent informs the choice; it does not override a
contract or justify repeating a known mistake.

Propose the simplest effective approach and meaningful alternatives. Make
applicable invariants explicit: isolation/authorization, compatibility, data
correctness, ordering, durability, performance and failure behavior. Identify
required owners/reviewers and rollout/recovery implications, including stored
state, configuration, feature targeting and coordinated changes.

For uncertain or consequential assumptions, suggest `grill-me` or focused
technical questions. It sharpens requirements and falsifiable predictions; it
does not replace solution design or require an interview for a small clear fix.
If a question needs research, do that research rather than asking the engineer
to guess. Route genuine ownership or risk decisions to the responsible human.

### Define acceptance before implementation

For each relevant behavior or invariant, identify:

- Representative inputs, workloads, boundary/failure cases and expected results
  or thresholds; include the baseline when comparison matters.
- Where the check belongs: **local**, **isolated test environment**, **production**,
  or a justified combination. Repository-specific mechanisms supply the commands.
- The concrete test, request, browser scenario or telemetry query and evidence
  needed to support the claim, including revision/configuration, cohort and
  observation window where applicable.
- Prerequisites, limitations and decisions needed to make the check feasible.

For example, a retry change might require a local duplicate-request test, an
isolated worker-restart test with a latency bound, and production observations
for the deployed revision under qualifying traffic. A healthy process alone
answers none of those behavior questions. Production criteria remain pending
until deployment; they are not obstacles to finishing pre-merge validation.

Keep criteria and results in an existing task-linked design/PR/report, using a
compact table when useful. Preserve observed evidence separately from the
interpretation and any accepted exception. See [verification](verification.md).

**Ready for Build and Test:** the approach and acceptance criteria are accepted,
verification is feasible, blocking assumptions/alignment are resolved and required
reviewers are identified. Record material choices and unresolved limits. If the
outcome or scope changed, obtain the appropriate agreement rather than silently
rewriting the mission.

The next activity is implementation planning **inside Build and Test**: read
[delivery](delivery.md). Scale documentation to the change; neither a separate
planning phase nor another task is required.
