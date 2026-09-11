# Thermo-Nuclear Review Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/review this PR: <url>` apply an attributed Thermo-Nuclear maintainability review inline in the current Pi session.

**Architecture:** Package the review rubric as one discoverable Pi skill and expose `/review` through one prompt template that passes the complete user argument to that skill. Use Pi's existing package manifest; add no extension, helper script, or subagent workflow.

**Tech Stack:** Pi Agent Skills, Pi prompt templates, Markdown, Node.js test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-thermo-review-skill-design.md`

## Global Constraints

- Review inline in the current agent.
- Preserve Cursor's MIT attribution and pin the source URL and upstream revision.
- Add no subagents, custom PR-fetching workflow, helper script, extension, publication, edits, fix PRs, orientation phase, structural-solution synthesis, or general-correctness pipeline.

---

### Task 1: Specify package discovery and command behavior

**Files:**
- Modify: `tests/manifest.test.mjs`
- Modify: `tests/skill-behavior.ts`
- Create: `tests/skill-scenarios/thermo-nuclear-code-quality-review.md`
- Create: `tests/review-prompt.test.mjs`

**Interfaces:**
- Produces: package contract entries `pi.skills[]` and `pi.prompts[]`; `/review` prompt forwarding `$ARGUMENTS`; behavioral criteria for `thermo-nuclear-code-quality-review`.

- [ ] **Step 1: Add failing manifest and prompt tests**

Extend `expectedSkills` with `./skills/thermo-nuclear-code-quality-review`, add `expectedPrompts = ["./prompts/review.md"]`, and assert `pkg.pi.prompts`. Add a focused test that requires the prompt frontmatter to expose `/review`, preserve `$ARGUMENTS`, name `thermo-nuclear-code-quality-review`, and require inline execution without subagents.

- [ ] **Step 2: Add the failing behavior scenario**

Add `thermo-nuclear-code-quality-review` to `skillNames`. The scenario presents a correct, passing change that crosses 1,000 lines, adds option flags, casts, shared-router branches, and a pass-through wrapper. Require structural simplification, branching/abstraction, type-boundary, and oversized-file observations; forbid approval based only on passing tests and forbid subagent delegation.

- [ ] **Step 3: Verify RED**

Run:

```bash
node --test tests/manifest.test.mjs tests/review-prompt.test.mjs
```

Expected: FAIL because the manifest entries and prompt file do not exist.

Run the baseline behavior command from `npm run verify:skills` without loading the package. Expected: the new skill is not discovered, establishing the no-skill baseline.

### Task 2: Add the minimal skill and alias

**Files:**
- Create: `skills/thermo-nuclear-code-quality-review/SKILL.md`
- Create: `prompts/review.md`
- Modify: `package.json`
- Modify: `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: `$ARGUMENTS` from Pi prompt-template expansion.
- Produces: discoverable skill `thermo-nuclear-code-quality-review` and literal `/review` prompt command.

- [ ] **Step 1: Write the minimal Pi adaptation**

Use valid Agent Skills frontmatter and concise third-person discovery triggers. Preserve the upstream rubric's priorities: ambitious code-judo simplification, the under-1,000 to over-1,000 line presumptive blocker, spaghetti branching, direct code, explicit types and boundaries, canonical ownership, sequencing/atomicity, high-value findings, and the strict approval bar. Record the pinned upstream source and state that the review runs inline.

- [ ] **Step 2: Add the `/review` alias**

Create a prompt template with `argument-hint: "<PR-URL or review target>"`. Tell the current agent to apply `thermo-nuclear-code-quality-review` inline to `$ARGUMENTS`, inspect the target with available tools, and return the review in the current conversation without spawning a subagent.

- [ ] **Step 3: Register and attribute**

Add the skill and prompt paths to `package.json`, include both in `format:check`, and add Cursor's MIT notice and source URL to `THIRD_PARTY_NOTICES.md`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test tests/manifest.test.mjs tests/review-prompt.test.mjs
npm test
npm run typecheck
npm run format:check
npm run verify:portable
npm run licenses:check
```

If `PI_SKILL_TEST_MODEL` is configured, also run `npm run verify:skills`; otherwise report that behavioral model evaluation as skipped rather than claiming it passed.

- [ ] **Step 5: Commit**

Before committing, run `git diff --cached --name-only` and confirm only the approved spec, plan, skill, prompt, manifest, tests, and attribution are staged. Commit with a focused subject under 50 characters.
