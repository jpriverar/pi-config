# Thermo-Nuclear Review Skill Design

## Goal

Let JP enter `/review this PR: <url>` and have the current Pi agent review that pull request using Cursor's Thermo-Nuclear Code Quality Review guidance.

## Design

Vendor an attributed, pinned adaptation of Cursor's `thermo-nuclear-code-quality-review` skill as `skills/thermo-nuclear-code-quality-review/SKILL.md`. Keep the maintainability rubric intact while translating only harness-specific wording needed for Pi.

Add `prompts/review.md` as a literal `/review` alias. The template passes the user's complete argument text to the current agent and tells it to apply the Thermo-Nuclear skill inline. Pi's normal tools and judgment handle access to the referenced pull request.

Register both paths in the package manifest. Preserve the upstream MIT attribution in `THIRD_PARTY_NOTICES.md`.

## Non-goals

- No subagents or parallel reviewers.
- No custom PR-fetching workflow or helper script.
- No custom extension, tool, or UI.
- No automatic GitHub comments, approvals, edits, or fix pull requests.
- No additional orientation, solution-synthesis, or general-correctness phases.

## Verification

- Manifest tests prove Pi exports the skill and prompt.
- A behavior evaluation first demonstrates that `/review` guidance is absent without the package, then verifies that the packaged prompt selects and applies the Thermo-Nuclear rubric inline.
- Package tests, type checking, formatting, portability, and license checks pass.
