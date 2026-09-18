# Ordinary Worktree Lifecycle Coordination

**Status:** Approved by JP on 2026-09-18

**Work item:** `jp-fudp`

## Goal

Make this the only normal worktree flow:

```text
task_claim → worktree_pool acquire/release → task_wait or task_close
```

Remove the public `task_worktree_acquire` and `task_worktree_release` tools. The pool core remains task-agnostic.

## Acquire

The task-lifecycle extension intercepts `worktree_pool acquire` before execution:

1. Resolve Active tasks owned by the current Pi session.
2. Block unless exactly one exists.
3. Persist an `acquiring` resource with the tool-call operation ID and generated `claimId` and `pathId`.
4. Inject those private identities into the already-validated pool call.
5. Let the ordinary pool tool acquire the worktree.
6. On a successful `tool_result`, verify the receipt and save the path and HEAD as an `active` resource.

Persisting identities before pool mutation preserves deterministic recovery if Pi stops before result handling.

## Release

The lifecycle extension intercepts `worktree_pool release`:

1. Find the task associated with the claim.
2. For an associated claim, require the same task to be Active for this session and persist `release_pending`.
3. Let the ordinary pool tool release it.
4. On a successful result, mark the resource `released`.

Unassociated legacy claims remain directly releasable as a recovery path. Ambiguous associations fail closed.

## Waiting and closing

`task_wait` and `task_close` release all tracked worktrees before changing phase. No separate manual release is normally required.

If a worktree is dirty, occupied, contradictory, or otherwise cannot be released:

- the transition fails;
- the task stays Active;
- the resource remains recorded;
- the error identifies the task and claim and explains that the worktree must be made releasable.

Pending `acquiring` or `release_pending` operations must be reconciled before entering Waiting or Done.

## Recovery and errors

Protected calls fail closed when Active ownership or resource association cannot be verified. Errors expose bounded identifiers, never raw task or provider output.

Reconciliation uses the persisted claim identity:

- an `acquiring` record plus one matching pool claim becomes `active`;
- a `release_pending` record with no matching pool claim becomes `released`;
- missing, multiple, or contradictory evidence remains explicit for retry or repair.

No timers, watchers, or background reconciliation are added.

## Implementation and verification

Expected changes are limited to the task-lifecycle service and hooks, the worktree-pool adapter, their focused tests, and `docs/task-lifecycle.md`. The existing resource metadata states and identifiers are reused.

Tests must prove:

- unattached acquire is blocked and attached acquire is coordinated;
- intent is persisted before pool mutation;
- successful results finalize acquire and release metadata;
- failures retain recoverable pending state;
- Waiting and Done cannot retain worktrees;
- unassociated release, list, and repair remain available;
- both public `task_worktree_*` tools are gone;
- the pool core remains task-agnostic.
