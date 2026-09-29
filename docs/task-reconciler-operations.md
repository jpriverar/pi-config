# Task reconciler operations

## Authority and activation gate

Installation and activation are separate, explicit operator decisions. Package
installation, updates, extension loading and `/reload` never install or enable
this service. There is no in-session fallback when the daemon is unavailable.
Ordinary task mutations and execution-lease renewal remain available in Pi.

Once enabled, the daemon may reconcile dependency waits, observe due PR/time
checks, expire stale execution leases, and finish safe pending resource cleanup
without an open Pi session. It cannot claim work, launch agents, merge PRs, infer
manual outcomes, or force-delete unsafe worktrees. Missing or ambiguous evidence
is not success. This is a single-host design, not a distributed worker lease.

## Cutover checklist

1. Obtain approval for the exact code/runtime, configuration and Beads store.
   Validate configured absolute executable paths, reviewed lifecycle/pool policy,
   and explicit GitHub owner/account mappings. Keep the source config outside
   the package checkout with mode `0600`; see the [configuration example](../README.md#optional-task-reconciliation-daemon).
2. Stop any old standalone daemon using its own verified administration path.
3. **Retire every old Pi process using this store** or reload each onto the new
   package. An old loaded extension can still perform in-session reconciliation;
   updating files alone does not retire loaded JavaScript. Inventory all sessions
   and verify their loaded version before continuing. The daemon singleton cannot
   prevent legacy code that does not acquire that lock from reconciling.
4. After installation approval, prepare the inactive service:

   ```sh
   npm ci --ignore-scripts
   cfg="$HOME/.pi/task-reconciler/config.json"
   node bin/task-reconciler.mjs install --config "$cfg"
   node bin/task-reconciler.mjs status --config "$cfg"
   ```

   Installation copies a verified Node-only runtime and configuration. It does
   not bootstrap launchd or publish the login agent. Confirm status reports
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
- **Repeated check errors:** inspect the affected task and account configuration.
  Pi presents deduplicated attention notices, not raw observation/error strings.
- **Pending cleanup:** preserve dirty, live, missing or contradictory worktree
  evidence. Use the normal pool inspection/repair workflow; do not delete lock or
  worktree directories to make a warning disappear.

Private runtime/health files are under the configured runtime root. The lifetime
singleton is instead anchored at `<canonical-store>/pi-task-reconciler`, so a
second runtime root cannot bypass ownership. Service administration serializes
updates and requires verified ownership of all files it changes. Foreign labels,
unknown launchctl output and ambiguous draining PIDs fail closed.

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
retained for explicit rollback. Rolling back a stopped service leaves it stopped;
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
