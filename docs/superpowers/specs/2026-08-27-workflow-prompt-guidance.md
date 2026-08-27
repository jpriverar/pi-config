# Workflow Prompt Guidance Specification

## Goal

Make plan/spec and Beads lifecycle tool invocation more salient without restoring broad orchestration policy or adding dynamic work-focus state.

## Design

Pi renders each active tool's `promptSnippet` in the default system prompt's **Available tools** section and each `promptGuidelines` entry in its **Guidelines** section. Tool-owned invocation triggers belong there. Parent policy retains only tool-independent governance and authority boundaries. Dynamic active-plan behavior remains in the existing `before_agent_start` hook.

## Tool metadata

### `set_plan`

- Description: `Register an active plan and display its live progress widget.`
- Snippet: `Register implementation plans and show live progress`
- Guideline: `Use set_plan after committing to a numbered implementation plan for substantial multi-step work; skip it for quick answers and bounded checks.`

### `set_spec`

- Description: `Store a durable design or specification for side-panel display.`
- Snippet: `Store durable designs or specifications for side-panel access`
- Guideline: `Use set_spec when a design or specification becomes the durable reference for later implementation; skip scratch analysis.`

### `file_issue`

- Description: `Create an explicitly approved work item in the Beads store.`
- Snippet: `Create an approved Beads work item`
- Guideline: `Use file_issue only after the user explicitly approves creating the work item; never turn optional ideas into tracked commitments.`

### `update_issue`

- Description: `Change the status, labels, or notes of an existing Beads work item.`
- Snippet: `Claim or update an existing Beads work item`
- Guideline: `Use update_issue to claim an approved item when substantial work starts, record meaningful phase changes, and mark blockers or deferrals.`

### `close_issue`

- Description: `Close a genuinely completed and verified Beads work item with a reason.`
- Snippet: `Close a completed and verified Beads work item`
- Guideline: `Use close_issue only after the work item is genuinely complete and verified.`

## Parent policy

The parent policy keeps these tool-independent rules:

- Substantial exploration, design, or implementation requires one existing item naming the goal; otherwise propose one and wait for approval. Quick answers, status checks, and bounded read-only checks remain exempt.
- Exploration, design, implementation, and verification remain phases of one item unless independently deliverable; do not create process-only tasks.
- Before recommending substantial unfinished follow-up, classify it as part of the current item, a distinct proposed item awaiting approval, or an explicitly optional idea.
- Do not create tracked obligations without JP's approval.

Tool invocation mechanics such as claiming, updating, blocking, deferring, and closing move out of `PARENT.md` and into the owning tools' guidelines.

## Non-goals

- No session-bound work-item focus.
- No automatic issue creation or response parsing.
- No changes to active-plan state, `complete_step`, or its reminder hook.
- No changes to `AGENTS.md`.
- No new persistent context messages.

## Verification

- Focused tests assert exact descriptions, snippets, and guidelines for all five tools.
- Work-profile baseline tests assert the revised parent policy and absence of tool-specific invocation wording.
- Public package full test, typecheck, and format checks pass.
- Work-profile tests pass and `AGENTS.md` remains byte-for-byte unchanged.
