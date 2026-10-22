# Task reconciler operations

## Authority and activation gate

Installation and activation are separate, explicit operator decisions. Package
installation, updates, extension loading and `/reload` never install or enable
this service. There is no in-session fallback when the daemon is unavailable.
Ordinary task mutations and execution-lease renewal remain available in Pi.

Once enabled, the daemon may reconcile dependency waits, observe due PR/time
checks, and record native facts about interrupted worktree operations without an
open Pi session. It never expires ownership or initiates worktree deletion.
Wait, defer, and close require explicit release through `worktree_pool` first.
The daemon cannot claim work, launch agents, merge PRs, or infer manual outcomes. Missing or ambiguous evidence
is not success. This is a single-host design, not a distributed worker lease.

## Cutover checklist

1. Obtain approval for the exact code/runtime, configuration and Beads store.
   Validate configured absolute executable paths, reviewed lifecycle/pool policy,
   and explicit GitHub owner/account mappings. Keep the source config outside
   the package checkout with mode `0600`; see the [configuration example](../README.md#optional-task-reconciliation-daemon).
2. Stop any old standalone daemon using its own verified administration path.
3. **Retire every old Pi process using this store** or reload each onto the new
   package. For this ownership-policy cutover, use `/reload` rather than quitting
   an old session: its old shutdown hook may still release worktrees. An old loaded
   extension can also perform in-session reconciliation; updating files alone
   does not retire loaded JavaScript. Inventory all sessions
   and verify their loaded version before continuing. The daemon singleton cannot
   prevent legacy code that does not acquire that lock from reconciling.
4. After installation approval, prepare the inactive service:

   ```sh
   npm ci --ignore-scripts
   cfg="$HOME/.pi/task-reconciler/config.json"
   node bin/task-reconciler.mjs install --config "$cfg"
   node bin/task-reconciler.mjs status --config "$cfg"
   ```

   Installation publishes the complete verified runtime, configuration and
   ownership manifest with one directory rename. It does not bootstrap launchd
   or publish the login agent. A crash before publication can leave an unselected
   private `.install-*` sibling directory; retries neither adopt nor delete it,
   and it does not block a new explicit install. Confirm status reports
   installed but disabled/unloaded before requesting activation approval.

5. After activation approval, explicitly start and inspect:

   ```sh
   node bin/task-reconciler.mjs start --config "$cfg"
   node bin/task-reconciler.mjs status --config "$cfg"
   ```

   In a current Pi session the equivalent commands are `/task-reconciler start`
   and `/task-reconciler status`; `PI_TASK_RECONCILER_CONFIG` selects a non-default
   source config. Verify the loaded PID, runtime version, fresh heartbeat and
   recent scan. Login enablement does not imply logout/headless persistence;
   this is a macOS user LaunchAgent in `gui/<uid>`.

6. Observe a bounded window of authorized real work. Verify persisted task state
   and notices, not merely a green health file. Do not manufacture manual outcomes
   or create throwaway live tasks to exercise the daemon.

## Reviewed area and project activation

Catalog activation is a separate approval gate. These commands never migrate
remote items, rewrite existing task membership/lifecycle/journals, run on startup,
install code, or restart a daemon. Existing captured destinations—including
pending creates—remain authoritative. Keep private assignments, plans, backups,
and configuration outside public commits.

1. **Inspect and review placement.** Inventory the exact store's legacy labels,
   rename aliases, archives, unscoped tasks, and existing bindings. Review every
   project-to-area assignment and description; do not infer scope from a name
   prefix. Include archived projects and alias-only entries. Every area requires
   a complete explicit policy: `{ "mode": "local" }`, or
   `{ "mode": "datadog", "target": ... }` using the full approved target schema
   in the [work-item configuration guide](task-lifecycle.md#optional-datadog-work-items).
   Review site/org/project/type/status mapping, assignee, and custom attribute.
   Each project assignment names its canonical legacy project and area name.
   Deliberate `area: null` / `description: null` must be explicit, not omitted.
   A minimal private assignments file looks like:

   ```json
   {
     "version": 1,
     "areas": [
       {
         "name": "Tooling",
         "description": "Shared developer tooling and maintenance.",
         "publication": { "mode": "local" }
       }
     ],
     "projects": [
       {
         "name": "editor",
         "area": "Tooling",
         "description": "Editor integration and its maintenance."
       }
     ]
   }
   ```

   This is only a shape example, not a suggested mapping. If the old store has
   no WM config, assignments must also provide `helpers: { "ddAuthPath":
"/absolute/trusted/dd-auth", "curlPath": "/absolute/trusted/curl" }`.
   Existing helpers are preserved when overrides are omitted. The full catalog
   must fit 63 KiB; plans/backups have a separate 1 MiB bound.

2. **Preview without store writes.** Use explicit paths under owned, non-shared
   directories. The output must not already exist; it is mode `0600`.

   ```sh
   npm run catalog -- preview --store STORE --assignments ASSIGNMENTS --output PLAN
   ```

   Inspect the saved plan's generated IDs, checksum, source fingerprint,
   prepared catalog, old/new configuration, unclassified/missing-description
   diagnostics, archives, and captured-destination mismatch counts. Preview
   reads only local store/configuration data and writes the requested plan; it
   does not validate remote access or prove mappings were approved. Do not edit
   the saved plan to bypass a stale-source refusal.

3. **Obtain cutover approval and pause creation/catalog edits.** Install/update
   the compatible package and daemon using their existing approval gates.
   Reload or retire _every_ old Pi session using this store; files on disk do
   not replace loaded code. Inventory the clients explicitly. Build/verify the
   matching runtime with `npm run build:reconciler -- --json`; the artifact must
   declare `workCatalogVersion: 1`. Verify the running daemon's fresh heartbeat
   and matching `runtimeVersion` against that artifact. The CLI checks this
   local evidence, but cannot prove all old clients have retired. Existing
   compatible delivery can continue using captured bindings.

4. **Prepare the reviewed plan.** Under the shared store mutation lock, this
   rechecks the source/config fingerprint, retains and reads back a private
   backup in `STORE/pi-work-catalog-migrations/PLAN_ID.json`, then writes and
   verifies the exact prepared catalog. No task data changes.

   ```sh
   npm run catalog -- prepare --store STORE --plan PLAN
   ```

   Prepared + v1 still permits legacy creation, so the operator's temporary
   creation pause is essential. Any relevant source/config changes require a
   new review; stale plans are refused rather than silently regenerated.

5. **Activate only after approval.** Supply the matching verified build directory:

   ```sh
   npm run catalog -- activate --store STORE --plan PLAN --runtime BUILD_DIR
   ```

   It revalidates source, backup, exact prepared catalog, and live compatible
   runtime. Before writing config it checks helper executables. It atomically
   publishes/read-backs v2 WM config
   first, then writes/read-backs the active catalog. V2 + prepared catalog
   deliberately blocks task creation; compatible delivery still uses existing
   snapshots. Active + v2 allows only classified, unarchived projects and their
   area's policy, without legacy fallback. No generic force flag exists.

6. **Read back before resuming creation.** Inspect catalog state/revision/IDs,
   exact v2 config, daemon health, and `/area`, `/project`, and `/tasks`. Compare
   saved existing task bindings/lifecycle/comments; do not create a disposable
   live task without separate approval. Missing descriptions and unclassified
   imported projects remain explicit review work, not implicit guesses.

### Interrupted cutover and rollback boundaries

There is no automatic apply retry or rollback. An error can mean the write
committed but its reply/read-back failed. Preserve the same saved plan and inspect
its IDs/checksum, private backup, actual catalog state/revision, and actual config
before authorizing recovery. Preparation and activation recognize only exact
already-applied states; recovery never allocates replacement IDs.

- No catalog/prepared + original config: inspect backup and source before an
  explicitly approved exact-plan prepare/activate.
- Exact prepared + exact v2: creation stays blocked. After inspection, finish the
  **same** plan with compatible runtime; do not restore a default target.
- Exact active revision 1 + exact v2: the same activation verifies a completed
  operation without rewriting task data, even if new tasks now exist.
- Different catalog, source, config, or missing/contradictory backup: stop and
  review; no force, metadata deletion, or blind replay.

Before any incompatible code/config rollback, prove whether post-activation
project references, tasks, or v2 session scopes exist across all clients. If they
exist or evidence is incomplete, retain compatible code and request a reviewed
reverse-migration decision. Deleting metadata is not rollback. Moving existing
remote items is always a distinct, explicitly authorized operation.

## Health and diagnostics

`status` is read-only. A healthy heartbeat shows process liveness, runtime/protocol
version, scan timestamps, queue counts and bounded diagnostics; it does not prove
all external systems are reachable. Healthy service operation can coexist with
individual checks in error/backoff. Discovery defaults to one minute, PR polling
to fifteen minutes, with one local lane and two external observations.

- **Unavailable:** check explicit installation/start, canonical store and source
  config selection. Do not fall back to local reconciliation.
- **Stale:** inspect process/service status and last scan. Stop normally before
  replacement; a stale heartbeat alone does not authorize deleting ownership.
- **Incompatible:** explicitly update the installed runtime/protocol. Reloading
  Pi or updating the package does not replace the running daemon.
- **Check attention and repeated errors:** notices include the task ID/title and
  its recorded observation (for example `merge_conflict` or `changes_requested`).
  Missing observations are explicitly reported as “no reason recorded”; inspect
  the task in `/tasks`. Text is normalized for terminal safety and truncated
  with an ellipsis, not populated from raw command output.

- **Pending release:** a present, valid explicit release remains pending until
  the owner retries it. Reconciliation does not retry deletion. Historical automatic
  cleanup reservations are cancelled only with valid native evidence; already
  removed claims are finalized. Preserve ambiguous or contradictory evidence;
  do not delete lock or worktree directories to make a warning disappear.

Health notices distinguish unavailable health (with its recorded reason), stale
heartbeats (with the last heartbeat timestamp), and a running daemon with queue
diagnostics. Queue summaries show up to three diagnostic codes with affected
task IDs/titles when available, plus the number omitted; `/task-reconciler status`
shows the full bounded diagnostic list. Notices remain deduplicated and do not
repair issues, install/activate the daemon, or change task state.

Private runtime/health files are under the configured runtime root. The lifetime
singleton is instead anchored at `<canonical-store>/pi-task-reconciler`, so a
second runtime root cannot bypass ownership. Service administration serializes
updates and requires verified ownership of all files it changes. Foreign labels,
unknown launchctl output and ambiguous draining PIDs fail closed.

## Beads-managed Dolt servers

When Beads owns a local Dolt server's startup and recovery, add its absolute
executable path as `executables.dolt` in the daemon source configuration. The
loader validates and canonicalizes it like the other executables, and its
containing directory enters the daemon's restricted `PATH`. A running server
can hide a missing dependency until the next cold start or crash recovery.
Do not rely on the interactive shell's `PATH` or hand-edit the generated plist.

Dolt remains optional for embedded stores and independently managed servers.
Older Pi clients and daemon runtimes reject the new configuration key. First
load compatible package code and reload every Pi session using this store;
clients also parse the installed daemon configuration when checking health or
requesting reconciliation. Update the installed runtime with the existing
configuration, then add `executables.dolt` and perform another explicit update
to install that configuration. Changing the source JSON alone does not update
the installed runtime snapshot. Before rolling back to a runtime without this
field, restore compatible source configuration.

## Authentication recovery

GitHub account mappings are explicit and case-normalized by repository owner.
The daemon asks `gh` for the configured account's token per observation, injects
it only into that PR command, and neither switches the global active account nor
writes tokens into configuration/health. Authorize the intended account through
an operator-controlled interactive flow, then verify without displaying credentials.

```sh
GH_PROMPT_DISABLED=1 gh auth token --hostname github.com --user ACCOUNT >/dev/null
```

Respect persisted backoff or explicitly reconcile the affected task. Update the
installed config when changing mappings; changing the source JSON alone does not
change the installed snapshot. Do not copy credentials into runtime JSON or logs.

## Unknown results and exact retries

A client timeout/disconnect does not cancel accepted work. For `task_reconcile`,
keep the returned `retry` object exactly: task ID, request ID, manual outcome and
expected check fingerprint. Retry that binding rather than creating a new manual
request from whatever check is current. A committed operation may reply
`already_applied`; a replaced check rejects stale new requests. Successful replies
are narrow task summaries, not complete task records. Read Beads for full state.

## Update, rollback, stop and uninstall

Use the bundled launcher or the corresponding explicit Pi administration command:

```sh
node bin/task-reconciler.mjs update --config "$cfg"
node bin/task-reconciler.mjs update --rollback --config "$cfg"
node bin/task-reconciler.mjs stop --config "$cfg"
node bin/task-reconciler.mjs uninstall --config "$cfg"
```

Update stops and confirms draining **before** compiling/selecting new policy. It
restarts only a previously loaded, enabled service. A failed update stays stopped;
there is no automatic policy rollback. The previous immutable runtime/config is
retained for explicit rollback. Repeating an unchanged update preserves the
last distinct rollback selection. Rollback reads the installed assets rather
than the original policy files/tools, and validates the selected retained
configuration before allowing restart. Rolling back a stopped service leaves it stopped;
start separately after inspecting the selected version.

The stable installed admin entry survives generated package-output cleanup.
Stop/status/uninstall use the installed snapshot, and missing old source policy
files or retired executables do not prevent shutdown. Unconfirmed draining PIDs
remain recorded across retries. Never interpret a timeout as proof of shutdown.
Stop disables login loading and drains owned work. Uninstall removes only verified
service-owned files after ownership/process checks; it preserves the Beads store
and original configuration. These commands do not switch Pi back to legacy local
reconciliation. Returning to legacy code requires a separate stopped-daemon,
all-sessions cutover decision.

## Repeatable verification

```sh
npm run test:file -- tests/task-reconciler-integration.test.ts
npm run test:file -- tests/task-reconciler-packaging.test.ts
npm run verify:smoke
npm run probe:reconciler -- --db /absolute/store --bd /absolute/path/to/bd
```

The integration uses a temporary CLI-backed fixture store, real temporary Git/pool
state, fake GitHub and the built foreground daemon. It covers queue pressure past
100 tasks, two clients, failed observations, retained pipes, dirty-resource
refusal, concurrent lease renewal, commit-before-reply loss, crash/restart, exact
manual retry/replacement protection and graceful shutdown. It is not a real
embedded-Dolt or live launchd test. Packaging tests use an injected launcher;
actual macOS plist lint runs without loading the agent. Real launchd install/start
and live unattended transitions remain separately approval-gated.

The probe requires an explicit absolute store and `bd` executable; it ignores
implicit store selection. Its command boundary permits only `list` and `show`,
with a 10-second command bound and 20-second overall deadline. It constructs no
mutating service or queue and reports aggregate selection reasons, diagnostics,
command counts and elapsed time. An eligible candidate is not a promise that
reconciliation will mutate it: checks still require observation and fresh-state
validation. Run against a real store only with read-only inspection approval.

## Work Management delivery

The daemon can deliver work items using the optional
[publication configuration](task-lifecycle.md#optional-datadog-work-items). It uses
the existing scan interval and shares the external concurrency limit with check
observations. It scans enrolled closed/deferred tasks too. A transient rejection
with a known non-applied outcome (such as HTTP 429) is retried with bounded
backoff, respecting a longer Retry-After. Network/command uncertainty is never
retried blindly. There is no separate service or integration-specific pause CLI.

Before activation, obtain explicit approval for the org, site, project, type,
status mapping, and any disposable validation task. In legacy v1 mode, a default destination enrolls
all newly created tasks without an explicit workstream override or opt-out,
including tasks without a workstream; review that publication scope too.

Before adding `defaultTarget`, null workstream opt-outs,
`statuses.waitingOnPullRequest`, `assigneeId`, or `workstreamAttributeKey`, update
the installed daemon runtime and reload every Pi session using the store onto
code that supports those fields. Older
parsers reject default/null configuration: task creation fails closed and
enrolled-task delivery cannot read its configuration. They also discard an
unrecognized PR-wait override, assignee, or workstream metadata when decoding a
captured binding. Verify the assignee is the intended user in the destination
org and the custom attribute exists with single-value TEXT semantics before
activation. Changing a shared case type requires separate approval.
For rollback to an older runtime, first restore compatible configuration (omit
`defaultTarget` and null entries), and review existing bindings: an older worker
cannot preserve newer optional fields. Do not create new tasks during this
coordinated cutover. No existing tasks are backfilled by activation.

Verify the configured curl
supports variables (`curl --version`, minimum 8.3.0). Use unmodified stock
`dd-auth`. Browser authentication is supported: authentication is completed
before the daemon reserves or sends a write. Verify the stock helper with a
read-only probe; unit tests use fake credentials and do not establish live
compatibility.

If login does not complete within the command deadline, work remains pending
with bounded retry/backoff. Pi shows `WM login needed` and an existing task notice
with the exact org/site login command, once per affected org until recovery.
Run that command in a terminal (or ask the agent to run it) and finish browser
login; pending work resumes on a subsequent retry. For example:

```sh
dd-auth --org-uuid ORG_UUID --site datadoghq.com -- true
```

Stock `dd-auth` owns browser login and credential caching. Pi captures its
supported `--output` privately in process memory, then passes the two keys only
in curl's environment. Authentication never receives the write payload. A
restart while authenticating leaves work pending; a restart after the durable
write reservation enters read-back recovery without replaying the uncertain write.

The helper uses explicit org/site selection, native curl environment-variable
expansion, and JSON on stdin. It ignores curlrc, disallows redirects and automatic
curl retries, restricts targets to supported HTTPS API hosts, and imposes input,
output, and time bounds. It does not use shell interpolation or print credentials.
Do not enable verbose authentication logging or log raw command output. Never
run `dd-auth --output` directly in a visible terminal or attach its output to a
report; it contains credentials.
A configured helper must be trusted local software, not an unreviewed script.

Installing/updating the daemon runtime and enabling a real configuration are
separate operator actions; building this package does neither. Use the existing
`stop`/`start` commands for an operational off switch. Stopping affects other
reconciliation work too and cannot undo a request already dispatched. Local sync
persistence drains under the existing command and lock deadlines rather than
being cancelled with lifecycle work, allowing an already-known result to be
recorded. A stalled receipt write leaves its in-flight marker for remote inspection.

### Forward-only automatic recovery

New case descriptions and progress comments carry a versioned `Pi sync: v1/…`
reference scoped to their captured org/project and native task/comment identities.
Do not remove that reference when editing a case. Existing attention records are
not reopened, and old unmarked comments are not matched by text or backfilled.

An unknown send retains its durable reservation and schedules observation with
backoff. A restart with an unfinished reservation also observes before doing
anything else:

- A unique matching case binds its existing ID/link and observed status.
- A unique matching marked comment records its native comment receipt without
  posting again. Matching requires the full new comment payload, not just a
  reference copied onto different content.
- A status observation records actual remote state. The next ordinary sync step
  compares that state with current local intent, so a newer local transition is
  not replaced by the old reserved status.

Reads run outside the local metadata lock; their results are committed only if
that task's captured Work Management state is still current. Authentication,
transport, rate-limit, and malformed/inconsistent-page failures back off while
preserving the reservation. Missing or conflicting deliveries, wrong bindings,
permission/deletion errors, and scan limits require attention. Even an absent
comment in a complete read does not authorize another POST: an earlier request
could still complete later.

Each observation has one configured command-timeout budget, including login and
all pages. Scans request 50 items per page and stop after at most 20 pages. Case
search is one-based and validates reported page totals; timelines are zero-based
and can omit pagination metadata, so they continue to an empty page. Incomplete
scans never acknowledge a partial match. This is uncertainty recovery, not
periodic remote-drift correction or two-way synchronization.

### Inspect and recover an uncertain operation

1. Inspect the task's compact WM indicator and existing daemon diagnostics.
   `work_management_scan_failed` or `work_management_sync_failed` is a local
   inspection failure; `work_management_attention` covers a delivery problem.
   Check daemon health as well: a stopped worker cannot update task indicators.
2. For manual repair, stop the daemon, allow bounded child requests to finish, and
   pause concurrent changes to the affected task. Read the current task using
   `bd show TASK --long --json --db STORE`. Inspect only its `piWorkManagement`
   binding, `inFlight`, `failure`, and receipts; do not reset lifecycle state.
3. Confirm the actual result in the exact Datadog org/project. An absent item in
   an incomplete search is not proof of non-delivery. If still uncertain, leave
   the task paused; repeating it requires explicit approval of duplicate risk.
4. With the exact repair reviewed and authorized, use Beads' supported
   `bd update TASK --metadata '<complete current metadata JSON>' --db STORE`.
   Preserve all other metadata, especially `piLifecycle`, and do not supply `-s`.
   For a confirmed create, record the remote ID/link and actual sent status; for
   a confirmed comment, add only the in-flight native comment ID to receipts;
   for a confirmed status update, record the in-flight `statusName`, not a newer
   local status. Only then clear `inFlight` and `failure`. For a provably unsent
   operation, clearing those fields permits a new attempt without adding a receipt.
5. Re-read and verify the repair, then restart the daemon. Do not change the
   captured project/mapping to repair delivery. Native comments and local
   lifecycle changes remain the source of pending work.

Manual repair remains necessary for old unmarked or genuinely ambiguous
operations. Remote item deletion or lost permissions do not cause automatic
recreation. Cleanup of a live validation item requires separate approval; it is
not an implicit activation step.
