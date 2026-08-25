---
name: finishing-a-development-branch
description: Use when implementation is complete, all tests pass, and you need to decide how to integrate the work
---

# Finishing a Development Branch

## Overview

**Core principle:** Verify tests → Detect environment → Present options → Execute choice → Clean up.

**Announce at start:** "I'm using the finishing-a-development-branch skill to complete this work."

## Step 1: Verify Tests

Run the project's full test suite (`npm test` / `cargo test` / `pytest` / `go test ./...`).

**If tests fail**, report the failures and stop — the menu comes after a green suite:

```
Tests failing (<N> failures). Must fix before completing:

[Show failures]
```

**If tests pass:** continue to Step 2.

## Step 2: Detect Environment

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
# Capture now, while still inside the workspace — Step 5 changes directory
# before cleanup (Step 6) needs this value
WORKTREE_PATH=$(git rev-parse --show-toplevel)
```

An active pool claim exists here only when this parent/session's ledger contains the exact current path and claim ID established by acquisition or prior ledger retention. Do not infer ownership from the linked path, directory name, branch, or an active claim listing. Without that exact ledger identity, treat a linked workspace as externally managed. A child never manages or finishes a pool claim.

This determines which menu to show and how cleanup works:

| State | Menu | Cleanup |
|-------|------|---------|
| Active pool claim, named branch | Standard 3 options | Release only as the selected option specifies |
| `GIT_DIR == GIT_COMMON` (normal repo) | Standard 3 options | No worktree to clean up |
| `GIT_DIR != GIT_COMMON`, named branch | Standard 3 options | Provenance-based (see Step 6) |
| `GIT_DIR != GIT_COMMON`, detached HEAD | Reduced 2 options (no merge) | Externally managed — leave in place |

**Stable-slot invariant:** Never remove a stable pool slot. Pool cleanup means `worktree_pool release`, which leaves the slot provisioned; it never means a direct worktree lifecycle command.

## Step 3: Determine Base Branch

The base branch is whatever this work forked from — usually named in the
plan, the conversation, or the branch's upstream. If it is not already
known, ask: "This branch split from <your best guess> - is that correct?"
Confirm before merging: merging into the wrong base is expensive to undo.

## Step 4: Present Options

**Normal repo and named-branch worktree — present exactly these 3 options:**

```
Implementation complete. What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)

Which option?
```

**Detached HEAD — present exactly these 2 options:**

```
Implementation complete. You're on a detached HEAD (externally managed workspace).

