# Herdr Sidebar Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Show each interactive Pi session's actual model, claimed task, and high context pressure, plus active-tab/tab-count space rows without Git information.

**Architecture:** Add a display-only metadata sink to the existing project-status extension, reusing its Beads issue read. Keep pane publication separate from lifecycle authority and headless children. A small Herdr-owned event plugin independently publishes space navigation metadata, including spaces with no Pi agent.

**Tech Stack:** TypeScript, Node built-ins and node:test/tsx; Python 3 standard library and unittest for the macOS/Linux Herdr plugin; Herdr 0.8.0 CLI/plugin APIs; existing Pi APIs.

**Spec:** `docs/superpowers/specs/2026-10-06-herdr-sidebar-metadata-design.md`

**Work item:** `jp-u1aq`

## Global Constraints

- Target installed Herdr 0.8.0; no upgrade, fork, or edits to managed `herdr-agent-state.ts`.
- Publish pane metadata only with Herdr context and `ctx.mode === "tui"`; never infer eligibility from `hasUI` alone.
- Own only `pi_model`, `pi_task`, `pi_context_warning`, and `pi_context_critical`; preserve semantic state, state labels, and `$summary`.
- Space tokens are `active_tab` and `tab_count`. Space rows contain no `branch` or `git_status`.
- Context thresholds: warning at 75–<90%, critical at >=90%; floor the displayed percentage; unknown/non-finite/below75 hidden.
- Task labels: title for one matching unexpired active claim; `Unassigned` only after a successful no-claim read; `Task unavailable` for lookup failure/conflict; `Lease expired` for one matching expired active record.
- Reuse normalized Beads issue reads; no second task store, binding record, authority, general task event system, or polling daemon.
- Metadata values are display-only, sanitized, bounded to 80 characters, and passed through structured argv/JSON.
- Bound subprocess and lock waits. A Herdr failure must not block task tools or model turns.
- Startup reconstructs values. Shutdown owns cleanup only for its own fields and session generation.
- Preserve theme, sidebar width/spacing, other agent layouts, and existing project header behavior.
- No production task mutation in tests, no live server stop, no automatic merge or package-source cutover.

## Review Focus

1. An RPC child inheriting Herdr variables must not write metadata or clear its parent's fields (Task 2).
2. A slow old-session refresh/cleanup must not overwrite a replacement session or access stale Pi objects (Task 2).
3. A successful task lookup followed by an unrelated ready/closed-query failure must not become a false `Unassigned` result (Tasks 1–2).
4. Renewed leases and failed/uncertain task mutations must be re-read rather than optimistically displayed (Task 2).
5. A malformed snapshot, timeout, or rapid tab-event burst must not clear good metadata or deadlock future refreshes (Task 3).

---

## File ownership

- `extensions/project-status/herdr-values.ts`: pure normalization, model/context projection, and display-only task assignment selection.
- `extensions/project-status/herdr-pane.ts`: session-scoped asynchronous/coalescing reporter, lifecycle cleanup, and one-shot expiry scheduling.
- `extensions/project-status/herdr-transport.ts`: bounded argv-only Herdr metadata delivery and response validation.
- `extensions/project-status/index.ts`: integrate the sink with existing query/lifecycle events without changing the visible Pi project header contract.
- Adjacent `.test.ts` files: behavior tests for those boundaries.
- `plugins/herdr-space-tabs/herdr-plugin.toml`: macOS/Linux startup/event/action entrypoints.
- `plugins/herdr-space-tabs/sync_tabs.py`: bounded serialized snapshot-to-metadata refresh.
- `plugins/herdr-space-tabs/test_sync_tabs.py`: derivation and subprocess/locking behavior tests.
- `plugins/herdr-space-tabs/sidebar.example.toml`: logical Pi/space row settings and warning/critical styles.
- `plugins/herdr-space-tabs/README.md`: operation, explicit activation, troubleshooting, and rollback.
- `package.json`: include the plugin's tests in normal verification; no new npm runtime dependencies or new Pi extension entrypoint.
- `README.md`: brief link to the feature and operational guide.

## Task 1: Pure pane display values

**Files:** create `extensions/project-status/herdr-values.ts` and `.test.ts`.

**Interfaces:**

