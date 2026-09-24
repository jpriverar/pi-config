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

The script installs and owns Node.js 22.19.0 via Volta, Pi 0.84.1, this
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
hidden context.
Compaction refreshes the same bounded context for the next turn. The values are
normalized and explicitly marked as untrusted data rather than instructions,
but they are still disclosed to the model. Only put task data in the configured
store that is appropriate to share with that model.

See [Task lifecycle](docs/task-lifecycle.md) for tool schemas, Beads mappings,
artifact and worktree identity, reconciliation behavior, verification, and the
read-only migration report.

## Resources

The package manifest loads:

- extensions for compact built-in tools, safe force pushes, permission
  gates, plan and spec progress, the styled editor, Herdr blocked-state mapping
  and conversation cloning,
  bounded worktree allocation, lifecycle-safe task mutation and presentation,
  project status, and `/tasks`;
- four skill roots: critical review, collaborative thinking, handoffs, and the
  Thermo-Nuclear code-quality review;
- the `modus-vivendi-tinted` and `gold-rush` themes.

Use `pi config` to enable or disable individual package resources after
installation.

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
