# Personal macOS Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, rerunnable macOS bootstrap that installs the approved personal Pi toolchain, loads this checkout directly as a local Pi package, initializes an independent Beads store, and leaves credentials and runtime state machine-local.

**Architecture:** A Bash 3.2-compatible orchestrator owns platform/tool installation and calls a Node reconciler for structured settings, policy validation, exact-version checks, and atomic shell-profile writes. The default test suite exercises the whole flow offline through temporary homes and fake external commands; the public portability gate reviews every tracked bootstrap artifact.

**Tech Stack:** Bash 3.2, Node.js 22.19.0 ESM, TypeScript tests with `node:test`/`tsx`, Pi 0.84.1, Homebrew, Volta, Beads.

**Spec:** `docs/superpowers/specs/2026-08-17-personal-macos-bootstrap-design.md`

## Global Constraints

- Homebrew is the sole prerequisite; never execute a remote Homebrew installer.
- Support macOS only, Node `22.19.0`, and Pi `0.84.1`.
- Load the current repository checkout through its derived absolute path; do not clone it again, symlink `~/.pi/agent`, or replace it with a Git package pin.
- Keep `~/.pi/agent` a real, stable directory and preserve auth, sessions, models, MCP configuration, caches, and unrelated public packages.
- Manage only the Modus theme, high thinking, hidden thinking blocks, quiet startup, the local core source, and the five exact public npm package sources listed in the spec.
- Keep provider/model authentication interactive; never read, generate, copy, or print credentials.
- Initialize only an empty `~/beads/.beads` with prefix `jp`; never import history or configure a remote.
- Use Bash 3.2 syntax: no associative arrays, `mapfile`/`readarray`, `${name^^}`, or Bash 4-only features.
- Default tests must be offline and isolated under temporary homes and fixture repositories.
- Do not add tracked machine-specific paths, work-only identifiers, endpoint names, runtime data, or contiguous negative-test sentinels.
- Follow strict TDD for every behavior: write one failing test, observe the expected failure, implement the minimum, and rerun the focused and neighboring tests.
- Before every commit, run `git diff --cached --name-only` and confirm only that task's intended files are staged.

---

## File Structure

### Create

- `scripts/reconcile-personal-profile.mjs` — profile policy, settings reconciliation, atomic writes, shell block reconciliation, installed-version verification, and CLI.
- `scripts/bootstrap-macos.sh` — macOS/Homebrew/toolchain/package/Beads orchestration and rollback.
- `tests/reconcile-personal-profile.test.ts` — direct tests for the Node reconciler.
- `tests/bootstrap-macos.test.ts` — offline end-to-end shell tests with fake external commands.

### Modify

- `scripts/verify-portable.mjs` — review `scripts/bootstrap-macos.sh` as an authored executable.
- `tests/portable.test.ts` — lock the new executable and tracked-bootstrap portability contract.
- `package.json` — add a focused bootstrap test command and include bootstrap docs in formatting.
- `README.md` — document bootstrap, updates, rollback, limitations, and interactive completion.

### Existing contract

- `docs/superpowers/specs/2026-08-17-personal-macos-bootstrap-design.md` — approved behavior; change only if implementation exposes a real contradiction and stop for approval first.

---

### Task 1: Reconcile and validate personal settings

**Files:**

- Create: `scripts/reconcile-personal-profile.mjs`
- Create: `tests/reconcile-personal-profile.test.ts`

**Interfaces:**

- Produces:
  - `MANAGED_NPM_PACKAGES: ReadonlyArray<{ name: string; version: string; source: string }>`
  - `validateProfile(options: { agentDir: string; repoDir: string }): Promise<void>`
  - `reconcileSettings(options: { agentDir: string; repoDir: string; fileOperations?: FileOperations }): Promise<{ changed: boolean; settingsPath: string }>`
  - `atomicWrite(filePath: string, contents: string, fileOperations?: FileOperations): Promise<void>`
  - `FileOperations` JSDoc contract containing `lstat`, `mkdir`, `readFile`, `rename`, `rm`, and `writeFile`.
- Consumes: no earlier task output.
- Later tasks invoke these exports directly and through the CLI added in Task 2.

