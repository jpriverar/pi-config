# Task-aware Herdr sidebar metadata

Work item: `jp-u1aq`

Status: conversational design approved; written spec awaiting review. Implementation is not authorized yet.

## Intent and approved scope

Make Herdr's expanded sidebar explain which model each interactive Pi agent uses, what claimed task it owns, when its context is under pressure, and which tabs each space contains.

Four features are in scope:

1. Current model beside the Pi agent label.
2. Total tab count and active tab label in each space.
3. Context percentage only when usage is high.
4. The current session's claimed task title, or `Unassigned` when a successful lookup confirms no active claim.

**Spaces must not show Git branch or ahead/behind information.** This is the final scope refinement. Git state remains available elsewhere; this change only removes it from the space row layout.

The design targets the installed Herdr 0.8.0 APIs and the Pi extension APIs inspected during research. No Herdr upgrade or fork is required.

## Presentation

### Agent entries

Retain the existing location and semantic state information. Add a model token next to `agent`, a dedicated task-title row, and a conditional context row:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "tab", "workspace"],
  ["agent", "$pi_model", "state_text"],
  ["$pi_task"],
  ["$pi_context_warning", "$pi_context_critical"],
]
```

This is the logical layout; the eventual configuration edit preserves the existing theme and location-token styling. Other agent kinds keep their existing layout. Keep the existing sidebar width and spacing settings unless rendering verification identifies a problem requiring review.

- Use the active Pi model's compact display name, falling back to its ID. Follow the existing styled-editor convention for removing redundant branding, without inventing model aliases.
- Give the task title its own row rather than consuming its width with a task ID. Herdr normalizes and caps metadata values at 80 characters and may further truncate them to sidebar width. The task system remains the place to read the complete title.
- Retain `state_text`, including existing subagent work labels. The new reporter does not own or overwrite `$summary`, semantic state, or state labels.
- Put the warning and critical context tokens in the same conditional row. At most one is populated; when both are absent, Herdr hides the row.
- Apply fixed yellow and red token styles in local configuration. Threshold selection happens in the reporter, so conditional-style rules from newer Herdr versions are unnecessary.

### Space entries

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace", "$tab_count"],
  ["$active_tab"],
]
```

`tab_count` renders as `1 tab` or `N tabs`. `active_tab` renders as `tab: <label>`. Preserve the rolled-up state icon and current theme. Do not include `branch` or `git_status` anywhere in this layout.

Rich rows apply to Herdr's expanded desktop sidebar; collapsed/mobile layouts are not changed.

## Architecture and ownership

Use two narrow components in this repository, plus the local Herdr row configuration.

### 1. Pi pane metadata sink

Add a separately tested helper beside `extensions/project-status/index.ts` and connect it to that extension's existing session/task refresh path.

The project-status extension already reads normalized Beads issues and identifies a task by session ID. Derive a display-only assignment from the same successful issue read. Do not introduce another Beads reader, binding file, task database, general task event protocol, or task reconciliation loop. Do not change lifecycle enforcement or lease renewal semantics to support a display.

The helper owns only:

- `pi_model`
- `pi_task`
- `pi_context_warning`
- `pi_context_critical`

Use a stable source identifier such as `jp:pi-sidebar`. Publish with Herdr's display-only pane metadata API. Never use `report-agent` for these fields.

Enable pane publication only when Herdr context is present **and `ctx.mode === "tui"`**. RPC, JSON, and print-mode children may inherit Herdr variables but must never publish over the interactive parent's pane. `ctx.hasUI` alone is insufficient because RPC can report true.

Do not edit the Herdr-managed `herdr-agent-state.ts`: installation/update overwrites it, and it remains responsible for lifecycle authority. Do not alter the pi-subagents summary bridge.

### 2. Herdr space/tab metadata plugin

Add a small repository-owned plugin under `plugins/herdr-space-tabs/`. It runs from Herdr, not from every Pi process, so spaces without agents still update and multiple agents cannot compete to publish one space's navigation metadata.

Use the existing community tab-metadata plugin as a behavioral reference, not an automatic installation dependency. Its inspected implementation has unbounded subprocess/lock waits and guesses a first tab when active-tab evidence is missing; the owned implementation must instead bound execution and avoid guessing.

On startup and supported workspace/tab events, read Herdr's authoritative snapshot, derive tokens, and publish only changed values:

- `workspace.created`
- `tab.created`
- `tab.closed`
- `tab.focused`
- `tab.renamed`
- `tab.moved`

Use the space's reported `active_tab_id` and validate that the referenced tab belongs to that space. If active-tab evidence is absent or inconsistent, clear the label rather than select an arbitrary tab. Count all tabs belonging to the space, including non-agent tabs.

Serialize or coalesce overlapping refreshes with bounded waits. Take the snapshot within the serialized refresh so an old event cannot publish an old label after a newer one. Bound Herdr command execution, isolate closed-space races, and never treat malformed/error output as an empty successful snapshot.

No persistent daemon or polling loop is needed. Herdr 0.8 startup hooks do not run on link/enable/config reload, so activation must explicitly invoke one initial refresh after the plugin is linked and enabled.

## Data semantics and lifecycle

