# Session Scope Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically repair persisted Pi session project scopes after `/project rename` records a workstream rename.

**Architecture:** Store a versioned rename registry in Beads custom configuration and resolve it lazily from each session's own `session_start` handler. Reuse the existing `jp-project-scope` append and generated-name behavior; never mutate another process's session file.

**Tech Stack:** TypeScript, Node test runner, Pi extension API, Beads CLI/config, real Pi package smoke.

**Spec:** `docs/superpowers/specs/2026-08-24-session-scope-migration-design.md`

## Global Constraints

- Do not mutate inactive session JSONL files or add cross-process IPC.
- Do not seed mappings for renames that happened before this feature.
- A concurrently running session repairs only on `/reload` or a later resume.
- Registry key is exactly `custom.pi-project-renames`.
- Registry schema version is exactly `1`.
- Alias matching is case-insensitive; target spelling is preserved.
- Task relabeling remains authoritative; never roll it back because registry persistence failed.
- Never expose Beads stderr, config contents, or task metadata in error notifications.
- Follow TDD for every behavior change.

---

### Task 1: Versioned Project Rename Registry

**Files:**
- Create: `lib/project-renames.ts`
- Create: `tests/project-renames.test.ts`
- Modify: `extensions/tasks-overlay/index.ts` to consume the shared name validator instead of its local constants/helper

**Interfaces:**
- Consumes: no project-local interfaces.
- Produces:
  - `PROJECT_RENAMES_CONFIG_KEY: "custom.pi-project-renames"`
  - `ProjectRenameRegistry = { version: 1; aliases: Record<string, string> }`
  - `emptyProjectRenameRegistry(): ProjectRenameRegistry`
  - `decodeProjectRenameRegistry(value: unknown): ProjectRenameRegistry`
  - `encodeProjectRenameRegistry(registry: ProjectRenameRegistry): string`
  - `resolveProjectRename(registry: ProjectRenameRegistry, workstream: string): string | undefined`
  - `recordProjectRename(registry: ProjectRenameRegistry, from: string, to: string): ProjectRenameRegistry`
  - `validateProjectName(input: string): { ok: true; value: string } | { ok: false; message: string }`

- [ ] **Step 1: Install dependencies and establish the baseline**

Run:

```bash
cd /Users/jp.riveraruiz/dd/pi-config-jp-8400
npm ci
npm run test:file -- extensions/tasks-overlay/index.test.ts tests/beads.test.ts
```

Expected: existing focused tests pass before new tests are added.

- [ ] **Step 2: Write failing registry tests**

Create `tests/project-renames.test.ts` with focused tests equivalent to:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeProjectRenameRegistry,
  emptyProjectRenameRegistry,
  recordProjectRename,
  resolveProjectRename,
} from "../lib/project-renames.js";

test("an absent config value decodes as an empty versioned registry", () => {
  assert.deepEqual(decodeProjectRenameRegistry(""), {
    version: 1,
    aliases: {},
  });
});

test("rename chains resolve to the latest canonical target", () => {
  const registry = {
    version: 1 as const,
    aliases: { alpha: "Beta", beta: "Gamma" },
  };
  assert.equal(resolveProjectRename(registry, "ALPHA"), "Gamma");
});

test("case-only aliases resolve once without becoming cycles", () => {
  assert.equal(
    resolveProjectRename(
      { version: 1, aliases: { alpha: "ALPHA" } },
      "alpha",
    ),
    "ALPHA",
  );
});

test("cycles fail closed", () => {
  assert.equal(
    resolveProjectRename(
      { version: 1, aliases: { alpha: "beta", beta: "alpha" } },
      "alpha",
    ),
    undefined,
  );
});

