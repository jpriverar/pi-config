# Session Scope Migration After Project Rename

## Goal

When `/project rename` changes a workstream, sessions scoped to the old name repair themselves the next time Pi starts that session. The invoking session still updates immediately.

## Non-goals

- Mutating inactive session JSONL files during rename.
- Sending cross-process events to other running Pi processes.
- Seeding mappings for renames that happened before this feature.
- Migrating sessions unrelated to the renamed workstream.

## Why lazy migration

`/project` updates the active session by appending a `jp-project-scope` custom entry and calling `pi.setSessionName()`. Pi exposes `SessionManager.open()` for other session files, but session persistence has no cross-process lock. Opening and appending to another session can race with its owning Pi process and create divergent branches.

Instead, record the rename centrally and let each session perform the existing `/project` updates through its own active `SessionManager` on `session_start`. A concurrently running session repairs itself on `/reload`; an inactive session repairs itself when resumed, opened, or forked.

## Rename registry

Store one versioned JSON value under the Beads custom configuration key:

```text
custom.pi-project-renames
```

```json
{
  "version": 1,
  "aliases": {
    "function-generator": "recommendations-lab"
  }
}
```

Alias keys are lowercase workstream names. Values preserve the canonical target spelling. An absent configuration value decodes as an empty version-1 registry. The decoder rejects malformed non-empty values, unsupported versions, empty names, invalid labels, and non-string values.

Using Beads configuration keeps the registry beside the task store and avoids a second mutable user-state location. No historical mapping is seeded for `function-generator`; JP already repaired the only affected session manually.

## Recording a rename

Before mutating task labels, read and decode the registry as a preflight. If it is unavailable or malformed, abort the rename without changing tasks.

After task labels have been rewritten and fully verified:

1. Re-read the latest registry so a concurrent completed rename is not overwritten by the earlier snapshot.
2. Remove the alias whose key is the new target name. This permits reusing a historical name without creating a cycle.
3. Set the old lowercase name to the canonical new name. Case-only renames are represented by a key whose value differs only in spelling.
4. Write the complete versioned registry with `bd config set`.
5. Read it back and verify the intended alias resolves correctly.

Existing chains remain valid. For example, `A → B` followed by `B → C` lets old `A` sessions resolve through `B` to `C`. Alias resolution detects cycles and uses a bounded traversal.

Task relabeling remains authoritative. If registry persistence fails after a verified task rename, do not attempt a risky rollback. Update the invoking session, then warn that the project was renamed but other sessions cannot migrate automatically. Do not emit the ordinary success notification.

## Session startup behavior

On every `session_start` reason:

1. Resolve the session's persisted project scope.
2. Read the rename registry.
3. Follow aliases case-insensitively to a canonical target.
4. If the target differs from the stored scope by name or casing:
   - append a new version-1 `jp-project-scope` entry;
   - regenerate the session name with its existing session ID.
5. Otherwise leave the session untouched.

Both explicit project metadata and legacy display-name scopes may migrate when they exactly match a known alias. An unrelated manual session name does not change unless it matches a recorded workstream rename.

The existing fork behavior remains: a fork with a current explicit scope regenerates its session-ID-derived name even when no alias migration is required.

Registry read or decode failures fail closed: the session scope is left unchanged and Pi shows a curated warning without exposing process output or configuration contents.

## Concurrency and failure boundaries

- No session file is modified by another Pi process.
- The registry is a small read-modify-write value. Concurrent project renames can race, so the writer verifies its mapping after persistence and reports failure rather than claiming automatic migration.
- A running session in another process does not update live; `/reload` triggers migration safely in that process.
- Alias cycles or malformed registry data never mutate a session.

## Tests

- Registry decoding, chained resolution, case-only aliases, historical-name reuse, malformed data, and cycle detection.
- Beads client config get/set command construction and curated errors.
- Rename writes and verifies the alias only after task verification.
- Registry write failure updates the invoking session but produces the partial-success warning.
- Startup/resume/reload migrates explicit and legacy scopes and regenerates names.
- Unrelated and already-canonical sessions remain unchanged.
- Fork naming behavior remains intact.
- Focused suites, package smoke, full tests, typecheck, and formatting remain green.
