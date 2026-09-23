# Runtime Status Input Footer Design

**Date:** 2026-09-23

**Task:** `jp-yatk` — Move runtime status into input footer

## Goal

Keep the project and current session-owned task readable in the top status row on narrow terminals by moving runtime telemetry into a distinct, full-width footer row owned and rendered by the styled editor.

## Current Behavior

`extensions/project-status/index.ts` renders one widget containing:

- left: project plus the current session-owned Active task, or aggregate task counts;
- right: model, thinking effort, context percentage, and free disk.

When the terminal is narrow, the right side wins and the task identity is truncated or removed.

`extensions/styled-editor/index.ts` already implements the desired visual foundation. Its `PromptEditor` is adapted directly from Tahir Butt's private `tb-pi` implementation and uses Pi's supported `setEditorComponent()` API to render:

- a `borderAccent` rail;
- `userMessageBg` across the full prompt body;
- repaired background ANSI after Pi's fake cursor resets;
- autocomplete outside the colored prompt block;
- one uncolored spacer row after the editor.

The extension also installs an empty custom footer to suppress Pi's built-in footer.

## User-Approved Visual Contract

The top widget contains only project/task information:

```text
pi-setup │ jp-yatk • Move runtime status into input footer
```

Runtime telemetry becomes a right-aligned final row inside the existing Tahir-derived prompt block:

```text
█                                        
█ Type your message                      
█                                        
█     Opus 4.6 • HIGH • 44% (440k/1M) • ⛁ 200G

```

The telemetry row has these visual rules:

- the cyan `borderAccent` rail continues through the row;
- `customMessageBg` spans the entire row after the rail;
- telemetry is pinned to the right edge with one cell of right padding;
- input rows retain `userMessageBg`;
- the full-width background change distinguishes editor chrome from editable text;
- the existing uncolored spacer remains after the complete editor.

The content rules are:

- model name is shortened as today, for example `Opus 4.6`;
- thinking effort is uppercase, for example `HIGH` or `XHIGH`;
- context shows percentage and compact used/window tokens, for example `44% (440k/1M)`;
- disk omits the word `disk` and uses the one-column Unicode database glyph, for example `⛁ 200G`;
- disk read failure renders `⛁ ?`.

`⛁` is intentionally preferred over emoji icons because `pi-tui` measures it as one terminal column; the tested emoji alternatives measure as two.

## Architecture

### Project status becomes project/task-only

`extensions/project-status/index.ts` continues to own:

- Beads queries and session-task selection;
- project and session-name resolution;
- top project/task rendering.

It no longer imports filesystem APIs, polls disk, reads model/context/thinking state, or accepts disk dependencies. Its widget spends all available width on project/task identity or aggregate task counts.

### Styled editor owns runtime state and rendering

`extensions/styled-editor/index.ts` owns:

- model display name selection and sanitization;
- thinking effort formatting;
- context usage and context-window formatting;
- disk polling, formatting, and warning thresholds;
- responsive telemetry layout;
- the full-width footer background and final row placement.

This keeps data ownership with the UI surface that presents it and removes the need for a shared status key or cross-extension transport.

The extension maintains current runtime state in its session-scoped closure. `PromptEditor` receives a callback that builds the latest runtime segments. During `render(width)`, it inserts the status row:

- after the existing padded prompt rows;
- before autocomplete rows;
- before the existing uncolored trailing spacer.

Autocomplete remains outside both `userMessageBg` and `customMessageBg`.

The editor and custom-footer factories expose a supported TUI `requestRender()` callback to disk polling. No terminal cursor manipulation or unsupported private Pi state is introduced.

When `/prompt off` disables the custom editor, the custom footer renders a plain, width-bounded runtime row so the status does not disappear. Re-enabling the prompt returns it to the colored editor footer.

## Runtime Formatting

### Model and effort

The model name uses `ctx.model.name`, then `ctx.model.id`, then omission. It removes the leading `Claude ` and the ` (AI Gateway...)` suffix after sanitization.

