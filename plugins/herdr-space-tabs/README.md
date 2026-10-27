# Herdr sidebar metadata

An optional Herdr 0.8.0+ integration for the expanded desktop sidebar:

- The Pi package's existing `project-status` extension publishes the current
  model, claimed task title, and context pressure for interactive Pi panes.
- This Herdr plugin publishes each space's tab count, active-task count, and
  optional active-tab label, including spaces with no agents. It requires
  Python 3.9+ on macOS/Linux.
- Space rows show no Git branch or ahead/behind information.

The pane publisher requires `HERDR_ENV=1`, a pane ID, a socket path, and Pi's
`tui` mode. RPC/JSON/print children do not write their parent's metadata.
It does not alter Herdr's managed Pi integration or lifecycle authority.
The plugin runs from Herdr events, with no daemon or database polling.

## Display semantics

The example layout shows Pi panes in three rows: state icon and bold task
title; project (the Herdr tab label) and space; then state text and model.
The pane/display-agent label is omitted so it does not repeat the task title.
Tab and space labels describe Herdr placement, not a separate catalog lookup.
A conditional fourth row shows
`pi_waiting` in warm amber while a session-local wakeup is waiting. The row disappears
when the token is absent, keeping existing task/model rows intact. Spaces show their state icon and name,
then `N tabs` and `M in-progress` on the next row. Sidebar context and active-tab
labels are omitted; their metadata remains available for custom layouts.

Context usage stays in Pi's footer. When Pi cannot yet estimate it after
compaction, the footer shows `Context ?` until fresh usage becomes available.

`pi_model` follows the actual selected model. `pi_task` shows the title of the
current session's matching active claim, including after inactivity. A successful
lookup with no claim shows `Unassigned`; lookup failures or conflicting claims
show `Task unavailable`. Legacy expiry timestamps do not end ownership.
Idle/working is independent of task assignment. Normalized labels are capped at 80 characters; the sidebar
may truncate further, and the task system retains the full title.

`pi_context_warning` appears at 75–<90% and `pi_context_critical` at >=90%, with
only one set at a time. The displayed percentage is floored. Unknown usage
(including immediately after compaction) and usage below 75% hide both. This
mirrors Pi's context estimate, not an exact token counter. Existing state
labels and subagent summaries remain separate.

`pi_waiting` is a presentation label such as `Waiting · until 15:05 UTC`, not a
new Herdr agent state. Herdr’s native dot remains unchanged. The wakeup extension
publishes it only for an idle interactive session with a pending check and no
human-input blocker or queued input. Active work, cancellation, reload, and
shutdown clear it. A multi-day alarm includes its local date; an overdue label
keeps the original due time. Passing the follow-up cutoff does not discard a
pending alarm. This is session-local waiting, not a persistent alarm or an
exact-time execution guarantee. The label updates on lifecycle transitions,
not a countdown polling loop.

The sidebar change is opt-in: merge the `$pi_waiting` row from the example into
your existing Pi rows, preserving other styles and labels. No Herdr binary or
managed agent-state integration changes are required. Waiting-only updates do
not query Beads or refresh space task counts.

The space plugin owns `active_tab` (`tab: <label>`), `tab_count`
(`1 tab` / `N tabs`), and `active_tasks` (`M in-progress`). Task counts use
structured `pi_task_state` and `pi_task_id` pane fields, never task-title text.
They count distinct active claims owned by Pi sessions present in that space,
including idle sessions, without a deadline. Multiple panes showing the same
claimed task count once. These are space-local counts, not the header's
workstream-wide counts. Confirmed unassigned panes contribute zero. The publisher
clears the obsolete `pi_task_expires_at` token; the counter does not use it.

Missing or invalid ownership evidence on any Pi pane produces `tasks unavailable`
for that space rather than a misleading zero or partial total. This includes a
legacy `expired` report, which no longer proves that the task is unassigned. Existing Pi
sessions need `/reload` at an idle boundary to publish these fields. Non-Pi panes
do not count. Missing or inconsistent active-tab evidence clears its label rather
than guessing. Existing state icons remain visible.

## Resizing the sidebar

Herdr already supports resizing the expanded desktop sidebar: drag its
right-hand divider horizontally. This changes both the spaces and agents
sections, not just the agents list. The client remembers the dragged width;
double-click the divider to return to `[ui].sidebar_width`. Mouse capture must
be enabled for dragging.

The example raises `[ui].sidebar_max_width` to 100 columns while leaving the
initial width and minimum unchanged. Merge that key into your existing `[ui]`
section rather than adding a second table. Choose a smaller maximum if needed;
long titles still truncate to the available width. This configuration was
validated with Herdr 0.9.5; custom rows are for the expanded desktop sidebar.

