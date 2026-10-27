# JP's Pi Config

JP's personal Pi configuration, published for discovery and exploration. This
project is experimental and unsupported; it is not a stable product or a
supported distribution.

## Personal macOS bootstrap

Homebrew is the only prerequisite.

```sh
set -euo pipefail
git clone https://github.com/jpriverar/pi-config.git
cd pi-config
./scripts/bootstrap-macos.sh
```

Any clone path is valid; whichever checkout you bootstrap becomes the local
package source that Pi loads.

The script installs and owns Node.js 22.19.0 via Volta, Pi 1.2.0, this
checkout as the local Pi package source, five public npm package sources, and
upstream Superpowers:

- `npm:pi-mcp-adapter@2.26.0`
- `npm:pi-subagents@0.50.0`
- `npm:context-mode@1.0.169`
- `npm:pi-markdown-preview@0.14.1`
- `npm:@juicesharp/rpiv-ask-user-question@2.6.1`
- `git:github.com/obra/superpowers`

It reconciles reviewed settings in `$HOME/.pi/agent`, including the
`gold-rush` theme, manages one marker-delimited shell block for `VOLTA_HOME`,
`PATH`, and `BEADS_DIR`, and uses an independent personal Beads store at
`$HOME/beads/.beads`.
It initializes only an empty personal Beads store with prefix `jp` and
configures no remote.

Provider setup stays personal and interactive through `/login`.
Rerunning `./scripts/bootstrap-macos.sh` is safe: a successful second run leaves
the managed configuration byte-identical. If existing managed state conflicts
with the reviewed personal-only boundaries, the bootstrap refuses the conflict
instead of guessing.

Update by running `git pull --ff-only` in the same checkout, then `/reload`
inside Pi. To roll back, check out an earlier repository commit in the same
checkout and run `/reload` again.

Pi's generated npm workspace currently records caret dependency ranges even
when settings contain versioned sources. The bootstrap verifies the final
resolved package versions after Pi finishes package operations.

It excludes work configuration, copied history, credentials, providers, MCP
setup, and Beads remotes.

## Task data and model context

Task data is read from `BEADS_DIR`. When it is unset, the package uses
`$HOME/beads/.beads`. Create and manage that store with `bd`; task state is not
included in this package.

Before model turns, the `task-lifecycle` extension sends scoped task IDs,
titles, explicit Active/Actionable/Waiting state, dependency authority, and
compact lifecycle warnings from the Beads store to the configured model as
hidden context. A separate block adds the existing description and current
`next_step` only for the uniquely owned active task. With an active catalog,
selection changes the view, not ownership: outside-view owned context remains
available with a warning. Without an active catalog, legacy project matching
applies. It never chooses a mission by title or borrows another session's task.

The owned-context block is capped at 8000 characters; oversized content is
omitted with retrieval guidance rather than presenting a partial mission.
Compaction refreshes context without starting a turn. A successful claim adds
context after the current tool batch even when a codemode script filters out
the claim result; this does not preempt other operations already in that batch.
Context refresh failure does not undo or misreport a successful claim. Values
are untrusted data, not instructions or approval, but are disclosed to the
configured model. Only store task data appropriate to share with that model.

See [Task lifecycle](docs/task-lifecycle.md) for tool schemas, Beads mappings,
artifact and worktree identity, reconciliation behavior, verification, and the
read-only migration report.

## Scheduled wakeups

On **Pi 1.2 or newer within 1.x**, this package exposes three tools:

- `schedule_wakeup`: schedule one follow-up check and return immediately.
- `list_wakeups`: inspect the pending alarm and retained follow-up cutoff.
- `cancel_wakeup`: cancel an exact pending ID and stop automatic rearming.

The personal bootstrap and development SDK use Pi 1.2.0. On older, prerelease,
or unknown runtimes, the extension reports that wakeups are disabled rather
than scheduling without reliable abort information. No slash commands or
recurring-loop scheduler are added.

