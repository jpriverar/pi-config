# Ordinary Worktree Lifecycle Coordination

**Status:** Approved by JP on 2026-09-18.

**Work item:** `jp-fudp`

**Repository:** `jpriverar/pi-config`

**Extends:**

- `docs/superpowers/specs/2026-09-17-task-lifecycle-artifacts-design.md`
- `docs/superpowers/specs/2026-09-18-task-scoped-tool-guards-design.md`
- `docs/task-lifecycle.md`

## Purpose

Make the ordinary worktree-pool tool the only public worktree workflow while preserving task ownership, resource cleanup, and deterministic crash recovery.

The normal flow becomes:

```text
task_claim
worktree_pool acquire
worktree_pool release
task_wait or task_close
```

The caller never supplies a task ID to a worktree operation. The lifecycle extension derives the task from the current Pi session's authoritative Active ownership.

## Decision

Remove the public `task_worktree_acquire` and `task_worktree_release` tools.

Coordinate ordinary `worktree_pool acquire` and lifecycle-associated `worktree_pool release` through the task-lifecycle extension's existing Pi hooks:

- `tool_call` performs admission, persists operation intent, and injects private deterministic pool identities before execution;
- the ordinary `worktree_pool` tool performs the pool mutation;
- `tool_result` validates the receipt and finalizes lifecycle resource metadata.

This is not post-result observation alone. Acquisition intent and deterministic claim identities are persisted before pool mutation so a crash between the pool operation and lifecycle finalization remains recoverable.

The worktree pool implementation remains task-agnostic. It receives optional precomputed pool identities from its own adapter input but does not read Beads, resolve tasks, or enforce lifecycle phases.

## Goals

1. Require exactly one session-owned Active task before ordinary worktree acquisition.
2. Associate every newly acquired worktree with that Active task automatically.
3. Route lifecycle-associated ordinary releases through the existing two-phase resource state machine.
4. Preserve deterministic recovery across crashes and partial failures.
5. Keep `worktree_pool list` and `worktree_pool repair` independent of task ownership.
6. Preserve recovery for legacy or otherwise unassociated claims.
7. Ensure Waiting and Done transitions do not retain active worktree claims.
8. Remove task-specific worktree tools from the public tool surface.

## Non-goals

This change does not:

- make the worktree pool core aware of tasks or Beads;
- parse Bash commands to infer worktree operations;
- introduce a new task-binding record or resource identifier scheme;
- require the caller to repeat the Active task ID;
- automatically attach branches or commits as durable artifacts;
- propagate task ownership into subagents;
- prevent inspection or repair while unattached;
- make arbitrary third-party worktree mutations observable;
- add background reconciliation, timers, or watchers.

## Authoritative task resolution

For a protected worktree operation, the lifecycle extension calls:

```ts
activeTasksForSession(sessionId): Promise<LifecycleIssue[]>;
```

The result has three outcomes:

| Matching Active tasks | Admission result                                     |
| --------------------- | ---------------------------------------------------- |
| Zero                  | Block acquisition                                    |
| One                   | Use that task for lifecycle coordination             |
| More than one         | Block because lifecycle ownership is ambiguous       |
| Lookup failure        | Block because Active ownership could not be verified |

Task metadata supplied through prompts, tool results, session custom entries, or caller-provided hidden fields is not authoritative.

## Public tool surface

The public worktree tool remains:

```text
worktree_pool { list | acquire | release | repair }
```

Remove these registered tools:

```text
task_worktree_acquire
task_worktree_release
```

The lifecycle service retains internal resource-coordination operations. Their interfaces are split around the external pool mutation rather than exposed as Pi tools.

## Private correlation context

Pi validates public tool arguments before the `tool_call` hook and does not revalidate after hook mutations. The lifecycle hook may therefore inject a private correlation object that is absent from the public JSON schema.

The object contains only bounded identifiers needed to connect pre-execution intent with the result:

```ts
type WorktreeLifecycleContext = {
  version: 1;
  taskId: string;
  operationId: string;
  mode: "acquire" | "release";
  claimId: string;
  pathId?: string;
  repository: string;
};
```

The operation ID is the Pi tool-call ID. Acquisition uses lifecycle-generated `claimId` and `pathId` values. Release uses the caller's exact claim ID.

