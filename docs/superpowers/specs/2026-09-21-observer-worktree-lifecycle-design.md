# Observer Worktree Lifecycle Design

**Date:** 2026-09-21

## Goal

Associate ordinary `worktree_pool` acquire and release operations with the session's Active task without requiring lifecycle-specific behavior from the worktree tool.

## Boundary

`worktree_pool` owns its public arguments, pool allocation, and result shape. Task lifecycle observes Pi's `tool_call` and `tool_result` events. It does not inject hidden arguments, preassign pool identities, or require the worktree extension to import task-lifecycle code.

The worktree tool independently normalizes provider-generated empty placeholders before its existing action-specific validation. Empty fields irrelevant to the selected action are treated as absent. Non-empty fields irrelevant to the action remain invalid.

## Acquire flow

1. On `tool_call`, task lifecycle verifies that the session owns exactly one Active task.
2. It records an in-memory correlation from `toolCallId` to the task and the validated repository/branch request. It performs no lifecycle metadata mutation and does not alter the tool input.
3. The unchanged worktree tool allocates a claim and returns its ordinary result.
4. On successful `tool_result`, task lifecycle validates the receipt, resolves the matching pool observation, and records an Active worktree resource on the correlated task.
5. On a tool error, task lifecycle drops the in-memory correlation and records no resource.

If Pi exits after pool allocation but before `tool_result`, the task may temporarily lack the resource association. This design deliberately defers automatic interrupted-acquire recovery; `worktree_pool list`, `repair`, and explicit lifecycle reconciliation remain available.

## Release flow

1. On `tool_call`, task lifecycle identifies the task already associated with the public claim ID and persists `release_pending`.
2. It records the prepared release context in memory by `toolCallId` without altering the worktree input.
3. On a successful release receipt, it marks the resource `released`.
4. Tool errors or release refusal preserve `release_pending` for explicit retry or reconciliation.

## Compatibility

Existing deterministic service helpers and legacy `acquiring` resources remain readable for compatibility, but ordinary tool acquisition no longer uses them. Waiting and Done transitions continue to release associated Active resources before relinquishing ownership.

## Security and failure handling

- Protected acquire calls still fail closed when Active-task ownership cannot be verified.
- Non-empty wrong-action worktree arguments remain rejected.
- Tool receipts and task metadata remain untrusted and are validated before mutation.
- Finalization errors expose only curated task and claim identifiers.
- Correlations are process-local and bounded by outstanding tool calls; entries are deleted when results arrive.
