# Worktree tools

The extension exposes four action-specific tools. They replace the former
`worktree_pool` action argument; do not pass `action` to these tools.

| Tool | Required inputs | Optional inputs |
| --- | --- | --- |
| `worktree_list` | None | `repository` |
| `worktree_acquire` | `repository`, `branch` | `startPoint` |
| `worktree_release` | `repository`, `claimId` | `force` |
| `worktree_repair` | `repository`, `slot` | None |

`repository` is a repository name or safe relative path beneath `~/dd`.
Omitting it from `worktree_list`, or supplying an empty string, lists all
configured pools. The model-facing listing includes capacity, claim IDs,
paths, recorded owners, states, and observed blocker reasons. A listing is
not a guarantee that release inspection will succeed.

Acquisition fetches recognized remote-tracking start points and returns the
worktree path, branch, HEAD, claim ID, and a ready-to-use release invocation:

```text
worktree_acquire({"repository":"pi-config","branch":"jpriverar/my-change","startPoint":"origin/main"})
worktree_release({"repository":"pi-config","claimId":"<returned-claim-id>"})
```

Release takes the claim ID, **not** a branch or path. Release only when the
work is durable and no child or other writer still uses the checkout.
Non-destructive repair takes a managed path or claim ID as `slot`; it does
not replace explicit release of an existing checkout.

## Release safety

Release preserves ownership, managed-path, branch, and native-lock checks.
It discovers submodules from index gitlinks rather than depending on valid
`.gitmodules` metadata. Missing or empty uninitialized submodule directories
are safe to inspect even when their metadata is missing. Initialized and
retained submodule Git data are inspected recursively.

Without `force`, local changes, untracked files, and submodule commits or
stashes not reachable from remote-tracking refs prevent release. Explicit
`force: true` discards that local work. Ignored files are removed in either
mode.

`force` never bypasses inspection failures, ambiguous submodule contents,
externally owned Git data, or Git data used by an outside worktree. An
inspection failure reports its path and explains that force cannot help;
no checkout is removed. Resolve the reported condition rather than blindly
retrying with force.

### Interrupted directory removal

Git can unregister a checkout but fail to remove its directory when Watchman
continues creating cookie files. Such a claim remains `removing` and keeps its
task resource `release_pending`. Inspect it with `worktree_repair`, then retry
`worktree_release` with the exact claim ID from the owning task session.

Explicit release can finish an unregistered `removing` claim only when the
validated managed directory is empty or contains only empty, regular,
non-hardlinked Watchman cookie files. It stops only that canonical directory's
exact Watchman watch, rechecks the directory and Git registrations, unlinks
verified cookies individually, and removes the empty directory nonrecursively.
Unknown contents, changed identities, symlinks, registrations, or Watchman
inspection/deletion errors preserve the claim. `force` does not relax these
checks. Recovery requires a working Watchman CLI/daemon when the residual
directory exists; commands neither start a daemon nor change other watches.
Repair remains non-destructive and reports whether explicit release can finish.

The task-lifecycle extension guards acquisition and associated releases and
records their results under the new tool names. Its lifecycle and resource
ownership rules are unchanged. Install the worktree and lifecycle changes
together; running sessions need a reload to see the new tool declarations.
