# Workstream-linked Datadog work items — small v1

Task: `jp-w7cz` · Date: 2026-10-07

Status: Simplified direction approved; revised written specification awaiting review. No implementation or external writes authorized yet.

## Goal and scope

For selected workstreams, keep Datadog Work Management informed without maintaining a second task list manually:

1. A new local task creates a work item and retains its ID/link.
2. Local lifecycle changes update that item's status.
3. Explicit `task_log` entries become comments.

Only tasks created after linking a workstream enroll. Existing and unlinked tasks remain unchanged. Datadog failure must not interrupt local work.

Start with the smallest complete implementation of these behaviors. Add capabilities in response to observed problems, not hypothetical future providers or failure scenarios.

## Fit into the existing system

Implement one Datadog-specific module in `pi-config`, called by the existing task-reconciliation daemon. No Herdr changes, separate service, generic provider framework, or new event system.

The existing creation path stores task metadata atomically with the task. The native Beads comment journal supplies stable comment IDs. The daemon already scans and bounds background work, but its queue is in memory: task state and the journal, not that queue, must preserve unfinished work.

Keep synchronization separate from lifecycle policy. It must not claim tasks, renew leases, change dependencies, or release worktrees.

## Configuration

Use one private configuration shared by task creation and the daemon. With no integration configured, behavior is unchanged. Each linked workstream specifies the Datadog site/org, project, required work-item type, and status mapping. Do not store credentials or duplicate mappings in Herdr/session state.

Provide mappings for actionable, active, waiting, deferred, and done. Done distinguishes completed, cancelled, and superseded; multiple outcomes may intentionally share one Datadog status. Both waiting reasons use the same mapping in v1. Use existing project statuses rather than creating them.

The target and mapping are captured when a task enrolls. Changing configuration or task labels affects no existing binding; it never moves or duplicates an external item. Removing a mapping stops new enrollment, not delivery for already enrolled tasks. Use the existing daemon stop/start controls for the initial operational off switch rather than adding integration-specific pause controls.

Validate configuration locally before task creation. Malformed configured mappings produce an explicit error before creating the task, not a silently unlinked task. A Datadog network/authorization check is not part of local creation.

## Minimal durable state

Add a small versioned task-metadata record, separate from `piLifecycle`, containing:

- Captured target/mapping and initial title/description.
- External item ID/link once created.
- Last successfully sent local status and delivered native comment IDs.
- At most one in-flight operation, plus a bounded error/retry indication.

Write enrollment in the same native operation that creates the task. Use existing store locking and metadata-preserving writes; never hold a local lock across HTTP or credential retrieval.

No extra enrollment UUID, event IDs, remote correlation protocol, per-attempt history, or second copy of the journal. Native task/comment identities are sufficient for local tracking. An in-flight marker is necessary: after a crash, it prevents an uncertain write from being sent again blindly.

## Normal synchronization

On the daemon's existing scan cadence, inspect enrolled tasks, including closed and deferred tasks. Process a bounded amount of work using existing concurrency/backoff controls; synchronization must not starve lifecycle reconciliation.

For each task:

1. Create the item if absent, using its captured title/description and local task ID for human reference.
2. Send the currently mapped status when it differs from the last successful delivery. Reopening updates the same item. Intermediate transitions may coalesce.
3. Send undelivered eligible comments in native journal order, using native IDs to distinguish even identical messages.

Perform one outbound mutation at a time per task. Persist its identity before sending and its successful result afterward. Record the status actually sent, not a newer state observed after the response; the next scan can pick up changes made during the request.

There is no remote polling or drift correction. A Datadog status edited manually stays as edited until a later local change requires another status delivery. Remote changes never update Beads.

A task completed before initial delivery still gets its item and current terminal status. Pending work survives Pi-session closure and daemon restart; no extra wake-up mechanism is required for correctness.

## Task-log comments

Publish explicit `task_log` entries only, not arbitrary native comments. For enrolled tasks, append a fixed versioned source tag with the native log entry in the same append operation. Use that entry's existing Beads ID for delivery tracking, not another generated event identity.

The verified Beads interface exposes comment text rather than structured provenance, so the tag can be a reserved footer. Strip it from external comment text and Pi-rendered messages; raw native journal output may show it. Unlinked task logging remains unchanged. The tag is not an authorization boundary against someone with direct store access.