```typescript
export type PaneTokens = Record<
  "pi_model" | "pi_task" | "pi_context_warning" | "pi_context_critical",
  string | null
>;
export interface TaskAssignment {
  label: string;
  expiresAt?: number;
}
export function selectTaskAssignment(
  issues: readonly BeadsIssue[] | undefined,
  sessionId: string,
  now: number,
): TaskAssignment;
export function runtimeTokens(
  model: { name?: string; id: string } | undefined,
  usage: { percent: number | null } | undefined,
): Pick<PaneTokens, "pi_model" | "pi_context_warning" | "pi_context_critical">;
export function normalizeMetadata(value: string): string;
```

- [x] Write failing tests with literal expected values: owned task title and lease deadline, another session's claim => `Unassigned`, failed lookup => `Task unavailable`, multiple active records => unavailable, exact expiry => expired, and hostile/long text normalization.
- [x] Add literal context cases `74.99 => hidden`, `75 => warning Context 75%`, `89.99 => warning Context 89%`, `90 => critical Context 90%`, `null/NaN => hidden`; verify the opposite token is cleared. Test model name/ID fallback and removal of redundant branding without collapsing distinct model IDs.
- [x] Run `npm run test:file -- extensions/project-status/herdr-values.test.ts`; confirm missing behavior causes failure before implementation.
- [x] Implement the pure functions using normalized `BeadsIssue` lifecycle fields and the existing model-formatting precedent. Invalid ownership/lease evidence must not claim assignment; keep display sanitization separate from authority.
- [x] Re-run focused tests; require all passing.
- [x] Stage only these files, inspect `git diff --cached --name-only`, and commit `feat: derive Herdr pane metadata`.

## Task 2: Session-scoped pane publisher and existing-query integration

**Files:** create `herdr-pane.ts`, `herdr-pane.test.ts`, `herdr-transport.ts`, `herdr-transport.test.ts` alongside project-status; modify `index.ts` and `index.test.ts`.

**Interfaces:** consumes Task 1 functions/types. Produces:

```typescript
export interface PaneReporter {
  updateRuntime(ctx: ExtensionContext): void;
  updateTask(assignment: TaskAssignment): void;
  stop(): Promise<void>;
}
export function createPaneReporter(options: {
  context: ExtensionContext;
  refreshTask: () => Promise<void>;
  send: (tokens: PaneTokens, sequence: number, signal: AbortSignal) => Promise<boolean>;
}): PaneReporter | undefined;
export function createHerdrMetadataSender(environment: NodeJS.ProcessEnv):
  ((tokens: PaneTokens, sequence: number, signal: AbortSignal) => Promise<boolean>) | undefined;
```

Keep clock/timer/executor injection local to these modules where required for deterministic tests; do not create a general framework.

- [x] Write failing transport tests against a controlled executable or subprocess port: exact `pane report-metadata` argv with stable source and sequence, explicit clearing of null keys, safe whitespace/metacharacters, valid response handling, timeout/cancellation, and unavailable executable. Use a finite timeout (1500ms) and bounded captured output (64KiB); no automatic retry loop.
- [x] Write failing reporter tests for TUI-only eligibility, initial values, model/pressure changes, unchanged-value suppression, one in-flight send with latest-value coalescing, failed sends retried only by the next meaningful refresh, cleanup of owned keys, and bounded stop while a send is stuck.
- [x] Write failing expiry/session tests: one-shot lease deadline requests authoritative refresh; renewed lease reschedules; shutdown cancels its timer; stale prior-session work cannot send or clear replacement values. No periodic task polling.
- [x] Extend existing project-status test harness at the external Beads/Herdr boundary. Test task claim/release/failure refreshes and preserve existing widget assertions; do not assert that model handlers are absent merely because the header itself has no telemetry.
- [x] Run the targeted tests and confirm failures before implementing each component.
- [x] Implement bounded transport using Node subprocess APIs with argv, not a shell. Stable source `jp:pi-sidebar`; monotonically ordered report sequences; parse acknowledgment instead of treating any stdout as success.
- [x] Implement the reporter and connect it to the existing extension: startup establishes the eligible reporter; shutdown invalidates refresh generations before bounded cleanup; model selection/compaction/tree/turn boundaries update runtime values. Avoid every streaming delta.
- [x] Derive `TaskAssignment` from the existing successful `listIssues()` response independently of later ready/closed count reads. An unavailable issue read publishes unavailable. Preserve the existing header projection/behavior.
- [x] Serialize/coalesce task refreshes across startup, before-agent-start, turn-end, session-name changes, expiry, and completion of task-changing tools (`task_claim`, `task_wait`, `task_defer`, `task_close`, `task_reopen`, `task_reconcile`). Re-read after failed or uncertain mutations. Prevent stale-session access after any await.
- [x] Run `npm run test:file -- extensions/project-status/*.test.ts` and `npm run typecheck`; require passing results without header regressions.
- [x] Inspect staged paths and commit `feat: report Pi metadata to Herdr`.