### Model

Read the active model on session startup, reload/resume, and `model_select`. Use the replacement session's context after session changes. If no model is known, clear the token rather than retain a previous session's model.

### Context

Use `ctx.getContextUsage()` and its current-model percentage. This is Pi's estimate based on provider usage and newer messages, not an independent exact-token counter.

- Finite percentage below 75: clear both indicators.
- Percentage at least 75 and below 90: set the warning token to `Context N%`, clear critical.
- Percentage at least 90: set critical, clear warning.
- Missing/unknown/non-finite usage: clear both.

Select severity from the unrounded percentage and display its floor as the whole percentage, so formatting cannot cross an undisplayed threshold. Refresh at session start, model selection, turn boundaries, successful compaction, and session-tree navigation. Do not parse transcripts or query on every streaming delta. Compaction may make usage unknown until the next response; never reuse pre-compaction pressure or display unknown as zero.

### Claimed task

Derive ownership from normalized lifecycle metadata and the current Pi session ID, not a task mentioned in a prompt, the project/workstream, or the session name.

- Exactly one active claim for this session with an unexpired lease: show its title.
- A successful authoritative lookup finds no active claim: `Unassigned`.
- Ownership cannot be read or is ambiguous: `Task unavailable`.
- One matching active record has an expired lease: `Lease expired`.

Multiple matching active records are ambiguous even if one appears preferable. Do not choose one by recency or title. Expiry is not proof that cleanup or release succeeded.

Refresh after task-changing tool execution using authoritative state, including failed/uncertain mutations where necessary; never optimistically apply a requested transition. Preserve the assignment when a failed close/release leaves the claim intact. Refresh on existing session interactions and before new work. Arm only a one-shot deadline for a known lease expiry, with session-generation guards; re-read before changing the display because activity may have renewed the lease. This display path never renews a lease.

External mutations are observed at the next refresh/interaction, not promised as a continuous live stream. No background database polling is introduced.

`Unassigned` means no active claim, not idle. A new/forked session must not inherit another session's ownership. Reload restores the current session's actual claim.

## Delivery, failures, and cleanup

- Keep publication asynchronous, serialized/coalesced, and bounded. A slow or unavailable Herdr server must not block model turns or task tools.
- Send values as structured arguments/JSON, never interpolate model names, titles, or tab labels into shell commands.
- Sanitize control sequences and bound metadata. Send only display fields, not prompts, task descriptions, credentials, or transcript contents.
- Use session-generation guards and ordered reporting to prevent old work or shutdown cleanup from overwriting a replacement session's values.
- Clear only owned keys on shutdown where possible. Startup always reconstructs owned values. Do not claim to recover cleanup after a process is forcibly killed; subsequent startup replaces values and a missing agent has no agent row.
- Unchanged data should not cause repeated writes. Failed writes remain eligible for the next meaningful refresh; do not create an unbounded retry loop.
- A failed task refresh must not turn into `Unassigned`. A failed Herdr write does not invalidate otherwise valid task ownership.
- Scope the space plugin's values to the active Herdr server. This design does not promise per-client active-tab metadata for newer multi-client Herdr behavior.

## Verification and activation

Focused tests must cover:

- Current model at startup; model switching; absent model; resume/reload; late previous-session work.
- Context thresholds just below/at 75 and 90, unknown after compaction, warning-to-critical replacement, and indicator clearing.
- Confirmed no claim, correct session ownership, another session's task, expired lease, conflicting claims, unavailable store, and failed claim/close/release.
- Headless-child isolation and preservation of lifecycle/summary reporting.
- Space tab creation, closure, focus, rename, movement, zero/one/many tabs, missing active-tab evidence, unchanged snapshots, command timeout, and overlapping refreshes.
- Configuration contains no branch/ahead-behind tokens in space rows and preserves other agent layouts and theme styling.

Before activation, run focused tests, repository type checking and relevant package/manifest checks. Validate the candidate configuration and use an isolated Herdr session for rendering and event-flow checks. Synthetic fixtures must not claim or mutate real tasks.

Activation is explicit: back up the local Herdr config, link the reviewed plugin, invoke its initial refresh, reload configuration, and reload the affected interactive Pi sessions. Do not stop the Herdr server or interrupt running agents. Provide rollback by restoring the backed-up row configuration and disabling/unlinking only this plugin and pane metadata integration.

## Non-goals

No PR/CI indicators, space descriptions, per-child headless-agent roster, new task authority, agent filtering, model routing, automatic compaction, Git operations, desktop notifications, Herdr upgrade, or general plugin framework. None is needed to deliver the four approved fields.

## Evidence used

- `extensions/project-status/index.ts`: existing normalized issue query, session-task projection, and refresh lifecycle.
- `extensions/styled-editor/index.ts`: model-label formatting and Pi context meter precedent.
- `docs/task-lifecycle.md`: task attachment, lease semantics, and mutation authority.
- Installed Pi extension documentation, `ContextUsage` type, and `model-status.ts` example.
- Herdr versioned 0.8.0 configuration, plugin, CLI, and socket API documentation.
- `szrenwei/herdr-space-tab-metadata`: inspected manifest, full reporter source, and test coverage inventory.
