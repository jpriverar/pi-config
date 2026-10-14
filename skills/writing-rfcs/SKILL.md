---
name: writing-rfcs
description: Use when drafting, revising, or formatting a brief technical RFC or request for comments, especially in Google Docs or from an existing team template.
---

# Writing Brief RFCs

An RFC supports a technical discussion; a polished draft is not an approved
implementation or release. Start from the problem, root cause, and agreed scope.
If the approach is still contested, discuss the choice or label alternatives as
proposals before presenting a settled design.

## Document contract

Use the user's native minimal RFC template. Find it through available document
search if no link was supplied; ask when competing templates remain ambiguous.
Read the template and any supplied example rather than assuming company-wide
conventions. For a new document, copy the native template when supported to
preserve layout, metadata, and styles; leave the original unchanged.

Default to five main sections, adapting or omitting sections when the template
or task calls for it:

| Section                   | Content                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Hypothesis             | Current behavior, concrete failure, and why the proposed change helps.                                                                         |
| 2. Scope                  | In scope, out of scope, blast radius, and sandboxing.                                                                                          |
| 3. Success criteria       | Observable proof, unchanged behavior, and what happens on success or failure. Separate evidence already obtained from validation still needed. |
| 4. Plan                   | **Data Model**, **Approach**, and **Rollout** subsections. State “None expected” for no model change; make rollout authorization explicit.     |
| 5. Trade-offs & tech debt | Separate **Accepted trade-offs** from **Resolve before shipping**. Unresolved correctness requirements are not accepted debt.                  |

Keep the problem and approach in short narrative paragraphs. Use bullets for
scope and criteria, nested bullets only for genuine hierarchy, restrained bold,
and inline supporting links. Link lengthy investigation separately. Tables and
images earn their space by clarifying a comparison or flow. Aim for a brief draft,
not a comprehensive implementation specification.

## Native formatting baseline

Follow an explicitly supplied template's styles. Otherwise use this baseline:

| Element       | Native style                                                                |
| ------------- | --------------------------------------------------------------------------- |
| Layout        | Pageless                                                                    |
| Body          | Arial, 11 pt, 115% line spacing                                             |
| Title         | Heading 1, 20 pt                                                            |
| Main sections | Heading 2, 16 pt                                                            |
| Subsections   | Heading 3, 14 pt                                                            |
| Metadata      | Compact author/reviewer/status/date block; known work-item link if relevant |

Keep status **Draft** and reviewers **TBD** when unknown. Preserve existing native
person, status, and date chips; plain-text labels are not chips.

## Safe edits and handoff

For formatting-only work, preserve the canonical URL, technical meaning, comments,
and open decisions. Inspect current content and supported operations before
writing. If safe editing, copying, layout changes, or chips are unsupported, state
the limitation and the manual step; do not replace the canonical document.

Read back both content and native formatting after writes. Check heading levels,
body typography, metadata, links, and list boundaries: inserted paragraphs can
inherit heading styles, and newline deletion can pull headings into lists.
Markdown alone does not prove native styling or pageless layout. Report the
canonical link, verified changes, and remaining limitations—not an assumed
implementation, rollout, sharing change, or reviewer notification.