For example, an agent checking an approved operation can call `schedule_wakeup`
with:

```json
{
  "delaySeconds": 120,
  "prompt": "Check deployment run-123. Report its state and schedule another check only if still needed.",
  "reason": "The approved deployment is still running",
  "timeoutSeconds": 3600
}
```

The agent ends its turn. Once due and the session is available, the runtime sends
a visible custom continuation—not fresh user input—and requests another turn.
The agent must still verify the external operation's actual state. Prefer an
existing background completion event when one already supplies that signal.

Choose **exactly one** timing input:

- `delaySeconds`: a whole number from **60 to 3600**.
- `at`: a calendar-valid `YYYY-MM-DDTHH:mm:ss[.sss]` timestamp with `Z` or an
  explicit UTC offset, **60 seconds through 7 days ahead**. Up to three fractional
  digits are accepted; timezone-free dates are rejected. For example,
  `"at": "2030-06-10T09:00:00+02:00"` (substitute a target within the next week).

Both forms share one pending alarm. Busy runs, compaction, and queued input take
priority. An armed alarm remains pending however late it becomes while the
session survives; lateness does not discard it. Delivery is best-effort, not an
exact-time guarantee.

`timeoutSeconds` bounds **additional automatic checks**, not delivery of an
already-armed alarm. It accepts whole seconds from **61 to 86400**, default 3600:

- Initial relative check: cutoff is scheduling time plus the budget; the budget
  must exceed the delay.
- Initial absolute check: cutoff is the target time plus the budget.
- Later checks retain the original cutoff, even when switching timing forms.
  Their due times must precede it. Omit `timeoutSeconds` or repeat its initial
  value; changing it cannot renew the budget.

For example, an absolute alarm for tomorrow at 09:00 with a one-hour budget has
an automatic-follow-up cutoff of 10:00 tomorrow. If the session cannot run until
11:00, that alarm still delivers once, but it cannot automatically schedule
another check. Fresh real user input is needed to start a new budget after the
check settles. Input during an active wait does not silently renew its cutoff.
Cancellation or an aborted run also blocks automatic rearming until fresh input.

Prompts must contain nonempty text of at most 8192 characters; reasons at most 512. Results include the pending ID, prompt/reason, `dueAt`, and `deadline`, in
Unix milliseconds. **`deadline` is the follow-up cutoff, not alarm expiry.**
`scheduled` includes overdue alarms. `checking` means a continuation was
requested, not that another timer is pending; `completed` describes that turn,
not the watched operation. `expired` means the follow-up cutoff has elapsed
without a pending alarm—it never removes an already-armed alarm.

Session replacement, branch navigation, reload, and exit cancel pending work.
Scheduling state is not persisted or replayed after restart. Cancellation cannot retract a
turn that has already started. Delivery makes one send attempt, not an
exactly-once execution guarantee; asynchronous errors are reported by Pi without
blind retries. A wakeup grants no extra authority to publish, merge, deploy, or
claim work.

The scheduler uses one in-process timer, with no background daemon or network
polling. Future alarms recheck wall time at intervals of at most one minute;
busy overdue alarms retry availability every five seconds. This catches clock
changes and suspend/resume without early delivery or a post-cutoff timer spin.
Resumed agents use their normal tools and provider. Waiting makes no model requests.

In the interactive TUI, yielding with a pending check adds a compact waiting
notice with its reason and local due time; long waits use days and hours.
Overdue labels retain the original due time. These display-only entries stay in
chat history but never enter model context or restore timers. Cancellation
closes the notice; repeated status reads do not add duplicate notices.
Active work, queued input, and human-input blockers take precedence over the
live waiting label. There is no continuously repainting countdown.

