# Task lifecycle

Coordinates one Beads task from actionable work through active ownership, deterministic waiting, and an explicit done disposition.

The extension owns lifecycle metadata, artifact correlation, execution leases, typed checks, and task-aware worktree wrappers. Native Beads `blocks` edges remain authoritative for task dependencies. The task-agnostic `worktree_pool` extension remains independently available for inspection, repair, and taskless allocation.

Runtime state stays outside this package in the configured Beads store and the worktree pool root configured by `worktree-pool`.
