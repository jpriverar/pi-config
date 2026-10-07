# Workstream-linked Datadog work items

Date: 2026-10-07

Task: `jp-w7cz` — Link Herdr workstreams to external projects

Status: Direction approved; written specification awaiting JP's review. No implementation or external writes authorized by this document.

## Intent and agreed scope

JP wants selected workstreams to publish their tasks into a Datadog Work Management project without maintaining a second task list manually. Herdr is the presentation context, not the owner of the integration.

Agreed behavior:

- A workstream can opt into one Datadog project.
- New managed tasks in that workstream create corresponding work items and retain their external IDs and links.
- Local task lifecycle changes drive Datadog status changes, never the reverse.
- Explicit `task_log` progress entries become individual work-item comments.
- Datadog failure does not prevent local task creation, progress, or completion.
- Existing tasks are not enrolled when a mapping is enabled.
- Jira, two-way synchronization, and backlog enrollment are outside v1.

Success means local task management remains authoritative and usable offline, while Datadog eventually reflects the latest status and each eligible progress entry, or visibly reports why delivery needs attention. The integration must not silently lose delivery intent or blindly repeat an uncertain external creation/comment.

## Evidence and existing boundaries

Source baseline: `pi-config` commit `6f7875b5d7588b035d89a139e5f16f4147c0fad4`.

- `extensions/task-lifecycle/index.ts` exposes task creation and logging.
- `lib/task-lifecycle/service.ts` routes creation through the store and validates ownership before logging.
- `lib/task-lifecycle/beads-store.ts` creates tasks with native `workstream:<value>` labels and `piLifecycle` metadata. Logging appends a native Beads comment. Store mutations preserve unrelated metadata.
- `lib/task-lifecycle/types.ts` separates lifecycle metadata, artifacts, checks, and execution leases.
- `lib/session-project.ts` resolves Pi's session workstream independently of Herdr workspace identity.
- `plugins/herdr-space-tabs/sync_tabs.py` publishes presentation metadata; it does not own tasks or workstreams.
- `lib/task-reconciler/runtime.ts` and `queue.ts` provide an existing per-store background process, periodic scans, and bounded execution. The current queue is in memory and is not a durable outbox.
- A read of this task's native comment journal returned stable string IDs, issue IDs, authors, text, and creation timestamps. The current store discards the JSON result of comment insertion.

Datadog documents Work Management under the Case Management API. Documented endpoints cover case creation, status changes, comments, project reads, case reads/search, and timeline reads. The current conversational MCP catalog exposes Case Management reads, not the required writes. This integration therefore uses a typed, narrowly scoped API adapter rather than model-driven MCP calls.

API documentation is contract evidence, not evidence of working credentials or behavior in the target project. No live Datadog writes have been tested.

## Alternatives and decision

1. **Pi-session worker:** fewer process changes, but delivery depends on a live session. Rejected because pending work must survive session closure.
2. **Existing daemon with a separate sync module:** reuses process supervision and bounds while retaining a clear separation from lifecycle reconciliation. Selected.
3. **Separate integration service:** independently deployable, but adds a process, configuration, and operational burden without a present requirement. Not selected.

The daemon remains a local process for one Beads store. External synchronization is a separate concern inside that process, not a new lifecycle check type and not an extension of worktree cleanup policy.

## Configuration and enrollment

Use one private, versioned integration configuration referenced by both task creation and the daemon. Do not duplicate authoritative mappings in Herdr, session metadata, packaged defaults, and installed daemon snapshots. Both clients read the same configuration; installed runtimes retain its path rather than a stale embedded copy.

Each enabled workstream mapping defines:

- Workstream key, matched against the explicit task creation workstream using the repository's existing matching conventions.
- Explicit Datadog site and organization identity; no implicit use of the selected conversational MCP organization.
- Project UUID and work-item type where required by the target project/API.
- A complete mapping of local lifecycle outcomes to existing Datadog statuses.
- Configuration revision and enrollment enablement.

Configuration contains credential-provider references, never credentials. V1 does not create projects, work-item types, statuses, or custom attribute definitions remotely.

A newly created task snapshots its binding in the same Beads creation operation as its native task and lifecycle metadata. The snapshot includes a random enrollment identity, configuration revision, site/org/project/type, status mapping, and initial title/description. This prevents a crash between local creation and queue publication from losing enrollment.