The existing Herdr pane reporter also publishes `pi_waiting`. The optional
[sidebar layout](plugins/herdr-space-tabs/README.md) renders it in warm amber
without changing Herdr’s native state dot. Labels clear on resumption,
cancellation, session replacement, reload, and orderly shutdown;
startup clears stale values. Forced process termination cannot guarantee
cleanup. Sidebar delivery remains bounded and best-effort.

When replacing a separate preview implementation, remove that package source
with `pi remove <old-preview-source>` before `/reload`; do not load two packages
that register the same tool names. This package is already the permanent source
when installed through the personal bootstrap.

Tests cover the controller, tool adapter, version guard, and completion-review
interaction. The real-SDK tests run against the repository's supported SDK.
To exercise a different supported installed SDK without changing dependency pins:

```sh
PI_WAKEUP_SDK=file:///absolute/path/to/pi/dist/index.js \
  npm run test:file -- tests/wakeups-runtime.test.ts
```

Those tests use a temporary configuration, fake time, and an in-process provider;
network requests are rejected and personal credentials are not loaded.

## Optional completion review

On a stable Pi runtime **1.2.0 or newer**, the operator can use
`/mission-check on|off|status`. Review is **off by default**, parent-only and
session-local; new, resumed and forked sessions start off. Task text cannot
enable it. The personal bootstrap pins the tested 1.2.0 runtime. Reloading this
package does not upgrade an older host; upgrade it explicitly before using this
revision's native context-delivery and settlement behavior.

When enabled, a native pre-settlement hook offers one automatic reconsideration
of the latest user agreement against completed work. The SDK presents the cue
as user-role context; its text explicitly denies new instruction or approval.
It refreshes available
owned task context, but missing or contradictory records do not disable the
conversation-based check. Its own continuation, metadata edits and toggling
off/on cannot replenish that submitted run's budget. Scheduled wakeups remain
custom continuations, not fresh user input, and do not replenish review either.
It does not wake an idle
agent, launch a worker, infer permission or verify mission completion.

Abort/error outcomes and terminal or failed tools suppress the review. This is
conservative: even a recovered tool error can skip it. Queued input takes
precedence. The first apparent final answer may already be visible; this is not
a pre-send filter. Pi 1.2.0 may retain a cue in history if cancellation occurs
during the context lookup, but cancellation prevents the next model call.

## Project picker

With an explicitly activated catalog, `/area` and `/project` select global,
area, or project views and manage described, persistent entities—even empty
projects. Each project inherits its area's explicit local-only or linked work-item
publication policy for **new tasks**. There is no default-board fallback.
Selection changes browsing only: it does not rename the session, claim/release
work, or choose placement for new tasks. Every catalog-backed creation supplies
an explicit project ID or registered name, even when a task is already owned.
Recording work elsewhere leaves the session unchanged.

A claimed task supplies the working project/area, shown explicitly in Pi's status
alongside the actual session name and active task. Relinquishing ownership makes
the session unassigned and adopts a global view, without changing its name. Later
browsing remains independent; status labels filtered counts separately and keeps
an outside-view owned task visible. Unknown ownership is unavailable, not unassigned.

Session naming is left to Pi and the user: task transitions, project operations,
startup and child-session setup do not generate or repair names. Existing names,
including previously generated names, remain untouched. Project renames preserve
stable identity and aliases; moves never retarget existing captured destinations.

