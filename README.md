# JP's Pi Config

JP's public Pi package for a portable personal coding-agent setup.

## Requirements

- Pi `>=0.84.1 <0.85.0`
- Node.js `>=22.19.0`
- [`bd`](https://github.com/steveyegge/beads) available on `PATH`

Task data is read from `BEADS_DIR`. When it is unset, the package uses
`~/beads/.beads`. Create and manage that store with `bd`; task state is not
included in this package.

## Manual installation

```sh
set -euo pipefail
pi install git:github.com/jpriverar/pi-config@v0.1.0
```

The immutable tag keeps the installed configuration reproducible. Running
`pi update --extensions` reconciles the managed checkout with the configured
ref; it does not advance a pinned ref to a newer tag.

To remove the package and its managed checkout:

```sh
set -euo pipefail
pi remove git:github.com/jpriverar/pi-config@v0.1.0
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

## Release scope

The macOS bootstrap is intentionally not part of `v0.1.0`; bootstrap
instructions are deferred to `v0.2.0`.
