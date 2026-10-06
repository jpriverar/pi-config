# Herdr sidebar metadata

An optional Herdr 0.8.0+ integration for the expanded desktop sidebar:

- The Pi package's existing `project-status` extension publishes the current
  model, claimed task title, and context pressure for interactive Pi panes.
- This Herdr plugin publishes each space's active tab and total tab count,
  including spaces with no agents. It requires Python 3.9+ on macOS/Linux.
- Space rows show no Git branch or ahead/behind information.

The pane publisher requires `HERDR_ENV=1`, a pane ID, a socket path, and Pi's
`tui` mode. RPC/JSON/print children do not write their parent's metadata.
It does not alter Herdr's managed Pi integration or lifecycle authority.
The plugin runs from Herdr events, with no daemon or database polling.

## Display semantics

`pi_model` follows the actual selected model. `pi_task` shows a matching active,
unexpired session claim's title. A successful lookup with no claim shows
`Unassigned`; lookup failures/conflicting claims show `Task unavailable`, and
an expired matching lease shows `Lease expired`. Idle/working is independent
of task assignment. Normalized labels are capped at 80 characters; the sidebar
may truncate further, and the task system retains the full title.

`pi_context_warning` appears at 75–<90% and `pi_context_critical` at >=90%, with
only one set at a time. The displayed percentage is floored. Unknown usage
(including immediately after compaction) and usage below 75% hide both. This
mirrors Pi's context estimate, not an exact token counter. Existing state
labels and subagent summaries remain separate.

The space plugin owns `active_tab` (`tab: <label>`) and `tab_count`
(`1 tab` / `N tabs`). Missing or inconsistent active-tab evidence clears its
label rather than guessing. Existing state icons remain visible.

## Explicit activation

Package installation does not install or enable this Herdr plugin. Review the
code and use a durable checkout of the approved commit, not an ephemeral
worktree. Loading this Pi package in Herdr does enable pane metadata reporting;
those fields are invisible until included in the row configuration.

1. Back up `~/.config/herdr/config.toml` (or the explicit `HERDR_CONFIG_PATH`).
2. Merge the blocks from [`sidebar.example.toml`](sidebar.example.toml) into
   the existing config. Preserve existing theme, token styling, sidebar width,
   spacing, and other agent overrides. Do not append duplicate TOML tables.
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

Pane metadata commands have a 1500ms timeout, an output bound, and no automatic
retry loop. Publication is asynchronous and coalesced. The next meaningful Pi
event can retry a failed delivery. Shutdown attempts to clear only owned keys;
forced termination cannot guarantee cleanup. Startup reconstructs values.

Task display queries have a 1500ms process timeout. The prompt-start display
refresh is asynchronous and cannot hold up the model while Beads is slow.
Task operations re-read actual ownership rather than assume a requested claim
or close succeeded. External task mutations appear at the next interaction or
refresh. A known lease expiry triggers one authoritative re-read. Display
refreshes do not renew leases.

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
