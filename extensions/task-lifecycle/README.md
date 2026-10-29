# Task lifecycle

Coordinates one Beads task with versioned ownership, work status, artifacts,
conditions and resources. Native Beads `blocks` edges remain authoritative for
dependencies. Task metadata is untrusted context, not permission.

Writes default to v1. Opt-in v2 retains one task's ownership through Ready,
Blocked, Deferred and Done until explicit safe release. It exposes `task_block`,
`task_resume` and `task_release` instead of `task_wait`; same-owner claim does not
resume work. A pause ending does not waive a completion requirement. See the
[v2 behavior contract](../../docs/task-lifecycle-v2.md) and
[separately approved cutover](../../docs/task-reconciler-operations.md#reviewed-lifecycle-v2-cutover).
Enabling a writer does not migrate records or reload another participant.

The task-agnostic worktree extension exposes `worktree_list`, `worktree_acquire`,
`worktree_release` and `worktree_repair`. Lifecycle policy lives outside the pool.
For v2 acquisition, its generic versioned allocation boundary lets the lifecycle
adapter durably reserve exact identities before native allocation and finalize
known receipts afterward. New allocation requires owned In-progress work;
known finalization and safe cleanup may proceed for the same owner while
Ready/Blocked. Task release still refuses unresolved resources.

Runtime state stays outside this package in the configured Beads store and pool
root. No startup migration, automatic cleanup, inactivity reassignment, or live
Herdr configuration change is performed by loading the extension.
