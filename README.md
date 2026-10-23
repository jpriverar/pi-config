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
`next_step` only for the uniquely owned active task in the selected scope.
It never chooses a mission by title or borrows another session's task.

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
- `list_wakeups`: inspect the pending check and retained wait deadline.
- `cancel_wakeup`: cancel an exact pending ID and stop automatic rearming.

The bootstrap's older pinned runtime remains unchanged. On older, prerelease,
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

The agent ends its turn. At the due time, the runtime sends a visible custom
continuation—not fresh user input—and starts another turn. The agent must still
verify the external operation's actual state. Prefer an existing background
completion event when one already supplies that signal.

Only one wakeup may be pending. Delays must be whole seconds from **60 to 3600**.
The initial wait budget defaults to one hour and may be set up to 24 hours; it
must exceed the first delay. Every subsequent check retains the original
absolute deadline, even if its prompt changes. Prompts must contain nonempty text
of at most 8192 characters; reasons at most 512. Tool results include the pending
ID, prompt/reason, due time, and deadline; timestamps are Unix milliseconds.

Busy runs, compaction, and queued user input postpone delivery. Expired work is
dropped with a notice instead of starting another model turn. Cancellation or
an aborted run blocks automatic rearming until fresh real user input. Real input
during an active wait does not silently renew its deadline. A `checking` status
means the resumed turn is running, not that another timer is pending.

Session replacement, branch navigation, reload, and exit cancel pending work.
Scheduling state is not persisted or replayed after restart. Cancellation cannot retract a
turn that has already started. Delivery makes one send attempt, not an
exactly-once execution guarantee; asynchronous errors are reported by Pi without
blind retries. A wakeup grants no extra authority to publish, merge, deploy, or
claim work.

The scheduler uses one in-process timer, with no background daemon or network
polling. Resumed agents use their normal tools and provider. Waiting between
checks makes no model requests.

In the interactive TUI, yielding with a pending check adds a compact waiting
notice with its reason and local due time. These display-only entries stay in
chat history but never enter model context or restore timers. Cancellation and
expiry close the notice; repeated status reads do not add duplicate notices.
Active work, queued input, and human-input blockers take precedence over the
live waiting label. There is no continuously repainting countdown.

The existing Herdr pane reporter also publishes `pi_waiting`. The optional
[sidebar layout](plugins/herdr-space-tabs/README.md) renders it in warm amber
without changing Herdr’s native state dot. Labels clear on resumption,
cancellation, expiry, session replacement, reload, and orderly shutdown;
startup clears stale values. Forced process termination cannot guarantee
cleanup. Sidebar delivery remains bounded and best-effort.

When replacing a separate preview implementation, remove that package source
with `pi remove <old-preview-source>` before `/reload`; do not load two packages
that register the same tool names. This package is already the permanent source
when installed through the personal bootstrap.

Tests cover the controller, tool adapter, and version guard. The real-SDK tests
skip on the repository's older pinned SDK. To exercise them against a supported
installed SDK without changing dependency pins:

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
off/on cannot replenish that submitted run's budget. It does not wake an idle
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
Selection does not claim or release work; a session-owned task outside the view
remains visible in status. Renames preserve stable identity and aliases; moves
never retarget existing captured destinations.

Catalog data is private Beads data, not package content. Use the
[reviewed prepare/activate runbook](docs/task-reconciler-operations.md#reviewed-area-and-project-activation)
only after the mappings, runtime/client cutover, and activation have been approved.
Installation and startup do not activate a catalog.

### Legacy picker before catalog activation

Use `/project` to switch the session's task scope. Projects are derived from
`workstream:` labels on tasks, including closed tasks; there is no separate
project creation command. Selecting a project does not claim a task.

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
- eight skill roots: critical review, collaborative thinking, handoffs,
  the Thermo-Nuclear code-quality review, incremental standup updates,
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

The strict review skill uses `explaining-technical-work` for substantial findings
while retaining its maintainability bar and inline `/review` behavior. Skill
completion is evidence about a step, not automatic completion of the whole task.

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
the original session is unchanged. A named clone gets a fresh display name
using its project (or existing name) and the new session ID's suffix, while
keeping the same project scope. Compaction records are preserved, so this
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

## Herdr sidebar metadata

Interactive Pi sessions inside Herdr display tab and space, claimed task,
then state and model. An optional event-driven Herdr plugin shows each space's
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