test("reusing a historical target removes the cycle-forming alias", () => {
  const before = { version: 1 as const, aliases: { alpha: "Beta" } };
  assert.deepEqual(recordProjectRename(before, "Beta", "Alpha"), {
    version: 1,
    aliases: { beta: "Alpha" },
  });
});
```

Also test malformed versions, uppercase alias keys, invalid target names, invalid JSON strings, comma/control/whitespace validation, the 117-code-point name limit, immutable return values, and JSON encode/decode round trips.

- [ ] **Step 3: Run the registry tests to verify RED**

Run:

```bash
npm run test:file -- tests/project-renames.test.ts
```

Expected: FAIL because `lib/project-renames.ts` does not exist.

- [ ] **Step 4: Implement the minimal registry module**

Create `lib/project-renames.ts` with immutable registry construction. `resolveProjectRename` must track lowercase keys in a `Set`, return the canonical value immediately when a case-only alias points back to the same lowercase key, and return `undefined` on a multi-key cycle. `recordProjectRename` must copy aliases, delete `to.toLowerCase()`, then set `from.toLowerCase()` to the canonical target.

Move the existing project-name validation behavior from `extensions/tasks-overlay/index.ts` into this module without changing its messages or accepted names. Replace the local validator import in the extension.

- [ ] **Step 5: Run registry and existing rename tests to verify GREEN**

Run:

```bash
npm run test:file -- tests/project-renames.test.ts extensions/tasks-overlay/index.test.ts
```

Expected: all tests pass and existing rename validation behavior is unchanged.

- [ ] **Step 6: Commit the registry unit**

```bash
git add lib/project-renames.ts tests/project-renames.test.ts extensions/tasks-overlay/index.ts
git diff --cached --name-only
git commit -m '[project] Added rename registry'
```

Expected staged files: exactly the three paths above.

---

### Task 2: Beads Registry Persistence

**Files:**
- Modify: `lib/beads.ts`
- Modify: `tests/beads.test.ts`

**Interfaces:**
- Consumes: `PROJECT_RENAMES_CONFIG_KEY`, `ProjectRenameRegistry`, `decodeProjectRenameRegistry()`, and `encodeProjectRenameRegistry()` from Task 1.
- Produces additions to `BeadsClient`:
  - `getProjectRenameRegistry(): Promise<BeadsResult<ProjectRenameRegistry>>`
  - `setProjectRenameRegistry(registry: ProjectRenameRegistry): Promise<BeadsResult<void>>`

- [ ] **Step 1: Write failing Beads client tests**

Add tests to `tests/beads.test.ts` that assert:

```typescript
const client = createBeadsClient(fake.exec, { env: { BEADS_DIR: store } });
const result = await client.getProjectRenameRegistry();
```

uses exact argv:

```typescript
[
  "config",
  "get",
  "custom.pi-project-renames",
  "--json",
  "--db",
  store,
]
```

and decodes these stdout envelopes:

```json
{"key":"custom.pi-project-renames","schema_version":1,"value":""}
```

```json
{"key":"custom.pi-project-renames","schema_version":1,"value":"{\"version\":1,\"aliases\":{\"alpha\":\"Beta\"}}"}
```

Add a set test asserting exact argv:

```typescript
[
  "config",
  "set",
  "custom.pi-project-renames",
  '{"version":1,"aliases":{"alpha":"Beta"}}',
  "--json",
  "--db",
  store,
]
```

Add malformed-envelope, malformed-registry, missing-CLI, nonzero-exit, and no-stderr-leak tests using the existing curated `BeadsResult` style.

- [ ] **Step 2: Run Beads tests to verify RED**

Run:

```bash
npm run test:file -- tests/beads.test.ts
```

Expected: FAIL because the two `BeadsClient` methods do not exist.

- [ ] **Step 3: Implement registry get/set methods**

Extend `BeadsClient` and `createBeadsClient()`. The get decoder must require an object with a string `value`, then call `decodeProjectRenameRegistry(value)`. The set method must call the existing curated execution path with the encoded registry and must not parse or expose command output.

- [ ] **Step 4: Run focused client tests to verify GREEN**

Run:

```bash
npm run test:file -- tests/project-renames.test.ts tests/beads.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 5: Commit the persistence unit**

```bash
git add lib/beads.ts tests/beads.test.ts
git diff --cached --name-only
git commit -m '[project] Persisted rename aliases'
```

Expected staged files: exactly `lib/beads.ts` and `tests/beads.test.ts`.

---

### Task 3: Rename Recording and Lazy Session Repair

**Files:**
- Modify: `extensions/tasks-overlay/index.ts`
- Modify: `extensions/tasks-overlay/index.test.ts`
- Modify: `tests/pi-smoke.ts`

**Interfaces:**
- Consumes: registry helpers from Task 1 and Beads client methods from Task 2.
- Produces: `/project rename` registry preflight/write/read-back verification and automatic scope migration from the `session_start` handler.

- [ ] **Step 1: Write failing rename-registry ordering tests**

Extend the tasks-overlay harness to simulate `bd config get/set`, retaining the registry value between calls. Add tests proving:

