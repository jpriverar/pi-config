# Lifecycle-Safe Task Tool Surface

**Status:** Approved design

**Task:** `jp-akhu`

**Date:** 2026-09-21

## Goal

Expose one agent-facing `task_*` mutation surface. Remove the older issue mutation tools so agents cannot bypass lifecycle ownership, resource cleanup, waiting conditions, or close dispositions.

This is a consolidation, not a lifecycle redesign.

## Public tools

Keep the existing lifecycle tools:

- `task_claim`
- `task_attach_artifact`
- `task_wait`
- `task_reconcile`
- `task_close`
- `task_reopen`

Add four tools:

### `task_create`

Create an explicitly approved work item using the current `file_issue` fields:

- `title`
- `why`
- optional `workstream`
- `needs_jp`

New tasks receive Actionable lifecycle metadata at creation instead of waiting for later adoption.

### `task_update`

Modify labels without changing lifecycle state:

- `add_labels`
- `remove_labels`

The schema and service reject status, phase, ownership, waiting, resource, artifact, disposition, and arbitrary metadata updates. More safe fields may be added later when there is a demonstrated need.

`task_update` is an administrative operation and does not require an Active execution lease.

### `task_log`

Append one plain-text entry to the task's native Beads comment stream.

- Entries are append-only.
- The tool does not edit notes or lifecycle metadata.
- The current session must own that Active task.
- Typed journal entries and additional presentation behavior are out of scope.

### `task_defer`

Move the current session's Active task to the existing Deferred phase.

- Require a reason.
- Release associated worktrees before transitioning.
- Refuse the transition if cleanup fails.
- Clear execution ownership only after cleanup succeeds.

Scheduled deferral and automatic wake-up are out of scope.

## Retired tools

Stop registering these agent-facing tools:

- `file_issue`
- `update_issue`
- `close_issue`

Their lower-level Beads operations may remain internal implementation details. Prompts, tests, and package contracts must reference only the `task_*` surface.

After moving its work-state presentation behavior, delete the entire `extensions/jp-workflow` extension and remove it from the package manifest. Preserve its visible startup table, scoped hidden task context, and post-compaction context reinjection inside a focused module registered by `task-lifecycle`.

Existing legacy tasks do not require a bulk rewrite. They enter managed execution through the existing claim/adoption path. `task_update` may modify their labels without adopting them. A legacy task must be claimed before it can be logged, deferred, waited, or manually closed.

## Working on Waiting tasks

An unresolved condition blocks successful completion; it does not prohibit useful work.

`task_claim` may therefore move either Actionable or Waiting work to Active. When claiming Waiting work:

- preserve its native dependency blockers;
- preserve its typed check and waiting reason;
- create the execution lease for the current session;
- project the native status to `in_progress`.

The existing lifecycle metadata shape is sufficient. Validation changes to permit an Active task to retain its existing waiting condition; no metadata version or bulk migration is introduced.

`task_wait` moves Active work back to Waiting. If the retained condition is still unresolved, the caller does not need to restate it. If no condition exists, the caller must provide a dependency or typed check as today.

Reconciliation may update the retained condition while the task is Active, but must not revoke ownership or automatically close work under an active agent.

## Completion rule

`task_close(kind="completed")` refuses to close while the task has an unresolved native blocker or typed check.

`cancelled` and `superseded` remain valid with unresolved conditions because those dispositions intentionally abandon the acceptance path.

All close dispositions continue releasing associated worktrees before changing task state.

## Implementation boundaries

- Extend `lib/task-lifecycle` store, model, and service methods rather than adding a second task subsystem.
- Register all public mutation tools in `extensions/task-lifecycle`.
- Move the work-state renderer and hooks into a focused module under `extensions/task-lifecycle`; keep `index.ts` as the composition boundary.
- Delete `extensions/jp-workflow` and remove its package, smoke-test, and manifest registrations.
- Extend task-tool classification for `task_log` and `task_defer` same-task ownership.
- Keep `task_update` lifecycle-neutral and field-whitelisted.
- Use native Beads comments for `task_log`.
- Continue passing the explicit Beads store path to every command.

## Verification

Focused tests must cover:

1. managed creation through `task_create`;
2. label-only `task_update` and rejection of lifecycle fields;
3. same-Active-task enforcement and native comment append for `task_log`;
4. resource cleanup and ownership clearing for `task_defer`;
5. claiming Waiting dependency and check tasks without losing their conditions;
6. returning Active work to a retained Waiting condition;
7. completed-close refusal with unresolved conditions;
8. cancelled and superseded close with unresolved conditions;
9. unchanged startup rendering, scoped hidden context, and post-compaction reinjection after relocation;
10. absence of retired tools and the `jp-workflow` extension from registration and package contracts;
11. existing lifecycle, worktree, adapter, manifest, portability, formatting, typecheck, and repository test gates.

## Rollout

Implement and verify under `jp-akhu` in its isolated worktree. Update the installed package and reload Pi before live testing the new registration surface. Use the new tools to exercise creation-independent metadata, journal, Waiting-to-Active, Active-to-Waiting, completion refusal, and final close behavior.

Pushing remains a separate explicit decision.
