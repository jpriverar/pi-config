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
checkout as the local Pi package source, and five public npm package sources:

- `npm:pi-mcp-adapter@2.26.0`
- `npm:pi-subagents@0.50.0`
- `npm:context-mode@1.0.169`
- `npm:pi-markdown-preview@0.14.1`
- `npm:@juicesharp/rpiv-ask-user-question@2.6.1`

It reconciles reviewed settings in `$HOME/.pi/agent`, manages one
marker-delimited shell block for `VOLTA_HOME`, `PATH`, and `BEADS_DIR`, and
uses an independent personal Beads store at `$HOME/beads/.beads`.
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

Before model turns, the workflow sends scoped task IDs, titles, readiness, and
workstream labels from the Beads store to the configured model as hidden
context. Compaction refreshes the same context for the next turn. The values
are normalized and explicitly marked as untrusted data rather than
instructions, but they are still disclosed to the model. Only put task data in
the configured store that is appropriate to share with that model.

## Resources

The package manifest loads:

- seven extensions for compact built-in tools, permission gates, plan and spec
  progress, the styled editor, task workflow, project status, and `/tasks`;
- four skill roots: Superpowers, critical review, collaborative thinking, and
  handoffs;
- the `modus-vivendi-tinted` theme.

Use `pi config` to enable or disable individual package resources after
installation.

## Permission guardrail

The permission-gate extension performs best-effort checks for several common
destructive shell-command forms. It is intentionally incomplete: it is not a
shell parser, sandbox, or authorization boundary, and commands run with the
same privileges as Pi. Do not rely on it to execute untrusted commands safely
or to enforce access control.
