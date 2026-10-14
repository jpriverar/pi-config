# Task lifecycle

Coordinates one Beads task from actionable work through active ownership, deterministic waiting, and an explicit done disposition.

The extension owns lifecycle metadata, artifact correlation, execution leases, typed checks, and task-aware worktree wrappers. Native Beads `blocks` edges remain authoritative for task dependencies. The task-agnostic worktree extension exposes `worktree_list`, `worktree_acquire`, `worktree_release`, and `worktree_repair`. Lifecycle hooks require an active task for acquisition, associate successful acquisitions with that task, and guard/finalize releases of associated claims. Inspection and non-destructive repair do not require an active task.

Runtime state stays outside this package in the configured Beads store and the worktree pool root configured by `worktree-pool`.
