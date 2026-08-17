# Personal macOS Bootstrap Design

## Status

Approved design for `jp-6yl`. This document defines the bootstrap contract; implementation is deferred to a separate plan.

## Goal

Turn a clone of `jpriverar/pi-config` on a personal macOS machine into a usable, reproducible Pi setup without copying work configuration, credentials, sessions, model catalogs, MCP configuration, or task history.

Every non-secret setup step is automated. Authentication and other interactive consent remain an explicit final checklist.

## User flow

The user clones this repository wherever they want and runs:

```sh
set -euo pipefail
./scripts/bootstrap-macos.sh
```

The script derives the repository root from its own checkout and registers that absolute path as a local Pi package source. There is no required clone location, second clone, agent-directory symlink, or hard-coded repository commit.

After future pulls, `/reload` or a Pi restart loads the updated extensions, skills, and theme directly from the checkout:

```sh
set -euo pipefail
git pull --ff-only
pi
```

## Ownership boundaries

### Source-controlled code and resources

The repository owns:

- extensions, skills, and the theme already exposed by its Pi package manifest;
- the bootstrap shell orchestrator;
- the profile reconciliation helper;
- bootstrap tests and documentation.

### Machine-local state

`~/.pi/agent` remains a real, stable directory. It is never a symlink to this repository. It owns:

- `settings.json`;
- authentication state;
- sessions;
- models;
- MCP configuration;
- installed-package caches;
- generated runtime state.

The bootstrap modifies only its declared settings keys and package entries. It does not read or modify credentials, sessions, model catalogs, or personal MCP configuration except for rejecting known work-only configuration during safety validation.

### Task state

The personal Beads store is `~/beads/.beads`. It is initialized empty and never populated from another machine or work store. No remote is configured by this bootstrap.

## Components

### `scripts/bootstrap-macos.sh`

A Bash 3.2-compatible, fail-fast orchestrator responsible for:

1. platform and prerequisite checks;
2. repository-root discovery;
3. Homebrew formula installation;
4. exact Node and Pi installation;
5. Pi package reconciliation;
6. Beads initialization;
7. shell environment reconciliation;
8. final verification and the interactive checklist.

It uses `set -euo pipefail`, quotes every path, and works when the repository path contains spaces.

### `scripts/reconcile-personal-profile.mjs`

A Node helper responsible for structured settings and shell-state operations that would be fragile in shell:

- parsing and validating existing settings;
- replacing bootstrap-managed package entries;
- preserving unrelated public package entries;
- setting bootstrap-managed preferences;
- atomically writing JSON;
- validating forbidden work-only configuration;
- validating the installed package versions reported by the Pi-managed npm workspace;
- writing one idempotent managed block to `~/.zshrc`.

The helper accepts explicit paths and values so tests never depend on the developer's real home directory.

## Prerequisites and versions

Homebrew is the sole prerequisite. If `brew` is unavailable, the script exits without mutation and prints the official manual prerequisite; it never executes a remote Homebrew installer.

The bootstrap installs missing formulas:

- `volta` from the current Homebrew formula;
- `beads` from the current Homebrew formula.

The JavaScript and Pi runtime are exact:

- Node `22.19.0`;
- `@earendil-works/pi-coding-agent` `0.84.1`.

Pi is installed with npm lifecycle scripts disabled, matching Pi's documented installation guidance.

## Managed Pi packages

The repository checkout itself is registered as an absolute local package source. The following public npm package sources are managed at exact versions:

- `npm:pi-mcp-adapter@2.26.0`;
- `npm:pi-subagents@0.50.0`;
- `npm:context-mode@1.0.169`;
- `npm:pi-markdown-preview@0.14.1`;
- `npm:@juicesharp/rpiv-ask-user-question@2.6.1`.

No work-only package or plugin is installed.

Pi's generated npm workspace currently records caret dependency ranges even when settings contain versioned sources. Therefore the bootstrap verifies the resolved package versions after all package operations. A mismatch is a failed bootstrap, not a warning.

## Managed Pi preferences

The bootstrap owns these settings:

```json
{
  "theme": "modus-vivendi-tinted",
  "defaultThinkingLevel": "high",
  "hideThinkingBlock": true,
  "quietStartup": true
}
```

It does not set a default provider or model and does not create `auth.json`, `models.json`, or `mcp.json`. Provider setup remains interactive through Pi's `/login` flow.

Unknown public package entries and unrelated settings keys are preserved. Existing entries for bootstrap-managed packages are replaced in place with the approved sources so reruns do not duplicate them.

## Bootstrap flow