Existing tasks, legacy task adoption, workstream renames, and later label changes do not enroll tasks. Moving an enrolled task to another workstream does not move its external item. Editing or removing a mapping changes enrollment for future tasks only; existing bindings remain stable.

An explicit delivery-pause control stops new outbound attempts without deleting bindings or receipts; already dispatched requests may still complete and must be reconciled. Pausing delivery does not discard local changes or prevent configured new tasks from recording enrollment. Disabling enrollment and pausing delivery are distinct controls.

Configuration validation is required before activation. An unreadable or malformed configured registry must not silently behave like an unlinked workstream: reject creation before writing a task when its enrollment policy cannot be resolved. This is a local configuration error, not a Datadog outage. A valid stored mapping remains usable for local enrollment while Datadog is unavailable; network validation is not part of task creation.

## Durable local model

Keep integration state in a versioned namespace such as `piWorkManagement`, separate from `piLifecycle`. It holds:

- Immutable enrollment/binding and initial creation payload.
- External case ID, display key, and URL when known.
- Creation delivery state and stable correlation marker.
- Last acknowledged status and the local lifecycle revision it represents.
- Comment delivery receipts keyed by stable local journal identity.
- A persisted in-flight attempt descriptor for non-idempotent writes.
- Retry schedule, bounded diagnostic information, and attention reason.

Native task state and the native progress journal remain the durable source of desired work. The daemon's in-memory queue is only a scheduling aid. Scanning durable state must reconstruct pending work after a crash, including tasks already closed or deferred.

All integration metadata writes use the store's existing operation lock and read/merge/write discipline, preserving concurrent lifecycle changes and unrelated metadata. Never hold a local mutation lock during credential retrieval or network I/O. Persist an attempt under the lock, release it, perform the bounded request, then persist its result under the lock after rechecking the binding and attempt identity.

Synchronization does not claim the task, renew its execution lease, close a lifecycle check, alter dependencies, release worktrees, or change task disposition.

## Progress journal and comment identity

Only entries produced by `task_log` after enrollment are eligible. Direct `bd comments add` entries, lifecycle diagnostics, and unrelated native comments must not be inferred to be publishable progress.

For enrolled tasks only, add versioned provenance and a generated event identity to the native comment written by `task_log`, in the same native append operation as its message. The verified Beads interface does not establish structured comment metadata support, so v1 uses a reserved machine-readable footer. No second metadata write is required to discover a successfully appended log after a crash. Logging for unlinked tasks remains unchanged.

The footer is integration metadata, not part of the user's progress message. Any Pi-rendered message and external comment formatting strip it; raw native journal output may display it. Entries without valid provenance are not auto-published. Generated IDs, not message text, distinguish entries, so identical messages remain separate legitimate comments. This marker is not an authorization boundary against an actor with direct write access to the local store.

Delivery receipts associate the event identity with the stable native comment ID and any returned remote identity. Validate uniqueness and issue association before publishing. Preserve native journal order, using a deterministic tie-break for equal timestamps. A malformed or conflicting event identity stops comment delivery for attention rather than skipping an entry silently.

An external comment contains the explicit progress message, its original timestamp, local task ID, and an unobtrusive visible correlation footer. It does not automatically append transcripts, tool results, environment values, host paths, or session history. Enabling a workstream means its new task titles/descriptions and explicit logs are publishable to that project; authors must not put secrets in those fields. V1 does not promise automatic secret detection or silently rewrite the authored text. Treat all message text as data, never as executable instructions.

## Delivery behavior

### Creation

1. Scan for enrolled tasks without a confirmed remote identity, regardless of current lifecycle phase.
2. Build the request from the stored binding and initial payload. Include a unique enrollment marker in the description and the local task ID for human recognition; do not assume a local file URL is usable by Datadog readers.
3. Persist the attempt before sending it.
4. On confirmed success, store the external identity and canonical URL.
5. Synchronize the latest local status and queued progress comments.

A task completed before first delivery still receives its item; it is then brought to the current terminal status. No state-dependent backlog filter may silently drop it.

### Status

Use an explicit mapping for every outcome:

| Local state           | Mapping key          |
| --------------------- | -------------------- |
| Actionable            | `actionable`         |
| Active                | `active`             |
| Waiting on dependency | `waiting_dependency` |
| Waiting on check      | `waiting_check`      |
| Deferred              | `deferred`           |
| Done: completed       | `completed`          |
| Done: cancelled       | `cancelled`          |
| Done: superseded      | `superseded`         |

