---
name: thermo-nuclear-code-quality-review
description: Use when reviewing a pull request or code change for an intentionally strict maintainability audit, especially requests for a thermo-nuclear review, deep code-quality audit, structural simplification, abstraction quality, oversized files, or spaghetti-condition growth.
---

# Thermo-Nuclear Code Quality Review

Apply this rubric inline in the current session. Correct behavior is necessary but not sufficient: judge whether the change leaves the codebase structurally better.

Adapted from Cursor's MIT-licensed skill at `cursor/plugins`, pinned to revision `6e3d2ea`:
https://github.com/cursor/plugins/blob/6e3d2ea/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md

## Core standard

Look for **code judo**: a careful reframing that preserves behavior while deleting concepts, branches, modes, helpers, or layers. Prefer removing complexity over rearranging or polishing it. Recommend a restructuring only when there is a credible simpler design.

## Review dimensions

- **Structural simplification:** Ask whether a better model or ownership boundary would make the change substantially smaller and more obvious. Flag refactors that move complexity without reducing what readers must understand.
- **File growth:** Treat a change that moves a file from below **1,000 lines** to above **1,000 lines** as a presumptive blocker. Prefer cohesive modules, helpers, or components. Waive this only for a strong structural reason.
- **Branching and state:** Flag ad-hoc conditionals, scattered feature checks, one-off booleans, nullable modes, and edge cases inserted into shared flows. Prefer a state model, typed dispatcher, policy, or dedicated abstraction that removes branches rather than hiding them.
- **Directness:** Prefer direct, boring code over clever machinery. Flag thin wrappers, identity abstractions, pass-through helpers, and generic mechanisms that add indirection without clarifying the API or deleting complexity.
- **Types and boundaries:** Challenge unnecessary optionality, `any`, `unknown`, cast-heavy contracts, silent fallbacks, and vague object shapes. Prefer explicit invariants and typed models.
- **Canonical ownership:** Keep feature logic in the package, service, module, or layer that owns it. Reuse canonical helpers instead of creating near-duplicates.
- **Orchestration:** Flag unnecessary sequencing when independent work is clearer in parallel. Prefer atomic related updates when partial state would be hard to reason about.

## Findings

Prioritize structural regressions, missed code-judo simplifications, spaghetti or branching growth, boundary and type-contract problems, then file-size and general maintainability concerns.

Return a short list of high-conviction findings rather than cosmetic nits. Ground each finding in changed code with a path and line when available. Explain the maintainability cost and name the smallest credible structural direction. Be direct, demanding, and not rude.

## Approval bar

Do not approve merely because behavior is correct or tests pass. Approval requires:

- no clear structural regression or credible missed dramatic simplification;
- no unjustified file-size explosion;
- no obvious spaghetti growth from special-case branching;
- no hacky abstraction, unnecessary wrapper, or cast/optionality churn that obscures the design;
- no ownership leak, avoidable canonical-helper duplication, or missed obvious decomposition.

If the bar is not met, say so explicitly and give actionable structural feedback.