## Explicit activation

Package installation does not install or enable this Herdr plugin. Review the
code and use a durable checkout of the approved commit, not an ephemeral
worktree. Loading this Pi package in Herdr does enable pane metadata reporting;
those fields are invisible until included in the row configuration.

1. Back up `~/.config/herdr/config.toml` (or the explicit `HERDR_CONFIG_PATH`).
2. Merge the blocks from [`sidebar.example.toml`](sidebar.example.toml) into
   the existing config. Preserve existing theme, token styling, initial sidebar
   width, spacing, and other agent overrides. The example changes the maximum
   width, not the initial width. Do not append duplicate TOML tables.
3. Validate the merged candidate with `herdr config check` before reloading.
4. Link the reviewed plugin:

   ```sh
   herdr plugin link /absolute/durable/pi-config/plugins/herdr-space-tabs
   herdr plugin action invoke jp.space-tabs.refresh
   herdr server reload-config
   ```

5. At a safe idle boundary, use `/reload` in each interactive Pi session that
   should load the new package code. Do not send commands to busy agents.

The initial refresh is explicit: Herdr 0.8.0 startup hooks run after server
startup/restore, not when a plugin is linked, enabled, or config is reloaded.
There is no reason to stop the live server. Verify the installed plugin and
read metadata with `herdr plugin list --json`, `herdr workspace list`, and
`herdr pane get <pane-id>`.

## Failures and freshness

Each pane-side Herdr command has a 1500ms timeout and an output bound, with no
automatic retry loop. After an ownership metadata write succeeds, the publisher
checks whether `jp.space-tabs` is installed/enabled and invokes its existing
refresh action. Model/context-only writes do not invoke it. This is event-driven,
not database polling, and does not rely on metadata-change hooks. Publication
remains asynchronous and coalesced; the optional plugin is not required for
pane metadata. The next meaningful Pi
event can retry a failed delivery. Shutdown attempts to clear only owned keys;
forced termination cannot guarantee cleanup. Startup reconstructs values.

Task display queries have a 1500ms process timeout. The prompt-start display
refresh is asynchronous and cannot hold up the model while Beads is slow.
Task operations re-read actual ownership rather than assume a requested claim
or close succeeded. Space counts reuse this evidence without querying Beads again.
Pane create/move/close/exit/detection/status events and the existing tab events
also refresh space counts. Action acknowledgment means the bounded refresh was
queued; completion/failure is visible in the plugin log. External task mutations appear at the next interaction or
refresh. Legacy expiry timestamps do not schedule refreshes or clear a durable
assignment. Display refreshes do not change task ownership.

Space refreshes serialize before reading the authoritative snapshot. Each
Herdr call is bounded to two seconds, the locked refresh to ten seconds, and
lock acquisition to eleven seconds. A pending event therefore survives a
successful holder's maximum refresh budget and reads a fresh snapshot. A failed/invalid snapshot makes no writes.
A space closed after the snapshot does not prevent updating the others.
Timeouts/errors appear in Herdr's plugin log; after correcting the cause, invoke
`jp.space-tabs.refresh` or let the next tab event refresh. There is no indefinite
lock wait, arbitrary first-tab fallback, or metadata-event feedback loop.

This integration targets Herdr 0.8's server-scoped active tab. It does not
promise different per-client labels on newer multi-client Herdr versions.
Custom rows are not used by collapsed/mobile views.

## Rollback

Restore the backed-up row configuration and run `herdr server reload-config`.
Disable or unlink only this plugin:

```sh
herdr plugin disable jp.space-tabs
# Or, to remove its registration:
herdr plugin unlink jp.space-tabs
```

Disabling the plugin stops updates; its last display-only tokens may remain
until cleared or the server restarts, but removing the rows hides them. To
roll back pane reporting as well, restore the previous approved Pi package
revision and `/reload` affected sessions at safe idle boundaries. Do not stop
Herdr or change lifecycle integrations. Do not delete the linked checkout
while the plugin is enabled.

## Verification

From the repository root:

```sh
npm run test:file -- 'extensions/project-status/*.test.ts'
python3 -B -m unittest discover -s plugins/herdr-space-tabs -p 'test_*.py'
npm run typecheck
```

`npm test` includes the Python tests. Process tests use temporary, test-owned
executables/state and never contact a live Herdr server. The community
[`herdr-space-tab-metadata`](https://github.com/szrenwei/herdr-space-tab-metadata)
was a behavioral reference; this plugin uses its own bounded implementation.