Several keys may intentionally map to the same existing Datadog status. Do not invent statuses or silently select defaults. Validate project/type/status compatibility before enabling the mapping. A project URL, type, and actual status names are deployment inputs, not assumptions fixed in this generic specification.

Local state is authoritative. Reopening a task updates the same external item rather than creating another. Status delivery may coalesce intermediate local transitions; v1 mirrors the current status, not every historical transition. Re-read local state after each acknowledgment so a newer transition is not marked delivered by an older response.

Remote status edits never modify Beads. Periodic reads detect drift and restore the mapped local status; this one-way ownership policy must be explicit when enabling the integration. Repeated rejection or automation-driven drift becomes an attention condition rather than an unbounded write loop.

### Comments

Creation must be confirmed before comments are sent. Deliver eligible entries in order, one external mutation at a time per task. Confirmed comment receipts prevent replay across daemon restarts. Editing/deleting an already delivered native entry does not edit/delete its Datadog comment in v1.

An uncertain comment blocks subsequent comments to preserve ordering. Once creation is confirmed, status delivery may continue independently of a blocked comment queue. Status synchronization must not be held indefinitely behind a progress-comment problem.

### Scheduling

Run synchronization independently of lifecycle-check eligibility. Include all enrolled tasks with pending work, and periodically check linked items for status drift. Bound scanning, network concurrency, per-task work, command duration, response size, and retries. Use fair scheduling so a noisy task or an outage cannot starve lifecycle reconciliation or other tasks.

The periodic scan provides correctness; an optional wake-up after local changes only reduces latency. A lost wake-up must never lose delivery. The daemon must recover enrollment, journal entries, and pending/in-flight attempts from persisted state without a running Pi session.

## Failure and duplicate policy

Persist explicit states: pending, in-flight, confirmed, retryable failure, paused, and attention/unknown outcome. Do not claim exactly-once delivery across Beads and Datadog.

- Failures known to occur before a request is dispatched may be retried with bounded exponential backoff.
- Rate limits respect the provider's retry guidance. Only treat a rejected response as safely retryable when its semantics establish that no mutation occurred.
- Authentication/authorization failures or invalid project/type/status configuration require attention; they do not fail an already completed local task operation.
- Transport timeout, disconnect, crash during an in-flight request, ambiguous server error, or success followed by lost local acknowledgment may represent a completed remote mutation.
- For uncertain creation, read/search within the exact bound project and verify the enrollment marker. For uncertain comments, inspect the complete relevant timeline for the event marker.
- Exactly one validated match can confirm delivery. Multiple matches require attention. Missing, incomplete, truncated, or not-yet-consistent read results do not prove absence.
- Without provider-backed idempotency or authoritative non-delivery evidence, do not automatically repeat an uncertain create/comment. Surface explicit recovery instead.
- Status requests are reconciled against current remote/local state before retrying; do not assume repeat updates lack notification or automation side effects.
- Remote deletion, archival that prevents updates, project removal, and permissions loss do not recreate the item automatically.

Recovery can confirm a matching existing item/comment, retry a provably unsent attempt, or leave delivery paused for operator investigation. A user-directed repeat of an uncertain write must disclose duplicate risk and bind approval to that exact attempt. Do not add general remote CRUD tools or a bulk recovery shortcut.

## API and authentication boundary

A focused Datadog adapter owns request/response validation, pagination, status translation, correlation markers, and error classification. The sync policy depends on adapter operations, not HTTP details. Use documented case endpoints; no browser automation or internal unauthenticated service calls.

Use the existing `dd-auth` credential-injection mechanism with explicit `--org-uuid` and `--site`, invoking a bounded child process without shell interpolation. Credentials exist only in that child environment and HTTP headers. Never use `--output`, verbose credential logging, persistent credential files, or inherited ambient credentials as a silent fallback. Validate the configured site against supported Datadog API hosts; do not send credentials to arbitrary URLs or cross-host redirects.

The installed `dd-auth --help` confirms org/site selection but does not advertise a noninteractive mode. Unattended authentication is therefore an activation gate: verify behavior with valid and expired credentials before enabling the worker. The daemon must not open login prompts repeatedly, block indefinitely, or require a model session. If supported unattended behavior cannot meet this contract, pause and ask JP about the credential mechanism rather than layering an unapproved workaround.

