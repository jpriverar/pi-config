# Workflow Prompt Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote plan/spec and Beads lifecycle invocation triggers into Pi's system-prompt tool metadata while reducing duplicate parent policy.

**Architecture:** The public `pi-config` package owns exact tool descriptions, snippets, and guidelines. The work profile in `DataDog/experimental` owns parent-only governance. Existing dynamic plan state remains unchanged.

**Tech Stack:** TypeScript, Pi Extension API, Node test runner, Python unittest, Markdown.

**Spec:** `docs/superpowers/specs/2026-08-27-workflow-prompt-guidance.md`

## Global Constraints

- Keep instructions concise and name each tool explicitly.
- Preserve approval and verification safety boundaries.
- Do not add session focus, response parsing, automatic issue creation, persistent reminders, or `AGENTS.md` changes.
- Do not modify the active-plan `before_agent_start` hook.

---

### Task 1: Plan and spec prompt metadata

**Files:**
- Modify: `extensions/plan-progress/index.test.ts`
- Modify: `extensions/plan-progress/index.ts`

**Interfaces:**
- Consumes: Pi `registerTool()` fields `description`, `promptSnippet`, and `promptGuidelines`.
- Produces: exact `set_plan` and `set_spec` metadata from the specification.

- [ ] Add a test that records full tool definitions and asserts exact metadata for `set_plan` and `set_spec`.
- [ ] Run `npm run test:file -- extensions/plan-progress/index.test.ts` and verify the new assertion fails because snippets/guidelines are absent.
- [ ] Add exact snippets/guidelines and shorten descriptions; leave `complete_step` and the active-plan hook unchanged.
- [ ] Rerun the focused test and verify it passes.

### Task 2: Beads lifecycle prompt metadata

**Files:**
- Modify: `extensions/jp-workflow/index.test.ts`
- Modify: `extensions/jp-workflow/index.ts`

**Interfaces:**
- Consumes: Pi `registerTool()` fields `description`, `promptSnippet`, and `promptGuidelines`.
- Produces: exact `file_issue`, `update_issue`, and `close_issue` metadata from the specification.

- [ ] Extend the test harness tool type and assert exact metadata for all three lifecycle tools.
- [ ] Run `npm run test:file -- extensions/jp-workflow/index.test.ts` and verify the new assertions fail because snippets/guidelines are absent.
- [ ] Add exact snippets/guidelines and shorten descriptions without changing execution behavior.
- [ ] Rerun the focused test and verify it passes.

### Task 3: Parent policy deduplication

**Files in `DataDog/experimental` worktree:**
- Modify: `users/jp.riveraruiz/pi-config/tests/baseline_agent_config_test.py`
- Modify: `users/jp.riveraruiz/pi-config/agent/PARENT.md`

**Interfaces:**
- Consumes: tool invocation rules from Tasks 1 and 2.
- Produces: tool-independent parent governance from the specification.

- [ ] Update baseline assertions to require the unfinished-follow-up classification and approval boundary, and forbid tool names/invocation mechanics in `PARENT.md`.
- [ ] Run `python3 -m unittest tests/baseline_agent_config_test.py` and verify it fails against the old policy.
- [ ] Replace duplicated claim/update/close mechanics with the exact four governance rules in the specification.
- [ ] Rerun the baseline test and verify it passes.

### Task 4: Verification and review

**Files:**
- Verify all changed files in both worktrees.

**Interfaces:**
- Consumes: completed changes from Tasks 1–3.
- Produces: evidence suitable for integration decisions.

- [ ] Run public focused tests for both extensions.
- [ ] Run public `npm test`, `npm run typecheck`, and `npm run format:check`.
- [ ] Run work-profile Python tests and `bun test tests/core-package.test.ts`.
- [ ] Confirm `AGENTS.md` and the active-plan hook are unchanged.
- [ ] Run `git diff --check` in both repositories.
- [ ] Request independent review of the two diffs and address Important/Critical findings.
