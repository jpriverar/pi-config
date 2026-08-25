---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from the current workspace or before executing implementation plans
---

# Using Git Worktrees

## Overview

Ensure work happens in an isolated workspace without competing with the environment that owns it.

**Core principle:** Detect existing isolation first. A configured parent uses the structured pool; otherwise choose an explicit non-pool workflow. Children never manage worktrees.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

## Step 0: Detect Existing Isolation

### Role Gate: Children Keep the Assigned Workspace

**Do this before Git inspection or any pool action.** If `PI_SUBAGENT_DEPTH > 0` or the runtime/instructions identify this session as a child role, keep the exact parent-provided workspace. Do not change directories to a guessed workspace. Never invoke a pool action through `worktree_pool`, including actions named `list` and `acquire`. Continue directly to Project Setup in that workspace.

A child does not need to prove who owns its workspace. The parent already selected it, and inspection cannot grant the child lifecycle authority.

### Parent Workspace Authority

Only a parent continues with detection. Check whether the parent is already isolated:

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
WORKTREE_PATH=$(git rev-parse --show-toplevel)
```

**Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside git submodules. Before concluding "already in a worktree," check:

```bash
git rev-parse --show-superproject-working-tree 2>/dev/null
```

A linked path, directory name, or arbitrary active listing does not establish ownership. Never adopt an arbitrary active workspace as this parent's claim.

- **Previously ledgered claim:** if this same parent/session already ledgered the exact current path and claim ID for the requested branch, retain that identity. Do not rediscover it.
- **No prior ledger identity:** otherwise, if the pool capability is available, call `worktree_pool acquire` for the requested branch. This applies whether the current branch already matches or a clean slot needs retargeting. Same branch reuse and clean retarget both use the acquire result as authority. Record the returned absolute path, claim ID, branch, and `reused` value; use the returned path even when it differs from the starting path.
- **Acquire fails in a linked workspace:** report the failure and treat the current linked workspace as externally managed. Do not claim it from its path or from another claim's listing. A dirty or foreign workspace remains untouched.
- **No pool capability or unconfigured repository:** treat a linked workspace as externally managed. Do not acquire or create another workspace from inside it.

Report the established identity:
- Pooled named branch: "Using pool claim `<claim-id>` at `<absolute-path>` on branch `<name>` (`reused: <value>`)."
- Externally managed named branch: "Already in isolated workspace at `<path>` on branch `<name>`."
- Detached HEAD: "Already in isolated workspace at `<path>` (detached HEAD, externally managed)."

**If this is a normal checkout or a submodule and no claim was retained or acquired:** continue to Step 1.

## Step 1: Select the Workspace Workflow

### Configured repository and parent session: use the pool

If Step 0 did not already retain or acquire a claim and the `worktree_pool` capability is available, parent work uses `worktree_pool acquire` for the requested branch. Use the absolute path, claim ID, and `reused` value returned by the tool; do not create, move, repair, retarget, or remove the stable slot yourself. If acquire reports that the repository is unconfigured, use the non-pool workflow below.

Only the parent manages a claim. The role gate in Step 0 sends an assigned child directly to setup in its parent-owned workspace before any pool action; children never acquire or release claims. The parent retains the claim until the finishing workflow says to release it.

### Unconfigured repository: choose an explicit non-pool workflow

An unavailable pool capability or an explicit "repository not configured" result means there are no pool slots to acquire. Do not imitate the pool with direct `git worktree` lifecycle commands. Explicitly choose one of these non-pool workflows:

1. Use the platform's native worktree mechanism, including a structured subagent call with `worktree: true`; the platform owns creation and cleanup.
2. Use an isolated workspace the user or host already provided.
3. With the user's consent, work in the current checkout.

If no choice is already established, ask which non-pool workflow to use. Keep native `worktree: true` behavior intact; it is separate from pooled delegation.

## Step 2: Project Setup

Auto-detect and run the applicable setup:

```bash
if [ -f package.json ]; then npm install; fi
if [ -f Cargo.toml ]; then cargo build; fi
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi
if [ -f go.mod ]; then go mod download; fi
```

## Step 3: Verify Clean Baseline

Run the project's tests before implementation.

**If tests fail:** report the failures and ask whether to investigate or proceed.

**If tests pass:** report the workspace path and that it is ready.

## Quick Reference

| Situation | Action |
|---|---|
| Assigned child workspace | Keep the exact provided workspace; invoke no pool action |
| Parent with exact path + claim ID in its ledger | Retain that identity |
| Parent without prior ledger identity | Acquire the requested branch; trust only the result |
| Acquire failure in a linked worktree | Treat it as externally managed |
| Configured repository, parent session | `worktree_pool acquire` |
| Unconfigured repository | Explicit native, pre-existing, or in-place non-pool workflow |
| Native isolated subagent | Preserve `worktree: true` |
| Baseline tests fail | Report and ask before implementation |

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "The pool is available, so this child can acquire its own slot" | Pool management is parent-only. The child's workspace is already assigned and parent-owned. |
| "No pool configuration means I should create a worktree with Git" | Unconfigured repositories require an explicit non-pool workflow; direct lifecycle commands do not become safe by being a fallback. |
| "Pooled and native worktrees are interchangeable" | `worktree: true` preserves the platform's native lifecycle. A pooled child uses a parent-acquired path and does not create a worktree. |
| "The workspace is fresh, so baseline tests can wait" | A dirty baseline makes later failures ambiguous. Run the tests first. |
