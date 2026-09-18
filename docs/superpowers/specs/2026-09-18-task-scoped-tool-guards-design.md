# Task-Scoped Tool Guards

**Status:** Approved by JP on 2026-09-18.

**Design work item:** `jp-w9kd`

**Repository:** `jpriverar/pi-config`

**Extends:**

- `docs/superpowers/specs/2026-09-17-task-lifecycle-artifacts-design.md`
- `docs/task-lifecycle.md`

## Purpose

Require selected Pi tool operations to run only while the current Pi session owns an Active lifecycle task. This establishes a small task-scoped admission boundary without introducing automatic artifact observation, subagent context propagation, or another durable event system.

The first version answers one question before a protected tool call runs:

> Does the current Pi session own the Active task required by this operation?

Some lifecycle tools already receive a structured `taskId`. For those tools, the guard additionally verifies that the supplied task ID is the session's Active task. It never searches prompts, shell commands, or arbitrary text for task identifiers.

## Decision

Implement task-scoped admission control in the existing `task-lifecycle` extension's `tool_call` hook.

A session is attached when lifecycle state already contains exactly one task with:

```text
piLifecycle.phase = active
piLifecycle.execution.sessionId = current Pi session ID
```

No separate binding record, binding ID, session custom entry, or event ledger is introduced. Beads lifecycle metadata remains authoritative.

The initial protected operation outside the lifecycle tools is subagent execution. Subagent management operations remain available without an Active task. The parent session must own a task before launching delegated execution, but task context is not propagated into the child in this version.

## Goals

1. Prevent taskless delegated execution through the `subagent` tool.
2. Prevent a task-bound session from mutating a different task through lifecycle tools.
3. Prevent a session from sequentially claiming another task while it already owns one.
4. Preserve unbound exploration, inspection, recovery, and task reconciliation.
5. Reuse the existing lifecycle service, Beads store, and `tool_call` hook.
6. Fail closed only for protected operations when ownership cannot be verified.
7. Keep the policy small enough to extend one operation at a time.

## Non-goals

Version 1 does not provide:

- automatic artifact attachment;
- provider-specific result adapters;
- normalized observation envelopes;
- new artifact, binding, or operation identifier schemes;
- subagent task-context inheritance;
- observation of child tool calls;
- automatic worktree correlation beyond existing task-aware tools;
- dynamic tool hiding or toolset changes;
- generic Bash parsing or mutation detection;
- durable event replay;
- transactional coordination across parallel Pi tool calls;
- broad protection for every external mutation or publication tool.

These capabilities may be added independently when observed failures justify them.

## Terminology

**Attached session:** A Pi session that owns exactly one Active lifecycle task.

**Protected operation:** A tool invocation whose policy requires an attached session.

**Same-task operation:** A protected lifecycle operation with a structured `taskId` argument that must equal the attached task's ID.

**Unprotected operation:** A tool invocation that does not consult lifecycle state and remains available without a task.

## Authoritative attachment resolution

The lifecycle service exposes a read method:

```ts
activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]>;
```

It lists lifecycle-managed `in_progress` issues and selects records whose explicit lifecycle metadata is Active and whose execution lease belongs to `sessionId`. The returned tasks are sorted by task ID so diagnostics remain deterministic.

The extension interprets the result with three outcomes:

| Matching Active tasks | Result |
|---|---|
| Zero | Session is unattached |
| One | Session is attached to that task |
| More than one | Invariant violation; protected operation is blocked |

The resolver ignores legacy `in_progress` records without valid lifecycle metadata and tasks owned by another session.

The implementation reads authoritative state for each protected call. Protected calls are infrequent, so Version 1 has no attachment cache or invalidation protocol.

## Tool policy

A pure classifier maps a tool name and structured input to one of these requirements:

```ts
type TaskToolRequirement =
  | { kind: "none" }
  | { kind: "active-task" }
  | { kind: "same-task"; taskId: string }
  | { kind: "claim-task"; taskId: string };
```

The `claim-task` case allows an unattached session to establish ownership, allows a retry for the currently attached task, and blocks a claim for a different task while ownership remains Active.

### Initial policies

| Tool | Operation | Requirement |
|---|---|---|
| `task_claim` | Valid structured `taskId` | Claim task |
| `subagent` | Invocation without a management `action` | Active task |
| `subagent` | Invocation with a management `action` | None |
| `task_attach_artifact` | Valid structured `taskId` | Same task |
| `task_wait` | Valid structured `taskId` | Same task |
| `task_close` | Valid structured `taskId` | Same task |
| `task_worktree_acquire` | Valid structured `taskId` | Same task |
| `task_worktree_release` | Valid structured `taskId` | Same task |
| `task_reopen` | Any | None |
| `task_reconcile` | Any | None |
| Unknown tools | Any | None |

The tool's own parameter schema remains responsible for malformed or missing arguments. The classifier only creates a same-task or claim-task requirement when `taskId` is a non-empty string.

A `subagent` invocation with no `action` is classified as execution. This covers direct child launches and workflow execution. Calls with an `action` remain management operations for Version 1, even when a future management action may itself deserve protection. Individual actions can be reclassified later.

## Admission flow

For every `tool_call`:

1. Preserve the existing raw worktree-pool guard behavior.
2. Classify the operation's task requirement.
3. Return immediately for `none`.
4. Resolve the current session's authoritative Active task.
5. Apply the requirement:
   - `active-task`: allow only when exactly one task is attached.
   - `same-task`: allow only when exactly one task is attached and its ID matches.
   - `claim-task`: allow when unattached or already attached to the same task; block a different task.