Catalog data is private Beads data, not package content. Use the
[reviewed prepare/activate runbook](docs/task-reconciler-operations.md#reviewed-area-and-project-activation)
only after the mappings, runtime/client cutover, and activation have been approved.
Installation and startup do not activate a catalog.

### Legacy picker before catalog activation

Use `/project` to switch the session's task scope. Projects are derived from
`workstream:` labels on tasks, including closed tasks; there is no separate
project creation command. Selecting a project does not claim a task or change the session name. Project
selection and rename migrations persist their scope independently of the name.

- **Manage projects…** → choose a project → **Rename** or **Archive**.
- **Archived projects…** → choose a project → **Restore**.
- `/project rename` remains available and uses the same rename operation.

Archival requires every associated task to be closed, including tasks where
that project is a secondary workstream. Deferred tasks are unfinished and block
archival. Archiving only hides the project from the default picker: tasks,
history, ownership, and existing session scopes are preserved. If new or reopened
unfinished work appears, the project is visible while that work remains; Restore
removes the archive marker permanently until the next explicit archival.

Archive markers live in the configured Beads store under
`custom.pi-project-archives`, shared by sessions using that store. Renaming
migrates the marker as well as task labels and the existing session aliases.
Project mutations share the local task-store lock; direct external `bd` writes
are not coordinated by that lock. Failed or unverifiable writes are reported
rather than silently retried.

## Optional task reconciliation daemon

See the [operations guide](docs/task-reconciler-operations.md) for the complete
cutover checklist, health/auth recovery, exact retries, rollback and read-only
selection probe. Installation and activation require separate approval.

Package installation, package updates, extension loading, and `/reload` never
install or start this service. Installation and activation are separate,
explicit operations. The daemon runs the existing reconciliation policy; it
cannot claim tasks, launch agents, merge pull requests, or supply manual outcomes.

Use Node >=22.19 and an existing Beads store. Create a private configuration file
outside the package checkout (for example `~/.pi/task-reconciler/config.json`,
mode `0600`). Replace every placeholder below with a real absolute path; JSON
paths do not expand `~` or shell variables. Choose a short runtime root because
Unix socket paths have a platform byte limit.

```json
{
  "version": 1,
  "store": "/absolute/user-home/beads/.beads",
  "poolConfigPath": "/absolute/package/extensions/worktree-pool/config.json",
  "lifecycleConfigPath": "/absolute/package/extensions/task-lifecycle/config.json",
  "runtimeRoot": "/absolute/user-home/.pi/run/tasks",
  "executables": {
    "node": "/absolute/path/to/node",
    "bd": "/absolute/path/to/bd",
    "git": "/absolute/path/to/git",
    "gh": "/absolute/path/to/gh"
  },
  "githubAccounts": {
    "example-org": "your-github-account"
  }
}
```

Account mappings are explicit and case-normalized by GitHub owner. Authenticate
those accounts with `gh` yourself; never put tokens in the configuration. The
daemon retrieves credentials noninteractively per observation and never changes
the globally selected account.

From the package checkout:

```sh
npm ci --ignore-scripts
cfg="$HOME/.pi/task-reconciler/config.json"
node bin/task-reconciler.mjs install --config "$cfg"
```

`install` builds and verifies Node-only ESM, copies configuration assets into a
private runtime, and prepares an inactive LaunchAgent template. It does not call
`launchctl`, run reconciliation, or publish a login agent. The installed runtime
needs neither this checkout nor `node_modules` to run.

Before first activation, reload or close **every older Pi process** that still
contains in-process automatic reconciliation. `/reload` alone does not activate
the service. After explicitly approving that cutover, use the relevant command:

| Operation                           | Command                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| Enable now and at login             | `node bin/task-reconciler.mjs start --config "$cfg"`             |
| Read status and health              | `node bin/task-reconciler.mjs status --config "$cfg"`            |
| Explicitly update runtime/config    | `node bin/task-reconciler.mjs update --config "$cfg"`            |
| Restore the previous runtime/config | `node bin/task-reconciler.mjs update --rollback --config "$cfg"` |
| Disable and unload                  | `node bin/task-reconciler.mjs stop --config "$cfg"`              |
| Remove verified service-owned files | `node bin/task-reconciler.mjs uninstall --config "$cfg"`         |

Updates drain before compiling/replacing the runtime. Updating an unloaded or
disabled service does not start it; an enabled, loaded service is restarted only
after the replacement is verified. Failed updates remain stopped rather than
automatically resuming an old policy. The previous immutable runtime and copied
configuration remain available for explicit rollback. A stable installed admin
entry point keeps stop/update available when a package update removes generated
files from the package checkout. Uninstall never deletes Beads data, source
configuration, worktrees, or unrecognized files.

Service files live under `~/.pi/task-reconciler/services/<canonical-store-key>`.
The user LaunchAgent label is `com.pi.task-reconciler.<canonical-store-key>`;
only explicit start publishes its plist under `~/Library/LaunchAgents`. The
singleton lock lives at `<canonical-store>/pi-task-reconciler`, so changing the
socket directory cannot create a second daemon for that store. This is a
single-host service, not distributed coordination.

Status parsing fails closed when launchd output or ownership cannot be verified.
Administrative tests inject launchctl; they do not load a real agent. A live
LaunchAgent validation is a separate approval step. Health is private and bounded;
stdout/stderr are discarded by launchd rather than becoming unbounded logs. For
startup diagnosis, stop the managed service and explicitly run the foreground
mode instead.

For isolated foreground tests, run `npm run build:reconciler`, then use the
runtime directory printed by the builder:

```sh
node /printed/runtime/lib/task-reconciler/cli.js --runtime-info
node /printed/runtime/lib/task-reconciler/cli.js run --config /absolute/test-config.json
```

Foreground `run` performs real reconciliation for the configured store; use a
temporary store for tests. SIGINT/SIGTERM drain owned work. Treat a timed-out or
interrupted management command as uncertain and read status before retrying;
unverifiable process ownership is never force-cleared.

## Resources

The package manifest loads:

- extensions for compact built-in tools, safe force pushes, permission
  gates, plan and spec progress, the styled editor, Herdr blocked-state mapping
  and conversation cloning,
  bounded worktree allocation, lifecycle-safe task mutation and presentation,
  project status, `/tasks`, and bounded scheduled wakeups on supported runtimes;
- nine skill roots: critical review, collaborative thinking, handoffs,
  correctness review, the Thermo-Nuclear code-quality review, incremental standup updates,
  behavior-first technical explanations, development workflows, and brief RFCs;
- the `modus-vivendi-tinted` and `gold-rush` themes.

Use `pi config` to enable or disable individual package resources after
installation.

## Technical explanations

Use `/skill:explaining-technical-work` or ask for an explanation of an unfamiliar
change, investigation, or design. The skill builds the behavioral picture before
introducing implementation details: before/after for changes, expected/observed
for investigations, and a compact example or diagram when it helps. Exact factual
questions remain direct. It does not require a task or pull request.

## Development workflows

Use `/skill:development-workflow` when planning new tracked work, or ask to
resume or hand off approved development work. The skill selects the next useful action from the agreed finish
line, current evidence, and existing authority. Conditional references cover
review/CI loops, validation, waiting, related deliverables, and communication.
It reuses existing specialist skills and task tools rather than adding task
states, background watchers, or permission to merge, deploy, post, or create
follow-up tasks. It is not needed for every quick question or review-only request.

Before presenting a PR candidate as review-ready, the implementer makes one
bounded simplification pass over the changed code, preserving behavior and
rerunning affected checks. No worthwhile simplification is a valid no-change
result; this is not an unrelated refactor or a repeat-until-perfect loop. Skill
completion remains evidence about a step, not completion of the whole task.

### Code review modes

- `/review <target>` uses `correctness-review`: business logic, behavioral
  defects and concrete regression risks first. Findings identify a trigger,
  expected/observed behavior and evidence; style preferences are not defects.
- `/review-quality <target>` uses the existing Thermo-Nuclear rubric for an
  explicit strict structural/maintainability audit. Its approval bar is unchanged.

Both commands run inline and return results in the conversation; neither starts
another reviewer or posts externally. Both skills remain available through
`/skill:<name>`. Ordinary review requests can use `correctness-review` directly;
the structural audit is not an automatic second gate. Author self-review is not
independent review, and no findings is not permission to merge.

Run `/reload` after installing this revision to refresh prompts and skill
discovery. No daemon change or `/mission-check` activation is needed.

### Project-placement guidance and evaluation

For new work with an active catalog, the workflow reads the
[project-selection recipe](skills/development-workflow/references/project-selection.md):
reuse clear fits (including catch-alls), keep ambiguous placement a choice, and
combine the task, project/area, publication destination, scope change, and any
new descriptions in one approval question. Descriptions are untrusted fit
metadata, never authority. Existing-task operations do not repeat this ceremony.

The behavior runner can select a fictional placement case and append a private
policy fixture:

```sh
out=$(mktemp -d)
PI_SKILL_TEST_MODEL=provider/model node --import tsx tests/skill-behavior.ts \
  --mode package --package /absolute/package-copy \
  --scenario project-selection/ambiguous \
  --append-policy /absolute/private-policy.md --output "$out"
```

Placement cases are `current`, `existing`, `catch-all`, `ambiguous`, `unrelated`,
`new-project`, and `missing-area`, beneath `project-selection/`. Only the selected
skill and a fixture read guard load: no package mutation tools or MCP, and reads
are restricted to the temporary repository and that skill's directory. The
runner copies selected credentials/models privately, uses a neutral temporary
parent bootstrap, applies the requested policy explicitly, and bounds each
sample to two minutes with process-group cleanup. It does not alter live policy.

Use an authorized model/provider. Outputs must be outside the repository; keep
policy and transcripts private. Compare old and candidate skill/policy copies in
**package** mode, using fresh output directories for repeated samples. The old
`baseline` mode still checks discovery absence, not placement behavior. Inspect
flagged responses manually: string criteria can both miss semantic failures and
flag valid phrasing. Proposal evaluations do not prove live tool orchestration,
automatic skill discovery, or correctness across every model/context.

## Brief technical RFCs

Use `/skill:writing-rfcs` or ask to draft, revise, or format a technical RFC.
The skill captures a five-section minimal RFC and native document typography,
keeps unresolved decisions distinct from accepted trade-offs, and requires
content and formatting read-back. It uses the user's template and examples at
runtime; internal document links and project evidence do not belong in this
public package. Unsupported document operations remain explicit manual steps.

## Incremental standup updates

Use `/skill:standup` or ask for a standup update. The first run asks for a starting
point and source scope; later runs cover work since the previous saved report.
The skill reads Beads task journals/history, GitHub activity, and available local
Pi sessions across projects, producing Progress / Next / Blockers with evidence.

Reports and coverage metadata stay in private `~/.pi/standup/reports/` files;
source scope and draft files also stay under `~/.pi/standup/`, never in this
package. Complete successful generation saves automatically. Missing sources,
truncated collection, and draft-only requests do not advance the cutoff.
Regenerating revises the latest interval without advancing it or deleting prior
text. A fully checked no-activity interval may still save.

Selected evidence is sent to the configured model. The session filter excludes
thinking and private-context text and withholds all session text on incomplete
scans, but is not a comprehensive secret detector. Sources outside the declared
scope, deleted sessions, and delayed search-index events may be absent; this is
not an audit log. The skill never posts updates, changes tasks, starts login,
or schedules itself. See [source and recovery guidance](skills/standup/references/sources.md).

## Clone into a Herdr pane

Use `/herdr-clone` from an idle, saved Pi conversation inside Herdr:

| Command                                       | New pane                              |
| --------------------------------------------- | ------------------------------------- |
| `/herdr-clone`                                | Side by side (default)                |
| `/herdr-clone vertical` or `/herdr-clone v`   | Side by side, like Herdr's `prefix+v` |
| `/herdr-clone horizontal` or `/herdr-clone h` | Stacked, like Herdr's `prefix+-`      |

The command copies the active conversation branch into a new session, opens
and focuses the new pane, and starts Pi with the same working directory,
model, and thinking level. The new agent waits for your next instruction;
the original session is unchanged. Catalog-backed clones start unassigned with
a global browse view and a new session ID; they never inherit or transfer
the parent’s ownership. Fork and `/clear` use the same neutral catalog behavior.
Without a catalog, legacy scope preservation remains. Neither mode overrides
Pi's native session naming. Compaction records are
preserved, so this
separates future conversation growth but does not shrink inherited context.
The new process loads its normal Pi configuration, not the source process's
in-memory extension state or one-off CLI overrides.

Cloning does not copy files, create a worktree, or transfer task/worktree
ownership. Agents editing concurrently must use separate worktrees.
Ephemeral sessions, branches without an assistant response, busy agents, and
queued messages are rejected. Requires Herdr on `PATH` with `pane split` and
`agent start` support (verified against Herdr 0.8.0).

A failed launch reports the saved session path and pane ID when known. It does
not retry or delete anything automatically: a timed-out request may have
succeeded. Inspect Herdr before retrying. To recover a saved clone manually,
run `pi --session <reported-session-file>` from the intended working directory.

## Herdr pane task labels

Interactive Pi sessions inside Herdr mirror their owned task into the pane
frame, for example `jp-example • Review auth`. Pi's full project-status row
remains visible: actual session name, owned project/area and task/counts are retained
near the prompt. The default global view omits `Browse: All areas`; narrowed
project/area views still identify their filter.

The reporter uses native **display-agent metadata**, not a primary title or a
pane rename. Explicit Herdr titles and manual pane names keep priority, and
neither Pi's session name nor Herdr's detected agent/lifecycle authority changes.
A native Pi guard keeps the display label from applying to a shell or another
agent in the pane. With no owned task, the label uses the actual session name,
or `Unassigned` if unnamed. Failed or ambiguous task
lookups show `Task unavailable` rather than pretending no task is owned.

To keep the name-bearing frame visible even for a lone pane, merge these values
into the existing Herdr configuration's `[ui]` section and apply them through
Herdr's supported configuration reload:

```toml
[ui]
pane_borders = "always"
pane_outer_borders = true
show_agent_labels_on_pane_borders = true
```

These settings affect all Herdr panes; legacy `pane_borders = true` means Auto,
not Always. The package does not edit configuration or restart Herdr. Metadata
delivery is bounded and best-effort, with retries on normal updates, and never
hides Pi's status row. A successful metadata write alone does not prove that a
frame is visible. Orderly shutdown clears this integration's display-agent
field; explicit titles/manual names and unrelated metadata are left alone.

## Herdr sidebar metadata

Interactive Pi sessions inside Herdr display the claimed task as the main
title, the task’s catalog project and area underneath, then only state and
model. Herdr tab/space names and browse filters do not replace task identity. The
example allows dragging the sidebar up to 100 columns wide. An optional
event-driven Herdr plugin shows each space's
tab count and distinct tasks claimed by its Pi sessions, without Git information
or an active-tab row. Context usage stays
in Pi's footer, with `Context ?` while its estimate is unknown. Configuration and
plugin activation are explicit; see [Herdr sidebar metadata](plugins/herdr-space-tabs/README.md)
for behavior, activation, and rollback. Python 3.9+ on macOS/Linux is required
for the space plugin and its tests.

## Worktree pool

The package includes a bounded, conservative worktree allocator. Its core knows
only repositories, branches, Git registrations, opaque claims, capacity, and
clean release. Task ownership and lifecycle policy live in the separate
`task-lifecycle` extension. Operational details and task-aware wrapper examples
are in [Task lifecycle](docs/task-lifecycle.md).

## Permission guardrail

The permission-gate extension performs best-effort checks for several common
destructive shell-command forms. It is intentionally incomplete: it is not a
shell parser, sandbox, or authorization boundary, and commands run with the
same privileges as Pi. Do not rely on it to execute untrusted commands safely
or to enforce access control.