The public schema continues to reject caller-supplied private fields. The pool adapter validates the injected object before using its identities. The pool core receives only its existing explicit identity input.

The same private context remains present on the `tool_result` event's input, avoiding a session-local in-memory map that would be lost on reload or depend on result ordering.

## Acquire flow

For `worktree_pool` with `action: "acquire"`:

1. Pi validates the public worktree arguments.
2. The lifecycle `tool_call` hook resolves the current session's Active task.
3. If ownership is absent, ambiguous, or unverifiable, the hook blocks the call before pool execution.
4. The lifecycle service resolves the canonical pool repository identity.
5. The service validates all non-released resource associations already recorded on the task.
6. The service generates deterministic `claimId` and `pathId` values.
7. The service persists an `acquiring` resource containing the operation ID, claim ID, path ID, repository, and branch.
8. The hook injects the private correlation context into the tool input.
9. The ordinary worktree tool passes the injected claim and path identities to the task-agnostic pool acquire operation.
10. The pool returns its normal acquisition receipt.
11. The lifecycle `tool_result` hook verifies that the receipt is successful and that its action, claim, repository, branch, and deterministic identities match the persisted intent.
12. The service records the observed path and HEAD and marks the resource `active`.

If Step 7 fails, the pool does not run. If Steps 9 or 10 fail, the resource remains `acquiring`. If Steps 11 or 12 fail after the pool succeeds, the resource also remains `acquiring`; deterministic claim identity allows later reconciliation to locate the exact pool claim.

Retries with the same Pi tool-call ID reuse the persisted intent and identities. A conflicting receipt or more than one exact claim match fails closed.

## Release flow

For `worktree_pool` with `action: "release"`:

1. The lifecycle `tool_call` hook searches lifecycle metadata for the supplied claim ID.
2. Zero associated tasks means the claim is unassociated recovery state; the ordinary raw release remains available.
3. More than one associated task is ambiguous and blocks release.
4. For exactly one associated task, the hook verifies that the current session owns that same task as Active.
5. The service persists `release_pending` with the Pi tool-call ID.
6. The hook injects private release correlation into the tool input.
7. The ordinary worktree tool calls the task-agnostic pool release operation.
8. The lifecycle `tool_result` hook requires a successful receipt with `released: true` and the expected claim ID.
9. The service marks the resource `released`.

A refused release leaves `release_pending` authoritative. A pool release that succeeds before lifecycle finalization is recoverable: reconciliation observes that the exact claim no longer exists and completes the release metadata transition.

An unassociated release does not write lifecycle state. This exception exists only for legacy claims and explicit recovery; taskless acquisition is no longer possible through the ordinary public tool.

## Waiting and closing

`task_wait` and `task_close` continue to release all non-released task worktrees before changing phase. Callers do not need to invoke a separate manual release first.

For each Active resource, the lifecycle service uses the same internal prepare, pool release, and finalize operations as the ordinary release hook.

The transition succeeds only after every resource is marked `released`. If a worktree is dirty, occupied, missing contradictory evidence, or otherwise refuses safe release:

- the task remains Active;
- the resource remains recorded;
- the error identifies the task and claim with an actionable instruction;
- raw task content and provider output are not exposed.

Example:

```text
task jp-123 still owns worktree claim-456; make it releasable or release it before waiting
```

An `acquiring` or `release_pending` resource must be reconciled before the task can enter Waiting or Done.

## Failure behavior

Admission failures are curated:

```text
worktree_pool acquire requires an Active task; claim a task before retrying
```

```text
session owns multiple Active tasks: jp-a, jp-b; repair lifecycle state before retrying
```

```text
unable to verify Active task ownership for worktree_pool
```

```text
worktree claim claim-456 belongs to active task jp-a, not jp-b
```

A lifecycle finalization failure changes the tool result to an error even when the pool mutation itself succeeded. The result explains that reconciliation is required and includes only bounded identifiers. It does not pretend the pool mutation was rolled back.

## Reconciliation

Existing bounded synchronous reconciliation is extended to handle hook-split operations:

