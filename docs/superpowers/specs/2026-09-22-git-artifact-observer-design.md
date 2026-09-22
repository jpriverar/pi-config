# Git Artifact Observer Design

**Status:** Approved design
**Task:** `jp-5mey`
**Date:** 2026-09-22

## Summary

The task lifecycle should record durable work outputs without requiring agents to call `task_attach_artifact`. This first slice adds passive adapters for ordinary Bash `git` and `gh` commands. Successful operations attach verified branch, commit, and pull-request artifacts to the session-owned Active task.

The observer records objective facts only. It does not interpret artifact importance, infer completion evidence, build source graphs, or record command history. `task_attach_artifact` remains available for non-Git artifacts and detection gaps.

## Purpose

Automatic Git artifact tracking improves:

- **continuity:** another agent can see what a task produced and resume from real outputs;
- **coordination:** waiting conditions and checks can reference actual pull requests and commits;
- **completion:** lifecycle closure can cite concrete evidence;
- **visibility:** task state includes the durable outputs produced during execution.

Agents should perform normal development work. The lifecycle should derive the resulting facts.

## Goals

- Observe ordinary Bash commands while a session owns exactly one Active task.
- Detect the common Git path: `git commit`, `git commit --amend`, `git push`, and `gh pr create`.
- Attach branch, commit, and pull-request artifacts after successful commands.
- Verify artifact identity from post-command Git or GitHub state.
- Keep command execution independent from artifact observation.
- Make repeated or retried observation idempotent.
- Surface tracking failures without exposing untrusted content.
- Preserve the existing lifecycle metadata version and task mutation model.

## Non-goals

- Removing `task_attach_artifact` in this slice.
- Detecting non-Git artifacts such as documents, dashboards, deployments, or reports.
- Recording every command, failure, attempt, or intermediate action.
- Inferring supporting/evidence/deliverable significance.
- Building branch-to-commit-to-PR source relationships.
- Determining whether an artifact satisfies task completion.
- Marking rewritten or unreachable commits as superseded.
- Observing Git operations executed through `ctx_execute`, custom tools, external processes, IDEs, or other sessions.
- Covering every Git mutation, alias, shell embedding, or dynamically generated command.
- Calling a model to classify commands in V1.

## Design Principles

### Session ownership establishes provenance

Any durable Git or GitHub output produced through Bash while a session owns exactly one Active task belongs to that task. Association does not require a lifecycle-managed worktree or repository match.

This supports cross-repository work and existing checkouts. If an agent performs unrelated Git mutations while owning a task, recording those outputs is accurate accountability rather than a false positive.

### Observation never controls work

The observer does not block, rewrite, or delay the underlying Bash command. Unrecognized, ambiguous, failed, or unverifiable operations attach nothing. The original tool result remains authoritative for command success.

### Facts come from post-command state

Command parsing decides only whether and where to inspect. It does not establish artifact identity. Artifact IDs and URIs come from verified repository or GitHub state after a successful result.

### Start with facts, add semantics after demonstrated need

V1 records kinds and canonical identities. Richer metadata, relationships, reachability, and completion semantics remain future decisions driven by concrete consumers.

## Architecture

The task lifecycle extension gains a Git artifact observer alongside the existing worktree observer.

### Deterministic command classifier

A small classifier interface receives normalized shell commands and returns zero or more bounded observation intents.

The V1 implementation reuses `extensions/shared/shell-command.ts`:

- `splitShellCommands` separates straightforward compound commands while respecting quotes;
- `unwrapExecutable` removes supported environment assignments and wrappers;
- exact executable and argument matching identifies supported `git` and `gh` operations.

This is not a regex-only parser. Opaque shell embeddings, heredocs, substitutions, aliases, and ambiguous commands are ignored.

The interface leaves room for a future redacted lightweight-model fallback, but V1 remains local, deterministic, offline, and testable. A model must not become artifact authority; any future model output may only request post-state inspection.

### Call/result correlation

At `tool_call` for the standard `bash` tool:

1. Validate that the input contains a string `command`.
2. Classify supported command segments.
3. Resolve exactly one Active task for the current session.
4. Capture a process-local pending observation keyed by `toolCallId`.
5. Store the captured task ID, session owner, repository context, and observation intents.
6. Return without changing or blocking the Bash call.

At the matching `tool_result`:

1. Remove the pending observation regardless of outcome.
2. Stop if the Bash call failed.
3. Resolve each intent through its post-state adapter.
4. Validate and canonicalize the resulting artifact facts.
5. Atomically persist all verified artifacts under the lifecycle lock.
6. Emit a curated non-blocking warning if observation fails.

The task captured at `tool_call` remains the intended association. Before persistence, the lifecycle service verifies that the captured session still owns that Active task. Ownership changes or lifecycle races attach nothing.

Reload or process interruption may lose process-local pending observations. V1 does not add a durable command journal or recovery protocol.

## Supported Operations

### `git commit`, including `--amend`

After success, inspect the effective repository and record:

- the current branch, when `HEAD` is attached to a branch;
- the resulting full `HEAD` commit SHA.

A detached `HEAD` may produce a commit artifact without a branch artifact.

### `git push`