1. Verify macOS and Homebrew before mutation.
2. Resolve the repository root with Git and verify that the script belongs to that checkout.
3. Reject a symlinked `~/.pi/agent`.
4. Parse existing settings and run personal/work boundary validation.
5. Install missing Homebrew formulas.
6. Export the Volta environment for the current process.
7. Install Node `22.19.0` and Pi `0.84.1`.
8. Snapshot the original settings bytes if the file exists.
9. Reconcile managed settings and package sources.
10. Install or reconcile the local core package and five exact npm package sources.
11. Reconcile settings again because Pi package commands may rewrite the file.
12. Verify the active Pi, Node, package-source, and resolved npm versions.
13. Create `~/beads` and run `bd init --init-if-missing --non-interactive --prefix jp` there.
14. Atomically install one managed shell block containing `VOLTA_HOME`, its `PATH` entry, and `BEADS_DIR`.
15. Run final boundary and idempotency checks.
16. Print the current repository SHA and the remaining interactive steps.

## Safe reconciliation

The bootstrap may run repeatedly. A successful second run produces no configuration diff.

Before profile mutation it validates:

- `~/.pi/agent` is absent or a real directory;
- existing JSON is parseable;
- managed settings have supported value types;
- package sources do not contain known work-only scopes, repositories, or local overlay paths;
- existing MCP configuration does not reference known work-only hosts;
- no tracked or generated task history is being imported.

Unknown public npm, Git, and HTTP package sources are preserved. Unknown local package paths are rejected because the bootstrap cannot establish that they are personal-safe.

Runtime text such as session transcripts is never scanned. Boundary checks inspect configuration surfaces only, avoiding false positives from conversations that mention work.

## Failure and rollback

- Every failure identifies the operation and affected path and exits nonzero.
- No command uses `sudo`, destructive deletion, force flags, or hook bypasses.
- JSON and `.zshrc` changes use temporary files followed by atomic rename.
- Existing settings bytes are restored if package installation or version verification fails.
- A `.zshrc` backup is made immediately before changing its managed block.
- Homebrew formula and package downloads are not removed on failure; they are safe inputs to a rerun.
- An existing Beads store is never reinitialized, destroyed, imported, or assigned a remote.
- Credentials and tokens are never read, printed, copied, generated, or included in diagnostics.

## Managed shell block

The script manages exactly one marker-delimited block in `~/.zshrc`:

```sh
# >>> jpriverar pi bootstrap >>>
export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:$PATH"
export BEADS_DIR="$HOME/beads/.beads"
# <<< jpriverar pi bootstrap <<<
```

Existing shell content outside this block is byte-preserved. A malformed or duplicated managed block causes a failure instead of a guess.

## Interactive completion checklist

A successful run prints only the steps automation cannot safely perform:

1. start a new shell or source `~/.zshrc`;
2. launch `pi`;
3. run `/login` and choose a personal provider;
4. configure personal MCP servers later if desired;
5. use `git pull --ff-only` in this checkout and `/reload` to consume future code/resource updates.

## Testing strategy

### Reconciler tests

Node tests use temporary directories and literal expected settings to cover:

- a fresh profile;
- a rerun with no diff;
- preservation of unrelated public packages and settings;
- replacement without duplication of managed packages;
- malformed JSON;
- symlink rejection;
- unknown local package rejection;
- known work-only package and MCP rejection;
- atomic write failure;
- malformed and duplicated shell markers;
- shell-content byte preservation.

### Shell orchestration tests

The shell script runs with a temporary `HOME` and a fake `PATH` containing deterministic stand-ins for `uname`, `brew`, `git`, `volta`, `node`, `npm`, `pi`, and `bd`. Tests assert observable behavior rather than source text:

- command order and exact version arguments;
- repository paths containing spaces;
- no Homebrew prerequisite mutation;
- failure propagation and settings restoration;
- exact package reconciliation;
- empty Beads initialization with prefix `jp`;
- rerun idempotency;
- final checklist output;
- no access outside the temporary home and fixture repository.

Default tests perform no network access and do not touch the real user profile. A separate opt-in smoke test may exercise installed tools in an isolated temporary profile.

### Repository gates

The existing test, typecheck, formatting, portability, license, smoke, and secret-scanning gates remain required. Portability tests additionally reject machine-specific absolute paths, credentials, work-only identifiers, runtime state, and copied task data in tracked bootstrap artifacts.

## Acceptance criteria

The work is complete when:

- a documented clone of `main` can bootstrap a fresh temporary personal profile;
- the local checkout is the active source for core code and resources;
- exact Node, Pi, and npm package versions are verified;
- rerunning produces no managed configuration diff;
- existing personal runtime state survives reconciliation byte-for-byte;
- a work-profile or unknown local overlay is rejected before mutation;
- the Beads store is new, empty, independent, and remote-free;
- no provider, model, MCP, credential, session, or task-history data is copied;
- all repository gates pass on supported Pi `0.84.x` compatibility targets;
- the README documents initial setup, updates, rollback, and interactive completion.

## Non-goals

- installing Homebrew;
- configuring a work machine or work-only services;
- copying an existing agent directory or task store;
- selecting or authenticating a model provider;
- configuring personal MCP servers;
- configuring a Beads remote or backup;
- automatically pulling repository changes while Pi is running;
- supporting operating systems other than macOS;
- supporting Pi `0.85.x` or newer without a separate compatibility review.
