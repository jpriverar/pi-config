# Legacy Task Lifecycle Migration Design

## Goal

Adopt every task in the shared Beads store that lacks valid `piLifecycle`
metadata without inventing execution ownership, resources, dependencies,
checks, or completion evidence.

The migration addresses legacy tasks whose native `in_progress` or `blocked`
status is otherwise rendered without lifecycle authority. Native statuses remain
valid storage projections for managed Active and Waiting tasks.

## Scope

The audited store contains 280 tasks:

- 12 already lifecycle-managed tasks, which are excluded;
- 268 legacy tasks, which are migration targets.

The target inventory is:

- 230 closed;
- 24 open and ready;
- 8 `in_progress` without trusted execution ownership;
- 3 `blocked` without structured lifecycle conditions;
- 3 deferred.

No target has malformed lifecycle metadata. No legacy open target currently has
an unresolved native blocker.

## Default mapping

| Legacy state                           | Lifecycle phase    | Native status after migration |
| -------------------------------------- | ------------------ | ----------------------------- |
| open and ready                         | Actionable         | open                          |
| open with an unresolved native blocker | Waiting/dependency | open                          |
| `in_progress`                          | Actionable         | open                          |
| `blocked` without an approved override | Actionable         | open                          |
| deferred                               | Deferred           | deferred                      |
| closed                                 | Done               | closed                        |

A legacy closed task receives the existing model disposition:

```text
completed: legacy closed issue
```

The disposition carries no fabricated evidence artifacts.

Every adopted lifecycle record has:

- no execution lease;
- no worktree resources;
- no inferred artifacts or checks except an approved override;
- a deterministic migration transition;
- preservation of labels, descriptions, notes, comments, native dependency
  edges, and unrelated metadata.

## Approved blocked-task overrides

### `jp-hyk8`

`jp-hyk8` explicitly names `jp-sq7f` as its blocker. Add the native `blocks`
edge with `jp-sq7f` as blocker and `jp-hyk8` as dependent, then adopt
`jp-hyk8` as dependency-Waiting.

### `jp-sq7f`

`jp-sq7f` exists to rerun endpoint Fix Analysis staging QA. Its old notes name
prerequisites but no current authoritative task or check, and those notes may be
stale. Adopt it as Actionable instead of inventing a waiting condition.

### `jp-ida`

`jp-ida` records implemented and pushed work in
`https://github.com/ddoghq/web-ui/pull/3393`. The PR is currently open, dirty,
and review-required. Attach that PR as a deliverable artifact and adopt the task
as check-Waiting with a GitHub pull-request check in `action_required`.

The check uses `onSatisfied: actionable`; merge satisfaction does not
implicitly complete the remaining rollout-validation goal.

## Expected result

For the 268 migrated tasks:

- 33 Actionable;
- 2 Waiting;
- 3 Deferred;
- 230 Done.

Their native projections become:

- 34 open: 33 Actionable plus one dependency-Waiting task;
- 1 blocked: the typed check-Waiting task;
- 3 deferred;
- 230 closed;
- 0 legacy `in_progress`.

Existing managed task projections remain unchanged.

## Execution mechanism

Use a one-off TypeScript migration runner stored outside Git under:

```text
~/beads/migrations/<timestamp>/
```

The runner imports the existing lifecycle model and store from the task-owned
`pi-config` worktree. It does not add a general product migration command.

The run directory contains:

- `migrate-lifecycle.ts`: reviewed one-off runner;
- `migrate-lifecycle.test.ts`: focused behavior tests;
- `plan.json`: exact targets, source snapshot, proposed mappings, overrides,
  and plan hash;
- `before.jsonl`: complete pre-migration `bd export`;
- `journal.jsonl`: append-only mutation journal;
- `result.json`: final counts, failures, and verification results.

Dry-run is the default. Live apply requires both `--apply` and the exact reviewed
plan hash.

## Preflight

Before any live write, reread all targets and refuse the entire run if any
planned task has changed in one of these ways:

- lifecycle metadata appeared or became invalid;
- native status changed;
- `updated_at` changed;
- the target disappeared;
- an unplanned target entered the legacy set;
- an approved override no longer matches its expected source state.

Already-managed tasks are never silently accepted as successful targets.

## Mutation protocol

The migration uses the existing lifecycle file-operation lock. Each task write
is a full metadata read/merge/write followed by read-back validation.

Operation IDs are derived from the plan hash and task ID, making an interrupted
run safe to resume.

Apply uses two checkpoints:

1. migrate the 38 non-closed tasks, including the approved overrides;
2. migrate the 230 closed historical tasks.

Checkpoint 2 starts only after checkpoint 1 verification succeeds. The runner
stops on the first failure and does not conceal contradictions or provider
output in errors.

## Journal and recovery boundary

Before apply, export all issues to `before.jsonl`. The journal records the exact
original status and metadata before each mutation, the deterministic operation
ID, and verified after-state.

The runner does not automate rollback. Beads metadata deletion and same-state
status writes have side effects that make generic compensating writes less safe
than the forward migration. On partial failure, stop and inspect the completed
prefix. Resume only after review through the same deterministic operations.
Any restoration is a separate, explicitly approved manual recovery using the
export and Beads history.

## Verification

Before live mutation, run the complete migration flow against an isolated
fixture and verify:

- dry-run creates no writes;
- apply uses the reviewed plan hash;
- stale plans fail before mutation;
- default mappings are correct;
- all three overrides are correct;
- rerunning after success is idempotent;
- failure stops later writes;
- the journal and export preserve the evidence needed for reviewed recovery.

After each live checkpoint, reread the store and assert:

- every target decodes and passes lifecycle validation;
- no target owns execution or resources;
- unrelated issue fields and metadata are unchanged;
- only the approved dependency edge was added;
- only `jp-ida` gained the approved PR artifact/check;
- journal successes exactly match changed tasks;
- the migration report contains no remaining legacy targets after completion;
- lifecycle views and the session task header remain coherent.

Live apply requires a separate approval after presenting the exact dry-run
counts and plan hash.