Comments contain the authored message and original timestamp. Do not automatically add transcripts, tool output, session history, or host details. Enabling a workstream means its task titles/descriptions and explicit logs are publishable to that project; v1 does not provide automatic secret detection.

No comment editing/deletion synchronization or historical replay for pre-existing tasks.

## Failures: safe before clever

Local operations finish without waiting for Datadog. Show the external link and a compact pending/error indicator through existing task results/state displays; use existing daemon diagnostics rather than a new dashboard or command suite.

Reuse bounded retries for failures known not to have applied a remote mutation, including documented rate-limit rejections. Authentication or invalid-target errors need attention. Sanitize errors; never expose credentials or raw response bodies.

If a timeout, disconnect, crash, or lost acknowledgment leaves a write's outcome uncertain, persist that uncertainty and stop synchronization for that task. This conservative rule also applies to status writes: repeat transitions may have notification/automation effects.

V1 does not search remote timelines, reconcile markers, or automatically recreate missing items. Manual investigation may be needed to confirm the external result and repair the sync record. Document targeted, explicitly approved recovery using existing Beads metadata operations, preserving lifecycle state; do not build recovery tools now. Never automatically clear an uncertain attempt and retry it. An uncertain comment can temporarily pause status delivery too; accept that limitation rather than introduce independent delivery queues.

Stopping the daemon cannot undo a request already sent. Record its result if available; otherwise retain the uncertain attempt for manual attention.

## API, credentials, and activation

Use the documented Case Management endpoints for creation, status, and comments, with small request/response functions rather than a generalized adapter framework. Keep tests injectable without creating abstractions for unused providers.

Use `dd-auth` with explicit org/site selection and bounded execution, without shell interpolation, credential output, or persistent keys. Restrict requests to supported Datadog hosts; do not forward credentials across arbitrary redirects. Do not change the conversational MCP connection.

The installed helper's help confirms org/site selection but not unattended behavior with expired credentials. Verify that before enabling background writes. If it cannot run safely unattended, stop and discuss the credential mechanism rather than layering workarounds.

JP must approve the actual project/status mapping and a disposable task before live validation. Then verify one creation, status update, and comment. No projects, statuses, or validation items are created during design; cleanup requires separate approval.

## Focused verification

Test the behavior at its real boundaries:

- New linked tasks enroll atomically; unlinked/existing tasks do not. Configuration changes cannot reroute them.
- Local work succeeds while Datadog fails, and scans recover unfinished work after restart, including completed tasks.
- Status mapping, reopen, and concurrent local changes send the correct latest state without polling remote edits.
- Only tagged logs publish, in order; identical messages are distinct and confirmed comments are not replayed.
- Crashes before/after remote writes preserve in-flight uncertainty rather than cause blind retries.
- Sync metadata writes preserve lifecycle state; work and errors remain bounded and credentials stay private.

Use existing store/daemon fixtures, fake clocks, and stubbed API calls. Do not introduce a new testing framework.

## Explicitly outside v1

Jira; two-way sync; backlog import; remote drift correction; automatic duplicate reconciliation; custom recovery CLI; integration-specific pause machinery; live title/description/assignee/priority sync; project moves; remote deletion; complete status history; changes to Herdr or task ownership.

These are possible future ideas, not tracked follow-up commitments. Revisit one only when use reveals a concrete need. V1 makes no exactly-once-delivery promise and deliberately trades automatic recovery for a smaller, safer implementation.

## References and next step

Implementation entry points: `lib/task-lifecycle/{service,beads-store}.ts`, `lib/task-reconciler/{runtime,queue}.ts`, and the existing task extension. Inspected source baseline: `6f7875b`.

- [Local lifecycle contract](../../task-lifecycle.md)
- [Daemon operations](../../task-reconciler-operations.md)
- Datadog API: [create](https://docs.datadoghq.com/api/latest/case-management/create-a-case/), [status](https://docs.datadoghq.com/api/latest/case-management/update-case-status/), [comment](https://docs.datadoghq.com/api/latest/case-management/comment-case/)

API support is documented, not live-write tested. Review this revised specification before implementation planning. Approval permits planning, not execution or activation.