After success, inspect the effective repository and pushed state. Record the relevant branch and commit if they were not already observed. The push itself is not an artifact.

V1 supports unambiguous common push forms. Ambiguous multi-ref or dynamically constructed pushes attach nothing unless post-state resolution is deterministic.

### `gh pr create`

After success, use verified GitHub state to obtain the repository, pull-request number, and canonical URL. Record one pull-request artifact.

Command output may provide a lookup hint but is never accepted as authority. Malformed, non-GitHub, or unverifiable output attaches nothing.

### Deferred operations

`merge`, `rebase`, `cherry-pick`, `revert`, `reset`, branch creation, and other Git mutations are not direct V1 triggers. Their current branch or `HEAD` may still be captured by a later supported commit or push observation.

## Minimal Artifact Records

V1 uses the existing `branch`, `commit`, and `pull_request` kinds because they require different canonical identities and downstream adapters must distinguish them.

Each automatically observed artifact contains:

- a deterministic repository-qualified ID;
- the existing kind;
- a canonical URI;
- a concise human-readable title;
- the observation timestamp and producing session required by lifecycle V1.

The existing schema also requires `role`, `sourceArtifactIds`, and `supersededAt`. Automatic Git artifacts use:

- one fixed compatibility role with no behavioral meaning;
- an empty `sourceArtifactIds` array;
- `supersededAt: null`.

No V1 consumer may infer importance from the compatibility role.

If amend or rebase produces a new SHA, each observed SHA remains a factual record. V1 does not decide which commit is current or abandoned.

## Identity and Idempotency

Artifact identity must avoid collisions across repositories:

- branches use repository identity plus full branch ref;
- commits use repository identity plus full SHA;
- pull requests use GitHub repository identity plus pull-request number.

Repeated observation of the same canonical artifact is a no-op. One operation may persist multiple artifacts atomically. Existing equivalent artifacts, including those created manually or through worktree acquisition, must be reused rather than duplicated.

The exact ID encoding is an implementation detail, but it must be deterministic, portable, bounded, and covered by tests.

## Lifecycle Service Boundary

The extension handles tool parsing, correlation, and post-state adapter invocation. The lifecycle service receives already validated artifact facts and owns persistence.

The service operation must:

- require the captured task to remain Active;
- require current ownership by the captured session;
- acquire the existing lifecycle lock;
- re-read and validate the latest full task object;
- merge all artifacts in one full metadata write;
- preserve unrelated metadata and native dependency edges;
- perform read-back verification;
- use the tool-call-derived operation ID for idempotency.

No observer writes Beads metadata directly.

## Failure and Security Behavior

Bash input, command output, Git state, GitHub output, and task metadata are untrusted.

- Never evaluate captured shell fragments.
- Never use raw command text or output as an artifact ID.
- Never include raw commands, stdout, stderr, task content, credentials, or provider responses in errors.
- Reject malformed repository identities, refs, SHAs, URLs, and PR numbers.
- Bound command, artifact, and diagnostic sizes.
- Failed Bash commands attach nothing.
- Missing or multiple Active tasks attach nothing.
- Unknown and read-only commands remain unaffected.
- Observation failure must not convert a successful Bash command into a failed command or encourage command retry.
- Diagnostics state only that Git artifact observation failed and identify the safe recovery action.

## Testing

### Classifier tests

- Recognize direct `git commit`, `git commit --amend`, `git push`, and `gh pr create`.
- Handle supported assignments, wrappers, absolute executable paths, Git global options, and `git -C`.
- Reject read-only, unrelated, dynamic, heredoc, alias, opaque shell, and ambiguous command shapes.
- Prove that no command is blocked or rewritten.

### Correlation tests

- Capture the task at `tool_call` and finalize only from the matching `tool_result`.
- Cover interleaved calls, failed calls, duplicate results, missing results, reload loss, and ownership changes.
- Clear every process-local pending entry.
- Preserve the original Bash result on observation failure.

### Adapter integration tests

- Use temporary Git repositories for commit and amend observation.
- Use a local bare remote for push observation.
- Stub GitHub verification for `gh pr create`.
- Cover detached `HEAD`, multiple repositories, malformed refs, malformed SHAs, and ambiguous pushes.

### Lifecycle tests

- Atomically insert multiple artifacts.
- Deduplicate deterministic identities.
- Preserve full-object metadata and native dependencies.
- Reject stale ownership without partial mutation.
- Keep errors curated and free of raw untrusted data.

### Repository gates

- Focused RED/GREEN tests.
- Full test suite and manifest tests.
- Typecheck, formatting, portability, and license checks.
- Real-Pi package smoke.

## Rollout and Acceptance

1. Implement while retaining `task_attach_artifact`.
2. Update lifecycle documentation with automatic Git coverage and explicit gaps.
3. Run repository-wide verification.
4. Install the package and reload Pi.
5. Live-test on `jp-5mey` using ordinary Bash commit, push, and PR creation.
6. Compare persisted artifacts against actual Git and GitHub state.
7. Verify failed and unsupported commands do not mutate task artifacts.
8. Close `jp-5mey` only after live verification and safe worktree cleanup.

This task does not remove `task_attach_artifact`. Later work may add observers for other artifact kinds and evaluate whether the manual tool remains necessary.
