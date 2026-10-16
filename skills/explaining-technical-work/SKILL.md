---
name: explaining-technical-work
description: Use when explaining unfamiliar code changes, review findings, investigation results, architecture, or technical tradeoffs, especially when the reader asks for simpler terms or lacks the inspected code's context.
---

# Explaining Technical Work

Explain to a technically competent engineer who has not read the code you just
inspected. Give them a usable picture of the behavior before mapping it to
implementation names.

## Build the picture

Start with the purpose or consequence that makes the explanation worth reading.
Identify the actors and what they need. Describe what information moves between
them, where behavior differs, and why that difference matters.

Choose the comparison that fits the question:

| Question                 | Useful order                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Change or review finding | Purpose → previous behavior → changed/proposed behavior → consequence                          |
| Investigation            | Expected behavior → observed behavior → divergence and uncertainty → next discriminating check |
| Architecture or tradeoff | Goal → flow → options and practical differences → recommendation                               |
| Routine progress         | Result → remaining obstacle → next action                                                      |

Use ordinary descriptions for local terms: “loads the associated examples”
before “hydrates the records.” Then introduce functions, files, and line references
as evidence or as names for roles the reader now understands.

A concrete example or small in-chat diagram, including a fenced `mermaid` block,
is useful when the reader would otherwise have to reconstruct a flow, branch, or
before/after relationship. This is a way to clarify the answer, not a requirement
for five headings or a diagram in every response.

## Example

The caller needs a total, not the individual records or their examples.

```text
Before: fetch eligible records + examples → count the returned records
After:  apply the same eligibility filter → return the total directly
```

The new path avoids loading details the caller does not use. The correctness
question is whether both paths count the same eligible records. Reduced work is
expected; a speedup is not measured merely because the implementation changed.

Only after that picture explain which endpoint and filtering helper own the two
paths, with links when relevant.

## Keep it precise and proportionate

Preserve conditions, scope, tradeoffs, and uncertainty that change the decision.
Distinguish observed behavior from a hypothesis or proposed fix. If the previous
behavior is unknown, say so rather than inventing a story to fill the comparison.

For an exact fact, a terse status, or an explicit code-only request, answer
directly. For a substantial explanation, give enough context to understand the
consequence, then the technical depth the question needs. Neither a wall of
symbols nor a beginner tutorial respects the reader's time.