## Task 3: Event-driven space navigation metadata

**Files:** create the plugin manifest, Python implementation, tests, example rows, and README under `plugins/herdr-space-tabs/`; modify test script and top-level README.

**Interfaces:** `workspace_tokens(snapshot: dict) -> dict[str, dict[str, str]]` derives `active_tab` and `tab_count`; CLI entrypoint refreshes through `herdr api snapshot` and `herdr workspace report-metadata`. Herdr provides `HERDR_BIN_PATH`, `HERDR_PLUGIN_STATE_DIR`, and the current socket environment.

- [x] Write failing Python tests for 0/1/many tabs, exact active-tab labels, missing/foreign active IDs, no arbitrary fallback, changed-only publication, clearing absent values, and rejection of malformed snapshot structure.
- [x] Add behavioral tests using test-owned executables/state directories for bounded command timeout, error/malformed replies, disappearing workspace, serialized concurrent refreshes, lock timeout, and avoiding a stale snapshot write after a newer refresh. Never use live Herdr in unit tests.
- [x] Run `python3 -m unittest discover -s plugins/herdr-space-tabs -p 'test_*.py'`; verify missing behavior fails.
- [x] Implement with Python standard-library subprocess/JSON/filesystem/flock support on macOS/Linux. Use a finite per-command timeout and finite nonblocking-lock deadline; do not wait indefinitely. Acquire the lock before reading the snapshot and keep it through changed-token publication.
- [x] Add the manifest with `min_herdr_version = "0.8.0"`, startup/refresh action, and the six workspace/tab event hooks from the spec. All entrypoints use argv arrays. No installer downloads or background processes.
- [x] Add the two-row space layout (no Git fields) and Pi override with fixed warning/critical styles. Document expanded-sidebar scope, explicit first refresh on activation, bounded failure behavior, and disabling/rollback.
- [x] Add Python tests to normal `npm test` verification without changing the existing Node test selection. Update top-level README to link the feature; avoid unrelated package changes.
- [x] Re-run Python tests and `npm run typecheck`; inspect staged paths and commit `feat: show Herdr space tab metadata`.

## Task 4: Whole-change verification and activation checkpoint

**Files:** adjust only the preceding files if verification identifies defects; record results in the work item. Local configuration is a later explicit activation operation, not part of a repository commit.

- [x] Run the full repository `npm test`, `npm run typecheck`, `npm run format:check`, `npm run verify:portable`, and `npm run verify:smoke`, with bounded foreground execution/background logging where required. Report unrelated failures rather than hide them. Run the repository license check if code/dependencies were imported.
- [x] Have an independent reviewer inspect the complete branch against the spec, focusing on stale-session writes, ownership ambiguity/expiry, headless isolation, event races, and shutdown behavior. Resolve actionable findings with failing regression tests first.
- [x] Validate candidate TOML with the installed Herdr CLI using a temporary explicit config path. Verify the expanded space layout contains only state/name/count/active-tab and preserves the current theme/width/spacing when merged with the live config.
- [x] Exercise metadata and tab events in a disposable named Herdr session using synthetic task fixtures, not real Beads claims. Verify lifecycle/summary tokens are unchanged, context disappears below threshold, model updates, and tab focus/rename/count events update metadata. Tear down only explicitly test-owned resources.
- [ ] Identify the exact durable package commit/path and existing live package-source configuration. Present the precise activation/cutover operation to JP before changing the live package source; do not merge, push, or pin a temporary worktree as a permanent installation without approval.
- [ ] After approval, back up the local Herdr config, make only the intended row changes, link the plugin from durable reviewed code, invoke its refresh action, and reload configuration. Reload Pi only at safe idle boundaries or give JP the exact `/reload` step for active sessions. Never stop the live Herdr server.
- [ ] Verify live workspace tokens and pane metadata after activation, record which running sessions still require reload, attach commit/config-backup evidence, and release the clean worktree once no runtime depends on it.

## Execution recommendation

**Native implementation with one fresh whole-branch reviewer.** The pane reporter and existing query lifecycle share state and should have one writer. The small space plugin is independently testable but does not justify separate implementation orchestration. The independent final review provides a fresh check of the failure cases before activation.
