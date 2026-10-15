# Forward-only Work Management delivery recovery

Task: `jp-7meg`

## Intent and approved policy

Recover uncertain Work Management deliveries through remote observation instead of treating every lost acknowledgment as permanently unrecoverable. JP chose strict duplicate safety and explicitly excluded legacy-comment support: look forward only.

- A uniquely identified remote delivery can be acknowledged locally without reposting.
- Failed or temporarily incomplete reads back off without dropping the in-flight intent.
- An absent or ambiguous uncertain create/comment is not permission to replay it.
- No exact-text fallback for old, unmarked comments; no backfill or repair of JPR-5.
- Beads remains authoritative for task lifecycle. This change does not implement two-way synchronization or general periodic drift correction after successful delivery.
- No remote push, live repair, or runtime activation is included in implementation authority.

## Delivery identity

New case descriptions and comment payloads carry a versioned, deterministic, plain-text sync reference. Its identity includes the captured org/project and native task ID; comments additionally include their native comment ID. Scope case searches to the captured project. A linked case must match the captured project/type before it supplies recovery evidence.

Keep the current Work Management metadata schema and reservation mechanism. Stable references are derived from existing identifiers rather than introducing another durable outbox or store migration. Existing attention records are not automatically reopened. Pending in-flight work encountered after restart can only be confirmed through the new reference protocol (or a case status read), never legacy comment matching.

## Recovery flow

Normal sending retains authentication before reservation, the durable in-flight marker before POST, and exact-state comparison before receipt persistence.

For a newly uncertain send, preserve the marker and schedule a read-back attempt with the existing backoff. On restart, a pending in-flight operation enters observation rather than being blindly resent.

- **Case creation:** perform a bounded, project-scoped case search. One matching versioned creation reference supplies the existing case ID/link and observed status. Zero or multiple matches require attention; do not create another case.
- **Comment:** verify the linked case binding and read its paginated timeline. Only a COMMENT cell matching the new formatted payload/reference counts. A unique confirmed match adds the native comment receipt. Zero or multiple matches require attention; do not append another comment.
- **Status:** read the linked case's current status and record that observation, clearing the uncertain reservation. The existing desired-status comparison then converges to the latest local lifecycle status, not a stale status captured before a local transition.

Remote I/O runs outside the local metadata lock. Persist an observation only if the captured Work Management state is still exactly current. A concurrent pause, rebind, or acknowledgment must not be overwritten.

## Read safety and bounds

Reuse the existing explicit org/site authentication, fixed HTTPS API hosts, credential confinement, no redirects, no curl retries, and bounded command execution. Read errors must not be classified as evidence that a write was absent.

Implementation choices: page size 50, at most 20 pages per observation, and one overall observation deadline bounded by the configured external timeout. Case search starts at page 1 and uses validated pagination totals when present; without totals it continues to an empty page. Timelines start at page 0 and continue to an empty page because the live response can omit pagination metadata. Reject malformed pages and repeated page IDs as incomplete evidence. A scan limit or permanent binding/permission error remains visible and never triggers replay. Transient transport, authentication, and rate-limit failures use backoff.

## Verification

Focused regressions must cover:

- New deterministic references and absence of legacy matching.
- A remote comment on a later page; empty terminal page; duplicate references; no match; malformed/truncated/repeated pages and bounds.
- Wrong project/type, deleted case, and permission failure.
- A POST that succeeds remotely but loses its local acknowledgment, followed by restart: one POST, recovered receipt, then subsequent work proceeds.
- Changed local metadata during a remote read: no stale receipt is persisted.
- New local status while an older status is uncertain: converge to the latest local intent.
- Read errors and shutdown preserve the reservation and remain retryable where safe.
- Existing stopped/attention records remain untouched, including the old JPR-5 comment.

Run the relevant tests, typecheck, formatting, portable checks, build, and full suite before claiming completion. Existing pool-concurrency test history is not a waiver for a new failure. Live mutation and activation validation require separate approval.