Do not change the conversational Datadog connection or organization. New configuration and remote writes require explicit operator activation after implementation review.

## Visibility and operational interface

Expose external key/link and independent sync health in task details/tool results and scoped work-state summaries. Distinguish `pending create`, `pending status`, `pending comments`, `paused`, and `attention`; none is a lifecycle phase. Healthy linked tasks should remain compact.

Extend the existing daemon administrative interface with focused integration configuration validation, status inspection, and exact-attempt reconciliation. Diagnostics include task ID, operation, target project, retry/attention state, and a bounded sanitized error. Never embed headers, credentials, full raw response bodies, or comment contents in routine diagnostics.

A stopped or stale daemon must be distinguishable from a healthy worker with pending work. Authentication/configuration failures should be surfaced without changing task ownership or automatically posting diagnostic comments to Datadog.

Configuration is the v1 setup surface; a Herdr settings UI and visual redesign are not included.

## Verification and activation gates

Automated coverage must establish:

1. Unlinked and pre-existing tasks produce no integration metadata or remote writes.
2. Enrollment is durable in the native task creation operation; config/label changes do not reroute it.
3. Invalid local configuration is visible and never silently suppresses expected enrollment.
4. Remote failure leaves local create, log, and lifecycle operations successful.
5. All phase/disposition mappings, reopen, rapid transitions, and close-before-delivery converge correctly.
6. Only explicit provenance-marked logs publish, in order; repeated identical messages remain distinct.
7. Crashes after task/log persistence but before wake-up, after attempt persistence, and after remote success but before receipt are handled without blind replay.
8. Ambiguous writes, incomplete pagination, duplicate markers, and eventual-consistency gaps stop unsafe retries.
9. Closed/deferred tasks and a stopped/restarted daemon retain pending work.
10. Concurrent local edits and sync receipts preserve both lifecycle and integration metadata, without network calls under a local store lock.
11. Pause, authentication failures, rejected configuration, drift, deletion, and blocked comment delivery remain visible and do not starve other work.
12. Credentials, payload text, URLs, redirects, and diagnostics respect the security boundary.

Use fake clocks, injected API/credential adapters, and the repository's existing store/daemon test fixtures. Test policy separately from HTTP contracts and runtime scheduling.

Before any live write, JP must choose and approve the target org/site/project, type/status mapping, publication behavior, and a disposable validation task. Run read-only project/permission checks first. Validate one create, status transition, and explicit comment, then inspect the remote item and local receipts. Any cleanup is a separate authorized action, not an implicit delete.

Activation requires verified marker round-tripping/timeline visibility, valid status mappings, bounded unattended authentication, and correct daemon packaging/installation. If a provider capability cannot satisfy the safe baseline, report the blocker before replacing the mechanism. No real mapping or external item is created as part of writing this specification.

## Non-goals and limitations

- No Jira provider, bidirectional synchronization, import, migration, or automatic backlog enrollment.
- No live title/description/assignee/priority synchronization after initial creation.
- No external task deletion, project moves, comment edits/deletion, or exact historical status replay.
- No guarantee of exactly-once external mutation, and no automatic repeat when the outcome is genuinely unknown.
- No changes to task authorization, session ownership, cleanup, Herdr protocols, or unrelated task reconciliation policy.
- No generalized integration framework; implement a Datadog-specific module with a narrow adapter.
- Existing local `task_create`/`task_log` retry semantics are not globally redesigned. Two separately persisted local tasks or journal entries are two distinct sources for this integration.

## References

- [Work Management overview](https://docs.datadoghq.com/incident_response/work_management/)
- [Create a case](https://docs.datadoghq.com/api/latest/case-management/create-a-case/)
- [Update case status](https://docs.datadoghq.com/api/latest/case-management/update-case-status/)
- [Comment case](https://docs.datadoghq.com/api/latest/case-management/comment-case/)
- [Get case timeline](https://docs.datadoghq.com/api/latest/case-management/get-case-timeline/)
- [Get all projects](https://docs.datadoghq.com/api/latest/case-management/get-all-projects/)
- [Local lifecycle contract](../../task-lifecycle.md)
- [Daemon operations](../../task-reconciler-operations.md)

## Next approval

JP reviews this written specification. Approval permits implementation planning, not code changes, deployment, or live Datadog writes. The plan is reviewed separately and its execution method selected before implementation.