1. Registry read/decode failure occurs before confirmation and before `bd update`.
2. Successful task verification causes a latest-registry re-read, `recordProjectRename(old, next)`, config write, and read-back verification.
3. Registry write or verification failure still appends the invoking session's new scope/name, emits one warning stating that other sessions cannot migrate automatically, and does not emit ordinary success.
4. Task verification failure never writes the registry.
5. A nonzero task update that nevertheless verifies still records the registry.

Run:

```bash
npm run test:file -- extensions/tasks-overlay/index.test.ts
```

Expected: the new tests fail because rename does not read or persist the registry.

- [ ] **Step 2: Implement rename registry persistence**

In `renameProject()`:

- preflight `getProjectRenameRegistry()` after name/collision validation and before confirmation;
- abort with a curated warning if preflight fails;
- after task verification, fetch the latest registry again;
- write `recordProjectRename(latest, selected.project.name, next)`;
- read back and require `resolveProjectRename(saved, selected.project.name) === next`;
- always repair the invoking session when it matched the old scope;
- emit normal success only when registry persistence verifies; otherwise emit the partial-success warning.

- [ ] **Step 3: Write failing session-start migration tests**

Add tests for `session_start` reasons `startup`, `resume`, `reload`, and `fork` using registry `alpha → Beta`. Assert an explicit `alpha` scope appends `Beta` and names the session `Beta-<suffix>`. Add tests proving:

- a legacy exact display-name scope migrates and becomes explicit;
- unrelated and already canonical scopes do not append entries;
- malformed/cyclic registry data leaves scope untouched and warns;
- the existing fork-with-current-explicit-scope naming behavior still works without an alias;
- non-fork canonical startup/resume/reload remains a no-op.

Run:

```bash
npm run test:file -- extensions/tasks-overlay/index.test.ts
```

Expected: new migration tests fail before the handler is updated.

- [ ] **Step 4: Implement lazy migration in `session_start`**

Resolve the current session project first. If there is no workstream, return without a Beads command. Otherwise load the registry, resolve aliases, and call the same `persistSessionProject()` plus `generateSessionProjectName()` path used by `/project` when the canonical target differs by spelling. On cycle/read/decode failure, leave the session untouched and notify with curated text. Preserve the existing fork naming branch for an already-canonical explicit scope.

- [ ] **Step 5: Update the real package-smoke fake Beads CLI**

Teach `tests/pi-smoke.ts`'s fake `bd` implementation to support:

```text
bd config get custom.pi-project-renames --json
bd config set custom.pi-project-renames <json> --json
```

The default config value is the empty registry. Keep it in the fake store state so package smoke exercises startup without provider calls or `extension_error`. Do not add broad TUI automation for rename.

- [ ] **Step 6: Run focused and package integration tests**

Run:

```bash
npm run test:file -- tests/project-renames.test.ts tests/beads.test.ts extensions/tasks-overlay/index.test.ts
npm run verify:smoke
npm run typecheck
```

Expected: all focused tests, real Pi package smoke, and typecheck pass.

- [ ] **Step 7: Commit the integration unit**

```bash
git add extensions/tasks-overlay/index.ts extensions/tasks-overlay/index.test.ts tests/pi-smoke.ts
git diff --cached --name-only
git commit -m '[project] Migrated renamed session scopes'
```

Expected staged files: exactly the three paths above.

---

### Task 4: Full Verification and Review

**Files:**
- Verify only unless review identifies a scoped correction.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: verified branch ready for JP's integration decision.

- [ ] **Step 1: Run the full verification matrix**

```bash
npm run test:file -- tests/project-renames.test.ts tests/beads.test.ts extensions/tasks-overlay/index.test.ts
npm run verify:smoke
npm test
npm run typecheck
npm run format:check
```

Expected: zero failures, no `extension_error`, and all files formatted.

- [ ] **Step 2: Inspect scope and staged state**

```bash
git diff --check
git status --short
git diff --stat origin/main
git diff --cached --name-only
```

Expected: only planned files plus the approved spec/plan are changed or committed; nothing remains staged unintentionally.

- [ ] **Step 3: Request independent review**

Review against `docs/superpowers/specs/2026-08-24-session-scope-migration-design.md`, focusing on cross-process safety, alias-chain/cycle correctness, registry mutation ordering, partial-success UX, startup reasons, preserved fork semantics, fake-Beads fidelity, and no secret/process-output leakage.

- [ ] **Step 4: Apply only approved scoped corrections and re-run verification**

For each valid finding, add a failing regression test, make the smallest correction, and rerun the full matrix from Step 1. Stop for JP if a correction requires direct inactive-session writes, cross-process IPC, a second mutable state store, or task-label rollback.