- `acquiring` plus one exact matching pool claim validates and finalizes acquisition;
- `acquiring` plus no matching claim remains retryable with the same deterministic identities;
- `acquiring` plus multiple or contradictory matches fails closed;
- `release_pending` plus no exact pool claim finalizes release;
- `release_pending` plus one valid claim retries or reports the still-held resource;
- multiple or contradictory release matches fail closed.

No background process is introduced. Reconciliation runs through existing lifecycle entry points and explicit retries.

## Parallel calls

Pi preflights sibling tool calls sequentially and may execute them concurrently. Each worktree operation uses its distinct tool-call ID, claim ID, and path ID.

Multiple acquisitions for one Active task remain supported. Each preflight persists a separate `acquiring` resource before execution.

A concurrent `task_wait` or `task_close` sees the pending resource and cannot complete until the resource operation is finalized or reconciled. This prevents the task from entering Waiting or Done while an acquisition is in flight.

A claim and acquisition submitted in the same assistant tool batch are not atomic. Acquisition may be blocked because the claim result is not guaranteed to be visible during sibling preflight. The caller retries acquisition in the next turn.

## Security and trust

All tool input, task metadata, and pool receipts are untrusted:

- public arguments are schema-validated before hooks;
- private correlation has a fixed version and bounded known fields;
- persisted lifecycle state remains authoritative;
- result receipts must match persisted intent exactly;
- ambiguous ownership or resource association fails closed;
- error messages expose identifiers, not raw Beads output or task content.

The private injected context is an extension coordination mechanism, not an authorization credential. Authorization always comes from authoritative lifecycle ownership at preflight and again during lifecycle mutation.

## Implementation boundaries

Expected changes are limited to:

```text
extensions/task-lifecycle/index.ts
extensions/task-lifecycle/index.test.ts
extensions/worktree-pool/index.ts
extensions/worktree-pool/index.test.ts
lib/task-lifecycle/service.ts
lib/task-lifecycle/service.test.ts
lib/task-lifecycle/tool-guard.ts
lib/task-lifecycle/tool-guard.test.ts
docs/task-lifecycle.md
```

Responsibilities remain separated:

- `tool-guard.ts` classifies ordinary acquisition as requiring an Active task;
- the lifecycle extension performs pre/post hook orchestration and curated blocking;
- `TaskLifecycleService` owns resource intent, validation, finalization, and reconciliation;
- the worktree-pool extension accepts validated private identities and returns normal receipts;
- the pool core remains unaware of tasks and Beads.

No Beads metadata schema change is required. Existing worktree resource states and deterministic identities are reused.

## Verification

Focused tests cover:

1. unattached ordinary acquisition is blocked before pool execution;
2. one Active task permits ordinary acquisition;
3. multiple Active tasks and lookup failure block acquisition;
4. acquisition intent is persisted before pool mutation;
5. injected claim and path identities reach the pool;
6. a successful acquire receipt finalizes the resource association;
7. a failed or malformed receipt leaves `acquiring` state;
8. lifecycle finalization failure reports partial success without losing recovery identity;
9. associated ordinary release requires ownership of the same Active task;
10. release intent is persisted before pool mutation;
11. successful release finalizes metadata;
12. refused release remains `release_pending`;
13. unassociated legacy release remains available;
14. `task_wait` and `task_close` release tracked resources before transition;
15. release refusal keeps the task Active with a curated error;
16. pending resource operations prevent Waiting or Done transitions;
17. public `task_worktree_acquire` and `task_worktree_release` registrations are absent;
18. list and repair remain available while unattached;
19. the pool core remains task-agnostic;
20. retries and reconciliation preserve deterministic identities.

Repository verification includes focused tests, the complete Node test suite, manifest tests, Beads compatibility, type checking, Prettier, portability checks, and `git diff --check`.

## Rollout

This replaces the previously documented raw worktree guard behavior:

- taskless ordinary acquisition changes from allowed to blocked;
- attached ordinary acquisition changes from blocked to lifecycle-coordinated;
- associated ordinary release changes from blocked to lifecycle-coordinated;
- task-specific worktree tools are removed.

After deployment, `/reload` is required for the active Pi process to load the new extension behavior. A live smoke test should verify unattached rejection, attached ordinary acquisition, persisted association, ordinary release, and a clean Waiting transition.
