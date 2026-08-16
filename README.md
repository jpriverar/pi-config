# JP's Pi Config

JP's personal Pi configuration, published for discovery and exploration. This
project is experimental and unsupported; it is not a stable product or a
supported distribution.

## Requirements

- Pi `>=0.84.1 <0.85.0`
- Node.js `>=22.19.0`
- [`bd`](https://github.com/steveyegge/beads) available on `PATH`

Task data is read from `BEADS_DIR`. When it is unset, the package uses
`~/beads/.beads`. Create and manage that store with `bd`; task state is not
included in this package.

## Task data and model context

Before model turns, the workflow sends scoped task IDs, titles, readiness, and
workstream labels from the Beads store to the configured model as hidden
context. Compaction refreshes the same context for the next turn. The values
are normalized and explicitly marked as untrusted data rather than
instructions, but they are still disclosed to the model. Only put task data in
the configured store that is appropriate to share with that model.

## Explore current main

Install the current `main` branch to explore the configuration as it evolves:

```sh
set -euo pipefail
pi install git:github.com/jpriverar/pi-config@main
```

`main` may change without notice. There is no stable-release or compatibility
promise beyond the currently documented Pi and Node.js range.

## Pin an exact revision

For reproducible use on personal or work machines, replace the placeholder with
an exact commit SHA reviewed for that environment:

```sh
set -euo pipefail
pi install git:github.com/jpriverar/pi-config@YOUR_COMMIT_SHA
```

Running `pi update --extensions` reconciles the managed checkout with its exact
configured commit; it does not advance that commit pin when `main` changes.

Remove the package with the same source originally installed, for example:

```sh
set -euo pipefail
pi remove git:github.com/jpriverar/pi-config@YOUR_COMMIT_SHA
```

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

## Scope

The macOS bootstrap is intentionally not included. No delivery version or date
is promised for it.