6. Return a Pi `{ block: true, reason }` result on rejection.

The guard does not modify tool arguments and does not perform lifecycle transitions.

## Failure behavior

Errors are concise and actionable:

```text
subagent execution requires an Active task; claim a task before retrying
```

```text
session owns active task jp-a, not jp-b
```

```text
session already owns active task jp-a; wait, close, or relinquish it before claiming jp-b
```

```text
session owns multiple Active tasks: jp-a, jp-b; repair lifecycle state before retrying
```

If Beads or the lifecycle store cannot verify ownership, the protected operation fails closed with a curated error. Raw task content, Beads stdout, and Beads stderr are not included.

Unprotected operations do not read Beads and remain available when lifecycle storage is unavailable.

## Existing worktree guard

The current lifecycle extension already protects two raw pool cases:

- raw `worktree_pool acquire` is blocked when the session has an Active lifecycle task, directing the caller to `task_worktree_acquire`;
- release of a lifecycle-associated claim is blocked, directing the caller to `task_worktree_release`.

Version 1 preserves those rules. Taskless raw acquisition, pool inspection, repair, and unassociated release remain available as explicit recovery paths under the existing design.

The new active-task resolver may replace the existing boolean `hasActiveTask` implementation internally, but the worktree policy does not otherwise change.

## Session lifecycle

No new session persistence is required:

- `task_claim` records the Pi session ID in the existing execution lease.
- `/reload` retains the same session ID and therefore the same attachment.
- Waiting, closing, interruption, or expiry removes Active ownership and therefore attachment.
- `/new`, `/resume`, `/fork`, and `/clone` retain the existing shutdown and interruption semantics.
- A resumed session qualifies only when authoritative lifecycle state still names its session ID as the Active owner.

Copied, imported, forked, or manually edited session files cannot grant ownership because no session-local binding is trusted.

## Subagents

Version 1 protects only the parent launch boundary:

```text
unattached parent + subagent execution -> blocked
attached parent + subagent execution   -> allowed
```

The child does not inherit task identity or lifecycle authority. The parent remains responsible for task transitions, resource handoff, publication, and final acceptance. Existing subagent management operations such as listing, status inspection, guidance, transcript inspection, steering, and stopping remain available without an Active task.

Automatic attachment of subagent outputs is deferred.

## Parallel-call limitation

Pi may execute sibling tool calls concurrently. Version 1 does not make a claim and a protected launch in the same assistant tool batch atomic. The launch may be blocked if the claim has not completed; retrying in the next turn is the expected behavior.

Similarly, Version 1 does not hold an ownership transaction open for the duration of a subagent run. Explicit lifecycle guidance continues to prohibit relinquishing a task while delegated work is still using its resources. A later version may add in-flight operation supervision if this produces real failures.

Sequential claims are protected by the `claim-task` policy. Two simultaneous claims from one unattached session remain a bounded race and can produce the existing multiple-ownership invariant error. Solving that rare case would require a broader cross-task transaction and is deferred.

## Security and trust

Tool names and inputs are untrusted values:

- classifier matching uses exact tool names;
- `taskId` is accepted only from the known structured field;
- task metadata is decoded by the existing lifecycle store;
- unknown tools and unknown input shapes are not heuristically classified;
- errors contain identifiers and curated explanations, not raw provider output.

The guard is admission policy, not a security sandbox. Unprotected Bash or external tools may still perform task-related work. Version 1 deliberately avoids pretending generic command interpretation is reliable.

## Implementation boundaries

The expected implementation surface is:

```text
lib/task-lifecycle/tool-guard.ts
lib/task-lifecycle/tool-guard.test.ts
lib/task-lifecycle/service.ts
lib/task-lifecycle/service.test.ts
extensions/task-lifecycle/index.ts
extensions/task-lifecycle/index.test.ts
docs/task-lifecycle.md
```

Responsibilities remain separated:

- `tool-guard.ts` performs pure tool classification and formats no store errors;
- `TaskLifecycleService` resolves authoritative session ownership;
- the extension hook coordinates classification, lookup, and Pi block results;
- the existing lifecycle service and Beads adapter remain the only durable state writers.

No changes are required in `pi-subagents`, the worktree-pool schema, Beads metadata schema, or external provider tools.

## Verification

Focused tests cover:

1. unbound subagent execution is blocked;
2. attached subagent execution is allowed;
3. subagent management remains available while unattached;
4. another session's Active task does not qualify;
5. same-task lifecycle operations are allowed;
6. different-task lifecycle operations are blocked;
7. claiming another task while attached is blocked;
8. retrying a claim for the attached task is allowed;
9. Waiting and Done tasks do not qualify;
10. multiple Active tasks fail closed;
11. store failure blocks only protected operations;
12. unknown tools remain available;
13. existing raw worktree-pool guards remain unchanged.

Repository verification includes the focused test files, the complete Node test suite, manifest tests, type checking, Prettier, portability checks, and `git diff --check`.

## Rollout

The first rollout protects only subagent execution and same-task lifecycle operations. After normal use, expand the policy only in response to a concrete failure mode or clearly valuable task boundary.

Likely future additions, each independently designed and tested, are:

1. selected external artifact-creation tools;
2. result adapters for automatic artifact attachment;
3. stronger worktree observation;
4. subagent task-context inheritance;
5. in-flight operation supervision;
6. provider-specific reconciliation.

The explicit lifecycle and recovery tools remain available throughout adoption.