- [ ] **Step 1: Add the fresh-profile failing test**

Create `tests/reconcile-personal-profile.test.ts` with a temporary fixture and literal expected settings:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MANAGED_NPM_PACKAGES,
  reconcileSettings,
} from "../scripts/reconcile-personal-profile.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "personal-profile-"));
  return {
    root,
    agentDir: join(root, "home", ".pi", "agent"),
    repoDir: join(root, "checkout with spaces"),
  };
}

test("fresh settings load the checkout and exact public packages", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const result = await reconcileSettings(state);
  const settings = JSON.parse(
    await readFile(join(state.agentDir, "settings.json"), "utf8"),
  );

  assert.equal(result.changed, true);
  assert.deepEqual(settings, {
    theme: "modus-vivendi-tinted",
    defaultThinkingLevel: "high",
    packages: [
      state.repoDir,
      ...MANAGED_NPM_PACKAGES.map(({ source }) => source),
    ],
    hideThinkingBlock: true,
    quietStartup: true,
  });
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
npm run test:file -- tests/reconcile-personal-profile.test.ts
```

Expected: FAIL because `scripts/reconcile-personal-profile.mjs` does not exist.

- [ ] **Step 3: Implement constants, atomic JSON writing, and fresh reconciliation**

Create `scripts/reconcile-personal-profile.mjs` with exact managed sources:

```js
export const MANAGED_NPM_PACKAGES = Object.freeze([
  {
    name: "pi-mcp-adapter",
    version: "2.26.0",
    source: "npm:pi-mcp-adapter@2.26.0",
  },
  {
    name: "pi-subagents",
    version: "0.50.0",
    source: "npm:pi-subagents@0.50.0",
  },
  {
    name: "context-mode",
    version: "1.0.169",
    source: "npm:context-mode@1.0.169",
  },
  {
    name: "pi-markdown-preview",
    version: "0.14.1",
    source: "npm:pi-markdown-preview@0.14.1",
  },
  {
    name: "@juicesharp/rpiv-ask-user-question",
    version: "2.6.1",
    source: "npm:@juicesharp/rpiv-ask-user-question@2.6.1",
  },
]);
```

Implement `atomicWrite()` by creating a same-directory temporary file, writing the complete contents, and renaming it over the target. The `finally` block removes only the temporary file created by that call. Implement `reconcileSettings()` to create `agentDir`, default to `{}`, apply the four managed preferences, and write two-space JSON with a trailing newline.

- [ ] **Step 4: Run the focused test and observe GREEN**

Run:

```bash
npm run test:file -- tests/reconcile-personal-profile.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Add failing preservation and idempotency tests**

Add tests with literal fixtures proving:

```ts
const existing = {
  defaultProvider: "personal-provider",
  customSetting: { keep: true },
  packages: [
    "npm:some-public-helper@1.2.3",
    "npm:context-mode@0.9.0",
    "npm:context-mode@0.8.0",
    "git:github.com/jpriverar/pi-config@old-ref",
  ],
};
```

Assertions:

- `defaultProvider` and `customSetting` survive unchanged.
- the unrelated helper remains in its original relative order;
- both old `context-mode` entries collapse to one exact managed source;
- the old Git core source becomes exactly `repoDir`;
- all missing managed packages are appended once;
- a second call returns `{ changed: false, ... }` and leaves `settings.json` byte-identical.

Run the focused test and expect failure because managed package identity/deduplication is not implemented.

- [ ] **Step 6: Implement managed package identity and stable replacement**

Implement helpers with these rules:

```js
function npmPackageName(source) {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4);
  if (spec.startsWith("@")) {
    const slashAt = spec.indexOf("/");
    const versionAt = slashAt === -1 ? -1 : spec.indexOf("@", slashAt + 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.lastIndexOf("@");
  return versionAt > 0 ? spec.slice(0, versionAt) : spec;
}

function isCoreSource(source, repoDir) {
  return (
    source === repoDir ||
    source.startsWith("git:github.com/jpriverar/pi-config@") ||
    source.startsWith("https://github.com/jpriverar/pi-config")
  );
}
```

Walk existing entries once. Replace only the first occurrence of each managed identity, skip duplicates, preserve unrelated entries, then append missing managed sources in declared order.

- [ ] **Step 7: Add failing policy-validation tests**

Add separate tests proving:

- malformed `settings.json` rejects with `Cannot parse personal Pi settings at <path>`;
- a symlinked agent directory rejects before reading settings;
- an unknown relative or absolute local package source rejects with package index and path;
- `npm:`, `git:github.com/`, and `https://github.com/` unknown public entries are preserved;
- an npm source or existing `mcp.json` containing the work marker is rejected;
- the negative sentinel is constructed in tests and implementation as `['data', 'dog'].join('')`, never tracked contiguously.

The work-marker fixture should be built at runtime:

```ts
const workMarker = ["data", "dog"].join("");
const forbiddenSource = `npm:@${workMarker}/private-plugin@1.0.0`;
```

Run the focused test and expect the new cases to fail.

- [ ] **Step 8: Implement `validateProfile()` and call it before mutation**

Validation must:

- use `lstat` to reject an agent-directory symlink;
- parse settings without including raw content or parser text in the error;
- recursively inspect configuration strings for the runtime-constructed work marker;
- reject local package entries other than the exact `repoDir`;
- inspect `mcp.json` only if present and reject malformed JSON or the work marker;
- never inspect runtime transcripts, auth, models, caches, or task data.

Run `validateProfile()` before `mkdir`/write operations in `reconcileSettings()`.

- [ ] **Step 9: Add and pass the atomic-write failure test**

Pass `fileOperations` with a `rename()` implementation that throws `new Error("simulated rename failure")`. Assert:

- `reconcileSettings()` rejects with `Cannot replace personal Pi settings at <path>`;
- an existing settings file remains byte-identical;
- no sibling filename containing `.tmp-` remains.

Implement curated error wrapping without exposing raw file contents or parser diagnostics.

- [ ] **Step 10: Run Task 1 verification**

Run:

```bash
npm run test:file -- tests/reconcile-personal-profile.test.ts
npm run typecheck
npm run format:check
```

Expected: all pass with no changed files beyond the two Task 1 files.

- [ ] **Step 11: Commit Task 1**

```bash
git add scripts/reconcile-personal-profile.mjs tests/reconcile-personal-profile.test.ts
git diff --cached --name-only
git commit -m "[bootstrap] Added profile reconciliation"
```

---

### Task 2: Add shell-block reconciliation, version verification, and CLI

**Files:**

- Modify: `scripts/reconcile-personal-profile.mjs`
- Modify: `tests/reconcile-personal-profile.test.ts`

**Interfaces:**

- Consumes Task 1 exports.
- Produces:
  - `reconcileShell(options: { zshrcPath: string; fileOperations?: FileOperations }): Promise<{ changed: boolean; backupPath?: string }>`
  - `verifyInstalledPackages(options: { agentDir: string; repoDir: string }): Promise<void>`
  - CLI commands:
    - `validate --agent-dir <path> --repo-dir <path>`
    - `settings --agent-dir <path> --repo-dir <path>`
    - `verify --agent-dir <path> --repo-dir <path>`
    - `shell --zshrc <path>`

- [ ] **Step 1: Add failing shell-block tests**

Add tests for:

- missing `.zshrc` creates exactly the marker block from the spec;
- existing content is byte-preserved outside the block;
- rerun returns `changed: false` and is byte-identical;
- an existing valid block is replaced once;
- duplicate start markers, duplicate end markers, or one unmatched marker reject without changing the file;
- a symlinked `.zshrc` rejects;
- a changed file creates `<zshrcPath>.jpriverar-pi-bootstrap.bak` containing the exact prior bytes.

Use the literal expected block:

```ts
const managedBlock = [
  "# >>> jpriverar pi bootstrap >>>",
  'export VOLTA_HOME="$HOME/.volta"',
  'export PATH="$VOLTA_HOME/bin:$PATH"',
  'export BEADS_DIR="$HOME/beads/.beads"',
  "# <<< jpriverar pi bootstrap <<<",
  "",
].join("\n");
```

Run the focused test and observe failure because `reconcileShell` is absent.

- [ ] **Step 2: Implement `reconcileShell()` minimally**

Use exact marker counts, preserve bytes before and after a valid block, create the backup immediately before replacement, and call `atomicWrite()` for both backup and final file. Do not normalize unrelated whitespace or line endings.

Run the focused test and expect all shell-block cases to pass.

- [ ] **Step 3: Add failing installed-version verification tests**

Build a fake `agent/npm/node_modules` tree containing one `package.json` per managed package. Test:

- exact versions and exact managed settings sources pass;
- one mismatched version rejects with `Resolved <name>@<actual>; expected <version>`;
- a missing package rejects with `Managed package is not installed: <name>`;
- a missing local `repoDir` settings source rejects;
- raw package-manager output and package JSON contents are never included in errors.

Run the focused test and observe failure because `verifyInstalledPackages` is absent.

- [ ] **Step 4: Implement `verifyInstalledPackages()`**

For scoped packages, derive paths using `name.split('/')`. Parse each installed `package.json`, compare its `version`, reparse settings, and verify the exact local core and exact npm sources are present once.

- [ ] **Step 5: Add failing CLI tests**

Spawn the reconciler with `process.execPath` and assert:

```ts
const result = spawnSync(process.execPath, [
  reconcilerPath,
  "settings",
  "--agent-dir",
  state.agentDir,
  "--repo-dir",
  state.repoDir,
]);
assert.equal(result.status, 0);
assert.deepEqual(JSON.parse(result.stdout.toString()), { changed: true });
```

Add cases for every command, a missing required flag, and an unknown command. CLI failures must be one-line contextual messages on stderr with exit code 1.

- [ ] **Step 6: Implement the CLI dispatcher**

Guard execution with:

```js
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Profile reconciliation failed",
    );
    process.exitCode = 1;
  });
}
```

Parse only the four declared commands and required flags. Emit one JSON result line on success.

- [ ] **Step 7: Run Task 2 verification**

```bash
npm run test:file -- tests/reconcile-personal-profile.test.ts
npm run typecheck
npm run format:check
```

Expected: all pass.

- [ ] **Step 8: Commit Task 2**

```bash
git add scripts/reconcile-personal-profile.mjs tests/reconcile-personal-profile.test.ts
git diff --cached --name-only
git commit -m "[bootstrap] Added shell profile setup"
```

---

### Task 3: Implement the macOS bootstrap happy path and preflight

**Files:**

- Create: `scripts/bootstrap-macos.sh`
- Create: `tests/bootstrap-macos.test.ts`

**Interfaces:**

- Consumes Task 2 CLI commands.
- Produces executable `scripts/bootstrap-macos.sh` with no required arguments.
- Environment used by tests only:
  - `BOOTSTRAP_REAL_NODE` allows a fake `node` shim to delegate reconciler execution to the test runner's real Node binary.
  - `BOOTSTRAP_COMMAND_LOG` receives deterministic fake-command logs.
- The production path does not require either variable.

- [ ] **Step 1: Create the offline shell-test fixture and failing missing-Homebrew test**

Create `tests/bootstrap-macos.test.ts` following `tests/refresh-superpowers.test.ts`:

- copy the real script and reconciler into a fixture repository whose path contains spaces;
- create a temporary `HOME` and minimal `PATH`;
- create fake executable files with mode `0o755`;
- invoke `/bin/bash <fixture>/scripts/bootstrap-macos.sh`;
- return `{ status, stdout, stderr, commandLog }`.

First test: fake `uname` prints `Darwin`, fake `git` resolves the fixture root, and no `brew` exists. Assert exit 1, stderr contains `Homebrew is required before bootstrapping Pi`, and no `.pi`, `beads`, or `.zshrc` path exists.

Run the focused test and observe failure because the script does not exist.

- [ ] **Step 2: Implement fail-fast platform/Homebrew/repository preflight**

Start `scripts/bootstrap-macos.sh` with:

```bash
#!/bin/bash
set -euo pipefail

fail() {
  printf 'personal Pi bootstrap: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "macOS is required"
command -v brew >/dev/null 2>&1 || fail "Homebrew is required before bootstrapping Pi"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel) || \
  fail "cannot resolve the bootstrap repository"
[ -f "$REPO_ROOT/package.json" ] || fail "repository package.json is missing: $REPO_ROOT"
```

Keep the script executable at mode `0o755`.

Run the missing-Homebrew test and add a non-macOS case; both must pass.

- [ ] **Step 3: Add a failing happy-path command-order test**

Fake commands must append one line to `BOOTSTRAP_COMMAND_LOG`:

```text
brew list --formula volta
brew install volta
brew list --formula beads
brew install beads
volta install node@22.19.0
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
pi install <absolute fixture repo path>
pi install npm:pi-mcp-adapter@2.26.0
...
bd init --init-if-missing --non-interactive --prefix jp
```

The fake `node` prints `v22.19.0` for `--version` and otherwise executes `$BOOTSTRAP_REAL_NODE`. The fake `pi` prints `0.84.1` for `--version`; for `install`, it logs the source and creates the managed installed-package `package.json` fixtures under `$PI_CODING_AGENT_DIR/npm/node_modules`.

Assert the final stdout checklist contains `/login`, `/reload`, and `git pull --ff-only`.

Run the focused test and observe failure after preflight because the orchestrator is incomplete.

- [ ] **Step 4: Implement formula, toolchain, package, Beads, and checklist flow**

Use exact commands:

```bash
brew list --formula volta >/dev/null 2>&1 || brew install volta
brew list --formula beads >/dev/null 2>&1 || brew install beads

export VOLTA_HOME="$HOME/.volta"
export PATH="$VOLTA_HOME/bin:$PATH"
volta install node@22.19.0
npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
```

Set:

```bash
AGENT_DIR="$HOME/.pi/agent"
RECONCILER="$REPO_ROOT/scripts/reconcile-personal-profile.mjs"
export PI_CODING_AGENT_DIR="$AGENT_DIR"
```

Call CLI commands in this order:

1. `validate`;
2. `settings`;
3. `pi install "$REPO_ROOT"`;
4. one `pi install` for each exact npm source in spec order;
5. `settings` again;
6. `verify`;
7. exact `node --version` and `pi --version` checks;
8. `mkdir -p "$HOME/beads"` and run `bd init --init-if-missing --non-interactive --prefix jp` from that directory;
9. `shell`;
10. print checklist and `git rev-parse HEAD`.

Run the happy-path test and expect it to pass with the fixture repository path preserved as one argument.

- [ ] **Step 5: Add and pass no-op formula tests**

Make fake `brew list --formula <name>` succeed. Assert neither `brew install` appears, while all later exact commands still run. This locks rerun behavior without asserting internal shell branches.

- [ ] **Step 6: Add and pass version-mismatch tests**

Make fake `node --version` return `v22.20.0` and fake `pi --version` return `0.84.2` in separate cases. Assert contextual nonzero failures naming expected and actual versions. Do not continue to Beads or `.zshrc` mutation after either mismatch.

- [ ] **Step 7: Run Task 3 verification**

```bash
/bin/bash -n scripts/bootstrap-macos.sh
npm run test:file -- tests/bootstrap-macos.test.ts
npm run test:file -- tests/reconcile-personal-profile.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add scripts/bootstrap-macos.sh tests/bootstrap-macos.test.ts
git diff --cached --name-only
git commit -m "[bootstrap] Added macOS orchestration"
```

---

### Task 4: Add rollback, rerun, and boundary integration coverage

**Files:**

- Modify: `scripts/bootstrap-macos.sh`
- Modify: `tests/bootstrap-macos.test.ts`
- Modify: `scripts/reconcile-personal-profile.mjs` only if integration exposes a contract bug; do not broaden its interfaces.
- Modify: `tests/reconcile-personal-profile.test.ts` only with the corresponding regression test.

**Interfaces:**

- Consumes all Task 1–3 interfaces.
- Produces the final failure/rollback and idempotency behavior required by the spec.

- [ ] **Step 1: Add the failing package-install rollback test**

Seed settings with exact bytes containing an unrelated public package and provider. Configure fake `pi` to fail on the third install. Assert:

- bootstrap exits nonzero and names the failed package operation;
- settings bytes equal the original fixture exactly;
- Beads and `.zshrc` were not touched;
- package-cache files created by earlier fake installs may remain;
- no unrelated home path was accessed.

Run the focused test and observe the settings mismatch.

- [ ] **Step 2: Implement settings snapshot and restoration around package operations**

Before the first `settings` CLI call:

- record whether settings existed;
- copy exact bytes to a `mktemp` file under `${TMPDIR:-/tmp}`;
- wrap both reconciliations, all `pi install` calls, and `verify` in a function used by `if ! reconcile_packages; then ... fi`;
- on failure, restore exact bytes with `cp` if settings existed, otherwise remove only the settings file created by this run;
- remove the temporary snapshot on success or after restoration;
- never remove package caches.

Do not rely on Bash `ERR` trap semantics.

Run the rollback test and expect it to pass.

- [ ] **Step 3: Add failing Beads and shell failure-order tests**

Add separate cases:

- fake `bd` failure leaves verified settings installed but does not write `.zshrc`;
- shell reconciliation failure leaves the existing `.zshrc` unchanged and its backup present;
- an already initialized Beads store still invokes `--init-if-missing` and remains byte-identical in the fixture;
- no remote-related `bd` argument is ever logged.

Run and observe failures in command order or diagnostics.

- [ ] **Step 4: Implement explicit step wrappers and contextual diagnostics**

Use a helper that never prints command output containing configuration content:

```bash
run_step() {
  step=$1
  shift
  "$@" || fail "$step failed"
}
```

Apply it to Homebrew, Volta, npm, Pi, Beads, and reconciler operations. Keep `.zshrc` reconciliation last so earlier failures cannot modify it.

- [ ] **Step 5: Add the full rerun-idempotency test**

Run the bootstrap twice against the same fixture. Snapshot after the first run:

- settings bytes;
- `.zshrc` bytes;
- Beads fixture contents;
- managed package list.

Assert the second run leaves all snapshots byte-identical, contains each managed source once, and emits the same completion checklist. Command execution may repeat; configuration must not change.

- [ ] **Step 6: Add the work-boundary shell integration test**

Seed settings/MCP with the runtime-constructed work marker. Assert preflight exits before `brew install`, Volta, npm, Pi, Beads, or shell mutation. Do not track the marker contiguously in fixtures or assertions.

- [ ] **Step 7: Run Task 4 verification**

```bash
/bin/bash -n scripts/bootstrap-macos.sh
npm run test:file -- tests/bootstrap-macos.test.ts
npm run test:file -- tests/reconcile-personal-profile.test.ts
npm test
npm run typecheck
```

Expected: all pass. If the existing process-timeout test fails once, run that exact test in isolation and use only the project's single permitted full-suite retry; otherwise stop.

- [ ] **Step 8: Commit Task 4**

```bash
git add scripts/bootstrap-macos.sh tests/bootstrap-macos.test.ts
# Add reconciler files only if Task 4 required a tested contract correction.
git diff --cached --name-only
git commit -m "[bootstrap] Hardened reruns and rollback"
```

---

### Task 5: Integrate portability gates and public documentation

**Files:**

- Modify: `scripts/verify-portable.mjs`
- Modify: `tests/portable.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

- Consumes the completed bootstrap and reconciler.
- Produces public setup/update instructions and CI coverage for all bootstrap artifacts.

- [ ] **Step 1: Add the failing reviewed-executable portability test**

In `tests/portable.test.ts`, create a tracked `scripts/bootstrap-macos.sh` fixture with mode `0o755` and assert `verify-portable.mjs` accepts it while still rejecting an unrelated executable under `scripts/`.

Run:

```bash
npm run test:file -- tests/portable.test.ts
```

Expected: FAIL because the new script is not in the authored-executable allowlist.

- [ ] **Step 2: Review the bootstrap executable in `verify-portable.mjs`**

Add exactly `scripts/bootstrap-macos.sh` beside `scripts/refresh-superpowers.sh` in the authored executable allowlist. Do not widen the directory or mode rule.

Rerun `tests/portable.test.ts`; expect PASS.

- [ ] **Step 3: Add failing tracked-bootstrap portability cases**

Add fixtures that construct forbidden private/work sentinels at runtime and insert them into tracked bootstrap docs/scripts. Assert rejection. Add passing fixtures containing:

- `$HOME/.pi/agent`;
- `$HOME/beads/.beads`;
- `git pull --ff-only`;
- the approved public GitHub repository URL;
- placeholder provider instructions without credentials.

Run and observe any missing policy coverage.

- [ ] **Step 4: Extend portability checks only where the failing cases require it**

Keep existing path/credential/host behavior unchanged. Add only the minimum bootstrap-artifact scan needed for the new failing cases, and keep full negative sentinels noncontiguous in tracked code.

- [ ] **Step 5: Update package scripts**

Modify `package.json`:

```json
{
  "scripts": {
    "test:bootstrap": "tsx --test tests/reconcile-personal-profile.test.ts tests/bootstrap-macos.test.ts",
    "format:check": "prettier --check package.json tsconfig.json 'extensions/**/*.ts' 'lib/**/*.ts' 'tests/**/*.{ts,mjs}' 'scripts/**/*.mjs' 'docs/**/*.md' skills/grill-me/SKILL.md skills/thinking-partner/SKILL.md skills/handoff/SKILL.md 'themes/*.json' README.md THIRD_PARTY_NOTICES.md"
  }
}
```

Preserve every existing script and manifest field.

- [ ] **Step 6: Replace README's obsolete bootstrap exclusion with actual setup**

Document this exact initial flow:

```sh
set -euo pipefail
git clone https://github.com/jpriverar/pi-config.git
cd pi-config
./scripts/bootstrap-macos.sh
```

Document:

- Homebrew as the only prerequisite;
- what the script installs and owns;
- any clone path is valid and becomes the local package source;
- provider-neutral `/login` completion;
- independent personal Beads store;
- safe rerun behavior and conflict refusal;
- update via `git pull --ff-only` then `/reload`;
- rollback by checking out a prior repository commit and reloading;
- exact runtime/package versions;
- the generated npm caret-range caveat and final resolved-version verification;
- explicit exclusion of work configuration, copied history, credentials, providers, MCP setup, and Beads remotes.

Remove the sentence claiming the macOS bootstrap is intentionally not included.

- [ ] **Step 7: Run focused documentation and portability verification**

```bash
npm run test:bootstrap
npm run test:file -- tests/portable.test.ts
npm run verify:portable
npm run format:check
/bin/bash -n scripts/bootstrap-macos.sh
```

Expected: all pass.

- [ ] **Step 8: Run the complete release gate**

```bash
set -euo pipefail
npm test
npm run typecheck
npm run format:check
npm run verify:portable
npm run licenses:check
npm run verify:smoke
npm run verify:skills
git diff --check
git status --short
```

Expected:

- all test suites pass;
- no formatter, type, portability, license, smoke, or skill failures;
- status lists only Task 5 files before staging.

- [ ] **Step 9: Independently review the complete branch**

Request a fresh reviewer against the spec and branch diff. Require explicit findings for:

- settings/runtime ownership;
- command quoting and Bash 3.2 compatibility;
- failure rollback;
- profile and shell idempotency;
- credential/work-data boundaries;
- test isolation and no network access;
- portability allowlist narrowness;
- README accuracy.

Address every blocker/high finding with a new failing regression test before changing implementation, then rerun the complete release gate.

- [ ] **Step 10: Commit Task 5**

```bash
git add README.md package.json scripts/verify-portable.mjs tests/portable.test.ts
git diff --cached --name-only
git commit -m "[bootstrap] Documented personal setup"
```

- [ ] **Step 11: Final branch evidence**

Run:

```bash
git log --oneline --decorate -6
git status --short --branch
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
```

Record:

- design and implementation-plan commits;
- implementation commits by task;
- full verification output;
- independent review result;
- any residual risk, especially Homebrew formula drift and Pi's generated npm caret ranges.