Thinking effort is omitted when empty or `off`; otherwise it is sanitized and uppercased.

### Context

Context data comes from `ctx.getContextUsage()` with `ctx.model.contextWindow` as the window fallback.

The percent uses `usage.percent` when provided, otherwise `usage.tokens / contextWindow`. The rounded percent retains existing colors:

- `> 90%`: error;
- `> 70%`: warning;
- otherwise: normal footer text.

When both used tokens and a context window are available, context renders:

```text
44% (440k/1M)
```

When token detail is unavailable, it degrades to the percentage only. Compact token formatting follows Pi's thresholds but removes redundant `.0` suffixes:

- `999`;
- `1.2k`;
- `440k`;
- `1M`;
- `1.5M`.

### Disk

Disk polling retains the existing behavior:

- path: the current user's home directory;
- interval: 60 seconds;
- normal at `>= 150 GiB`;
- warning from `80 GiB` through `< 150 GiB`;
- error below `80 GiB`;
- failure state: `⛁ ?`.

The visible value is `⛁ ` plus the existing one-decimal GiB formatting.

## Width Behavior

The top widget uses ANSI-aware `truncateToWidth(...)` on project/task content only.

The status row always spans the editor body width with `customMessageBg`. Its content is right-sticky:

- all fields render when they fit;
- the row grows leftward as content grows;
- on overflow, leading fields are omitted before trailing health fields;
- an ellipsis marks omitted leading content;
- context and disk are retained ahead of model identity at extreme widths;
- every rendered line remains within the terminal width from zero upward.

The task identity and telemetry are independent. A dense or hostile runtime value cannot consume header width.

## Trust Boundary

Model and effort values are treated as untrusted display data before theme styling:

- terminal control sequences are removed;
- line breaks, tabs, and remaining control characters become spaces;
- repeated whitespace is collapsed.

Context and disk values are locally generated numbers. All width calculations use `pi-tui` visible-width helpers rather than JavaScript string length.

## Lifecycle and Refresh

`project-status` retains its task refresh triggers:

- `session_start`;
- `session_info_changed`;
- `turn_end`.

Its existing generation checks continue preventing stale async task queries from mutating a replacement session.

`styled-editor` owns runtime refresh:

- `session_start` installs the footer/editor, captures the current context, reads disk, and starts polling in TUI mode;
- `model_select` and `thinking_level_select` update the current context and reinstall the editor as today;
- `turn_end` updates the current context and requests a render for changed usage;
- the disk timer reads free space every 60 seconds and requests a render;
- `session_shutdown` invalidates the session generation, stops polling, and clears runtime state.

A captured generation prevents a stale disk read from updating a replacement session.

## Testing

Focused tests cover:

- the session task remains in the top widget while runtime fields are absent;
- the task remains visible at narrow widths;
- project-status no longer polls disk or reacts to model/thinking events;
- hostile model text cannot inject terminal controls or new rows;
- effort is uppercase;
- context renders percent plus compact used/window tokens and degrades when detail is missing;
- disk threshold colors, icon, free-space format, and failure state remain unchanged except for approved copy;
- stale disk reads and shutdown cannot update a replacement session;
- the styled editor renders a full-width `customMessageBg` final row with right-sticky telemetry;
- leading fields are omitted before context/disk at narrow widths;
- telemetry remains before autocomplete and autocomplete remains uncolored;
- `/prompt off` preserves telemetry in the plain custom footer;
- no runtime data preserves the existing Tahir-derived prompt rendering.

Repository verification includes focused tests, the complete test suite, typecheck, formatting, portability, licenses, and Pi smoke validation.

## Non-Goals

- Replacing Pi's global footer with a general-purpose status bar.
- Rendering arbitrary extension statuses inside the prompt.
- Changing task lifecycle ownership, query count, or readiness classification.
- Changing disk polling frequency or thresholds.
- Adding a new theme schema key; the footer uses existing `customMessageBg` and `customMessageText` semantics.
- Reproducing private `tb-pi` code beyond the already-adapted renderer in this repository.