1. Push as new branch and create a Pull Request
2. Keep as-is (I'll handle it later)

Which option?
```

Present the menu exactly as written — concise, with every option coming
from the list above. Discarding the work happens only in response to your
human partner explicitly asking for it (see "If your human partner asks to
discard the work" below). Wait for their answer; the integration decision
is theirs.

## Step 5: Execute Choice

### Option 1: Merge Locally

```bash
# Get main repo root for CWD safety
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"

# Merge first — verify success before removing anything
git checkout <base-branch>
git pull
git merge <feature-branch>

# Verify tests on merged result
<test command>
```

If tests fail on the merged result: stop, leave the worktree and branch in
place, and investigate — nothing has been pushed, so the merge is local
and recoverable.

Once the merged result is green:

- **Active pool claim:** confirm the slot is clean, then use `worktree_pool release`. The local merge releases the clean claim but never removes the stable pool slot. Do not separately delete the slot's stable branch.
- **No active pool claim:** clean up the worktree (Step 6), then delete the feature branch:

```bash
git branch -d <feature-branch>
```

### Option 2: Push and Create PR

```bash
git push -u origin <feature-branch>
# From a detached HEAD, name the new branch on the remote:
# git push origin HEAD:refs/heads/<new-branch>
```

Then create the pull/merge request against <base-branch> with the forge's
tooling — its CLI if one is available, or the creation URL most forges
print when you push — following the repo's PR template and conventions if
present, and report the URL to your human partner.

- **Active pool claim:** after push and create PR succeeds, confirm the slot is clean and use `worktree_pool release`. PR creation releases the clean claim while leaving the stable slot provisioned.
- **No active pool claim:** keep the worktree so PR feedback can be handled there.

### Option 3: Keep As-Is

With an active pool claim, keep-as-is means retain the claim; do not release it. Report: "Keeping branch <name>. Pool claim retained at <path>."

Without an active pool claim, report: "Keeping branch <name>. Worktree preserved at <path>."

### If your human partner asks to discard the work

This path exists only as a response to an explicit request to throw the
work away. Confirm first. For a non-pool workspace, use the existing confirmation:

```
This will permanently delete:
- Branch <name>
- All commits: <commit-list>
- Worktree at <path>

Type 'discard' to confirm.
```

For an active pool claim, keep the same confirmation requirements without claiming the stable slot will be deleted:

```
This will permanently delete:
- Claimed branch work for <name>
- All commits: <commit-list>

The stable pool slot at <path> will remain provisioned.
Type 'discard' to confirm.
```

Wait for that exact confirmation. For an active pool claim, confirm the claimed workspace is clean before release; if it is dirty, stop and show the files at risk.

Then delete only the confirmed feature branch, in this order:

1. **Active pool claim:** use `worktree_pool release` with the recorded claim ID. Release detaches the stable slot while preserving the feature branch. Never remove the stable slot.
2. Move to a non-slot checkout, verify it is not the released slot's path, and delete only the feature branch named by the exact confirmation:

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT" # must be a non-slot checkout
[ "$PWD" != "$WORKTREE_PATH" ]
git branch -D <feature-branch>
```

For a non-pool workspace, use the selected workflow's managed cleanup (Step 6), move to a checkout outside that workspace, and run the same branch deletion only for the confirmed feature branch.

An explicit discard keeps all existing confirmation requirements and leaves the stable slot provisioned; it never authorizes deleting the stable slot, its stable branch, or any other branch work.

## Step 6: Cleanup Non-Pool Workspace

This step never runs for an active pool claim. Never remove a stable pool slot; only the structured release operation may reset it.

For a non-pool workspace, use the cleanup mechanism owned by the workflow selected in superpowers:using-git-worktrees:

- Normal checkout or user-provided workspace: leave it in place.
- Platform-native worktree: use the platform's workspace-exit or cleanup mechanism.
- Native subagent with `worktree: true`: return from the child and let the subagent platform perform its managed cleanup.

Do not substitute direct worktree lifecycle commands when the repository has no pool configuration. If cleanup is unavailable or refused because files are uncommitted, preserve the workspace and show the user the files at risk before asking how to proceed.

## Quick Reference

| Option | Pool claim | Non-pool workspace |
|--------|------------|--------------------|
| 1. Merge locally | Release clean claim | Use selected workflow's managed cleanup, then delete feature branch |
| 2. Create PR | Release clean claim | Preserve for feedback |
| 3. Keep as-is | Retain claim | Preserve |
| Explicit discard | Release after exact confirmation; stable slot remains | Managed cleanup and force-delete authorized feature branch |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Tests passed earlier this session" | Run the suite on the tree you are about to integrate. A green run only proves the tree it ran on. |
| "They obviously want it merged" | Integration is your human partner's decision. Present the menu and wait. |
| "They seem done with this feature — I'll offer to discard it" | The menu is complete as written. Discard happens only when your human partner asks for it in so many words. |
| "'Yeah, get rid of it' counts as confirmation" | Only the typed word `discard` authorizes deletion. |
| "The PR is up, so the worktree is clutter now" | PR feedback gets fixed in that worktree. It stays until the work lands. |
| "This other worktree looks stale — I'll clean it too" | Cleanup belongs to the selected workflow. Never clean up unrelated workspaces. |
| "Managed cleanup is unavailable, so I'll run Git lifecycle commands" | Preserve the workspace and report the limitation. An unavailable mechanism does not transfer ownership. |
| "The merged-result failure is probably flaky" | A failing merged result stops everything. Branch and worktree stay put while you investigate. |
| "The base branch is obviously main" | Confirm the fork point or ask. Merging into the wrong base is expensive to undo. |
| "The push was rejected — force-push will fix it" | A rejected push means the remote moved. Investigate; force-push only on your human partner's explicit request. |
