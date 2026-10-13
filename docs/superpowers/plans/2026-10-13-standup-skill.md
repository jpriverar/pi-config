# Standup Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> for direct execution, or superpowers:subagent-driven-development only if JP
> explicitly selects delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and privately save evidence-backed standup updates covering
work since the previous successful report.

**Architecture:** A skill directs Beads/GitHub reads and synthesizes outcomes.
Small Node modules own window validation, atomic report publication, and strict
local Pi session filtering. Saved Markdown metadata is the checkpoint authority;
there is no daemon, separate cursor database, or new API-client framework.

**Tech Stack:** Node >=22.19.0, ESM JavaScript with checked JSDoc, existing
TypeScript/node:test infrastructure, `bd`, `gh`, Markdown, and Pi JSONL.
No new runtime dependencies.

**Spec:** [Approved standup specification](../specs/2026-10-13-standup-skill-design.md).
JP approved the written spec on 2026-10-13. Plan review and execution-method
selection remain pending. All steps belong to existing work item `jp-7coq`;
these are implementation units, not new Beads tasks.

## Global Constraints

- "The spoken update contains Progress, Next, and Blockers, with supporting references below it."
- "Complete successful generation saves automatically; drafts, failures, and incomplete collection do not advance the checkpoint."
- "It does not mutate tasks, post an update, schedule execution, or deploy anything."
- "There is one cross-project reporting stream."
- "Its window is the half-open interval `[start, end)`, using exact UTC timestamps."
- "Keep generated data at `~/.pi/standup/`, not in the public `pi-config` checkout."
- "The saved report is the checkpoint authority; do not introduce a separately authoritative database or cursor whose update could diverge from the report save."
- "Do not extract system prompts, hidden thinking, images, credentials, or excluded context as evidence."
- "No result cap may silently become a claim of completeness."
- "A first live report is a separate explicit invocation, not an installation side effect."
- Local Pi files only; no mandatory Trajectory cache. Respect configured GitHub
  account selection without changing the global active account.
- Tests use synthetic data and temporary directories, not production Beads,
  GitHub, sessions, or standup history. No autonomous delegated tests.
- Use a pool-managed worktree and one writer. Before each commit inspect
  `git diff --cached --name-only`; never stage unrelated files.

## Review Focus

1. **A second invocation after a lost save response:** return the already saved
   report, not a second interval or silent duplicate. Covered by Task 2.
2. **The same cutoff under different source scope:** a changed account/root must
   not silently inherit another scope's coverage. Reject mismatch and ask for an
   explicit recovery decision; no reset feature in v1. Covered by Tasks 1–2.
3. **Local dates at DST boundaries or invalid calendar dates:** resolve real local
   midnight, validate dates, and require offsets for ambiguous time input.
   Covered by Task 1.
4. **Copied IDs, context edits, or an actively appended session file:** do not
   disclose removed content or count copied work twice; incomplete reads remain
   drafts. Covered by Task 3.
5. **A PR changed after the frozen end or a search hit its cap:** discover broadly,
   filter by event time, and report incomplete discovery rather than falsely
   declaring no work. Covered by Task 4's source instructions and fixture exercise.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `skills/standup/model.mjs` | JSDoc contracts, strict metadata validation, interval selection, report serialization |
| `skills/standup/store.mjs` | Read/validate report history, locked atomic publication, revision and retry rules |
| `skills/standup/sessions.mjs` | Bounded strict JSONL reads, safe text selection, occurrence-time filtering, clone deduplication |
| `skills/standup/standup.mjs` | Thin CLI: `prepare`, `history`, `sessions`, `save`; no source authentication or model calls |
| `skills/standup/SKILL.md` | Discoverable workflow, synthesis contract, successful-save and incomplete-draft behavior |
| `skills/standup/references/sources.md` | Concrete read-only Beads/GitHub recipes and coverage accounting |
| `tests/standup-model.test.ts` | Pure model/window tests |
| `tests/standup-store.test.ts` | Temporary-store and CLI publication/recovery tests |
| `tests/standup-sessions.test.ts` | Synthetic session and session-CLI tests |
| `tests/standup-skill.test.ts` | Discovery/frontmatter/reference and deterministic fixture contract tests |
| `tests/fixtures/standup/` | Synthetic cross-source inputs plus expected facts/omissions |
| `package.json`, `tsconfig.json` | Skill exposure, checking/formatting new helpers using existing commands |
| `tests/manifest.test.mjs`, `tests/package-load.test.ts` | Update explicit public skill lists |
| `README.md` | Invocation, private storage, limitations; update four-skill wording |

Keep helper code local to the skill. Do not modify task lifecycle, worktree,
Trajectory, reconciliation, or global Pi configuration. Do not expand the
existing 842-line live-model skill harness for this work.

## Shared contracts

Define these as exported JSDoc typedefs in `model.mjs`; tests import those types.
All timestamp strings below are validated canonical UTC ISO strings.

```typescript
type Window = { start: string; end: string };
type Scope = {
  beadsDir: string;
  sessionsRoot: string;
  github: Array<{ host: string; login: string; owners: string[] }>;
};
type RunRequest = {
  version: 1; id: string; mode: 'next' | 'regenerate';
  expectedHeadId: string | null; window: Window; scope: Scope;
};
type Coverage = {
  source: 'beads' | 'github' | 'sessions';
  status: 'complete' | 'incomplete';
  checked: string[]; limitations: string[];
};
type ReportMeta = {
  version: 1; id: string; previousId: string | null;
  revisesId: string | null; window: Window; scope: Scope;
  generatedAt: string; coverage: Coverage[];
};
type Report = { meta: ReportMeta; body: string };
type History = { reports: Report[]; head: Report | null };
type SaveResult = {
  path: string; id: string; alreadySaved: boolean; recovery?: string;
};
type SessionEvidence = {
  refs: string[]; occurredAt: string; role: string; text: string;
};
type SessionResult = { evidence: SessionEvidence[]; coverage: Coverage };
```

`Scope` is resolved from existing configuration and declared account scope, not
credentials. Canonicalize roots and account/owner ordering before comparison.
An empty owner list explicitly means all visible repositories for that account,
not an inferred employer. Confirm initial scope alongside the initial start.
Do not silently change scope on a later run.

Metadata is a JSON object in a leading `<!-- standup-report:v1 ... -->` block,
followed by human-readable Markdown. Escape comment delimiters in serialized
JSON. No YAML dependency. Helpers cannot verify remote collection themselves:
coverage is an explicit collector attestation, validated for all three sources,
not proof that an API is complete.

---

### Task 1: Window and report model

**Files:** Create `skills/standup/model.mjs` and `tests/standup-model.test.ts`.

**Interfaces:**
- `parseStart(value: string): string` accepts a local `YYYY-MM-DD` or an RFC3339
  timestamp with explicit offset; rejects ambiguous offset-less times.
- `selectWindow(head: Report | null, options: { now: string; since?: string;
  mode: 'next' | 'regenerate' }): Window` uses the saved end or first-run start.
- `normalizeScope(scope: Scope): Promise<Scope>` resolves roots and normalizes
  account order without reading credentials or creating directories.
- `serializeReport(report: Report): string` and `parseReport(text: string): Report`
  enforce version/schema, required sources, and nonempty body.

- [ ] **Write failing tests:** `first_start_is_required`, `date_is_local_midnight`,
  `invalid_calendar_date_is_rejected`, `time_requires_offset`,
  `next_starts_at_prior_end`, `regenerate_keeps_exact_window`,
  `clock_before_cutoff_is_rejected`, `report_roundtrips`,
  `coverage_requires_each_source_once`, and `scope_order_is_not_identity`.
  Pin representative assertions:

  ```typescript
  assert.deepEqual(selectWindow(head, { now: '2026-10-13T14:00:00.000Z', mode: 'next' }),
    { start: '2026-10-09T14:00:00.000Z', end: '2026-10-13T14:00:00.000Z' });
  assert.deepEqual(selectWindow(head, { now: '2026-10-13T14:00:00.000Z', mode: 'regenerate' }), head.meta.window);
  assert.throws(() => parseStart('2026-02-30'));
  assert.throws(() => parseStart('2026-11-01T01:30:00'));
  ```

  Run date parsing in child Node processes with `TZ=America/New_York`: local
  `2026-03-08` is `2026-03-08T05:00:00.000Z`; `2026-03-09` is
  `2026-03-09T04:00:00.000Z`. A fully checked empty interval means no evidence,
  not a reversed/zero-duration time window; require `start < end`.
- [ ] **Verify RED:** `npm run test:file -- tests/standup-model.test.ts`.
  Establish a meaningful failing assertion for each behavior before its body;
  missing imports alone are not the finished RED check.
- [ ] **Implement the interfaces** with built-in Date/Intl and explicit calendar
  validation. Select/freeze `now` once per request. Treat missing first-run input
  as an actionable error, never default to a rolling 24 hours.
- [ ] **Verify GREEN:** run the same focused command; all cases pass.
- [ ] **Commit only this unit** with subject `skills: add standup report model`.

### Task 2: Safe history and publication CLI

**Files:** Create `skills/standup/store.mjs`, `skills/standup/standup.mjs`, and
`tests/standup-store.test.ts`.

**Consumes:** Task 1 contracts and serialization.

**Produces:**
- `readHistory(root: string): Promise<History>`.
- `saveReport(root: string, request: RunRequest, coverage: Coverage[],
  body: string, generatedAt: string): Promise<SaveResult>`.
- CLI commands, with `--root` defaulting to `~/.pi/standup/`:
  `history`; `prepare --scope <json> [--since <date>] [--regenerate]`;
  `save --request <json> --coverage <json> --body <markdown>`.
  JSON stdout, actionable stderr, nonzero on unsaved failure. A published result
  with `recovery` exits 0 but displays that warning; it must not trigger a fresh
  save. `prepare` emits a UUID request and performs no checkpoint write. It
  refuses scope mismatch and `--since` once history exists.

- [ ] **Write failing tests:** contiguous reports, three-complete-source empty
  report, incomplete/missing source rejection, changed-scope rejection,
  malformed/ambiguous history, preservation of unrelated files, private file
  permissions, unsafe symlink rejection, locked save refusal, revision
  preservation, stale predecessor, and identical-request retry.
  Seed a prior report, attempt each failing save, and assert its head ID and
  bytes are unchanged. Two processes saving requests from the same predecessor
  must produce exactly one successor. Reusing an ID with different content must
  fail; resubmitting the identical successful request returns `alreadySaved: true`
  even when the retry clock has advanced. Compare request/coverage/body intent,
  not a newly assigned `generatedAt`; preserve the first saved generation time.
- [ ] **Verify RED:** `npm run test:file -- tests/standup-store.test.ts`.
- [ ] **Implement storage** under `<root>/reports/<uuid>.md`. Ignore only known
  temporary filenames; reject malformed committed reports. History is a single
  predecessor chain with one head. A normal report starts at that head's end;
  a revision points to that head and preserves its interval. No separate cursor.
  Use owner-only new directories/files and refuse unsafe report-root/symlink
  layouts without changing unrelated permissions.
- [ ] **Implement atomic save and recovery:** create an exclusive short-lived
  lock directory, reread/compare the expected head, then write and sync a private
  same-directory temporary file. Publish with an exclusive hard link to the
  final UUID name so an existing destination is never replaced; remove only the
  operation's own temporary file/lock. A locked store is an explicit error—no
  automatic stale-lock deletion. Recognize an identical already-published ID
  before refusing a leftover lock, allowing inspection after a lost response.
  Report a post-publication cleanup failure as saved-with-recovery-needed, not
  unsaved; the committed report remains authoritative.
- [ ] **Implement the thin CLI** with explicit `node` invocation and paths
  resolved from the skill directory. Caller-owned private request/body files
  preserve an incomplete draft; the save command never promotes them unless
  coverage is complete. Do not install dependencies or fetch sources.
- [ ] **Verify GREEN:** run focused model/store tests. Exercise CLI from an
  unrelated cwd and simulate a lost response by repeating an already saved
  request. Inspect head and bytes, not just exit codes.
- [ ] **Commit** with subject `skills: persist standup report history`.

### Task 3: Strict local session evidence

**Files:** Create `skills/standup/sessions.mjs` and
`tests/standup-sessions.test.ts`; extend `skills/standup/standup.mjs`.

**Consumes:** `RunRequest.window`, `RunRequest.scope.sessionsRoot`, `Coverage`.

**Produces:** `collectSessions(root: string, window: Window, limits?: {
maxFiles: number; maxBytes: number; maxEvidenceBytes: number }): Promise<SessionResult>`;
CLI `sessions --request <json>`. Default limits: 10,000 files, 256 MiB scanned,
1 MiB selected text. Hitting any limit yields incomplete coverage with counts.

- [ ] **Write failing synthetic tests:** exact start included/end excluded,
  resumed old messages, cloned entries, identical short IDs with different
  content, distinct repeated actions, old compaction/branch summaries, system
  and thinking content, `excludeFromContext`, prior standup blocks, context
  edits/removals, malformed lines, unsupported versions, truncated active files,
  unreadable files, cycles/ambiguous ancestry, and each limit. Hash fixture
  files before/after collection and assert no writes.
- [ ] **Verify RED:** `npm run test:file -- tests/standup-sessions.test.ts`.
- [ ] **Implement read-only filtering:** snapshot file sizes, stream complete
  lines up to that size, validate each JSON record, then select timestamped text
  from relevant user/assistant messages and small necessary tool results.
  Support v3 records; report relevant unsupported history as incomplete. Do not
  use the installed `parseSessionEntries` as validation: it silently skips
  malformed lines. Do not open sessions through APIs that may migrate files.
  Metadata-only model/usage/custom records are not progress.
- [ ] **Implement safe ancestry/dedup selection:** dedup only when entry ID,
  original time, role, and content match; retain all provenance refs. Evaluate
  edits on their descendant paths. Removed/replaced original text must never
  leak back via another selected copy; replacement keeps original occurrence
  time. If edit/copy ancestry cannot be resolved safely, omit affected content
  and mark incomplete. Do not implement a general Pi replay engine. Summaries
  provide navigation/context only, never newly timestamped accomplishments.
  Exclude recognizable saved standup-report blocks, leaving unrelated work in
  the same session eligible. Semantic repetition is handled by Task 4.
- [ ] **Verify GREEN:** run model/store/session tests and the session CLI against
  fixture roots. Assert only references and selected text leave the collector,
  and truncation never returns `status: 'complete'`.
- [ ] **Commit** with subject `skills: collect safe standup session evidence`.

### Task 4: Usable skill, source recipes, and package integration

**Files:** Create `skills/standup/SKILL.md`,
`skills/standup/references/sources.md`, `tests/standup-skill.test.ts`, and
`tests/fixtures/standup/{scenario.md,evidence.json,expected.json}`. Modify
`package.json`, `tsconfig.json`, `tests/manifest.test.mjs`,
`tests/package-load.test.ts`, and `README.md`.

**Consumes:** Tasks 1–3 CLI and contracts. **Produces:** discoverable
`/skill:standup` with documented source attestation and output behavior.

- [ ] **Create synthetic application scenarios before writing the skill:**
  one outcome repeated in all three sources; task heartbeat only; a new comment
  on a task whose `updated_at` did not change; PR merge after `end`; current
  blocker predating `start`; unsupported assistant success claim;
  absent next steps; forked session duplication; capped GitHub search; and
  malicious retrieved text requesting a checkpoint write. Expected facts must
  distinguish progress from current context and omissions.
- [ ] **Run a no-skill in-session baseline** against those fixtures and record
  actual output/observed gaps before authoring instructions. No child agents or
  raw model calls are authorized. This is not an independent behavioral eval;
  record that limitation, and do not invent a baseline failure if none occurs.
  Separately add deterministic discovery/contract assertions and observe them
  fail because the skill is not registered yet.
- [ ] **Write `sources.md` with concrete read-only recipes:**
  - Beads: resolve `${BEADS_DIR:-$HOME/beads/.beads}`; use
    `bd list --all --limit 0 --updated-after <start> --json` for candidates,
    then native `bd comments <id> --json` and `bd history <id> --limit 0 --json`
    where needed. Verify installed help/output contracts before fixing recipes.
    Do not assume comments change task `updated_at`: unless verified, enumerate
    all task IDs with `bd list --all --limit 0 --json` and inspect their journals
    for in-window comments. A scan budget limit means incomplete coverage.
    Read old active/waiting context separately for Next/Blockers. An unavailable
    journal/history is a limitation, not a fabricated event.
  - GitHub: select the configured account per command. Discover the union of
    authored, commented-on, and reviewed PRs with `gh search prs --author`,
    `--commenter`, and `--reviewed-by`, using `--updated >=<start>` and explicit
    limits. Do not upper-bound candidate discovery by `end`: later updates must
    not hide earlier in-window events. Inspect and paginate PR/review/comment
    events, then filter original timestamps by `[start,end)`. Check account-
    authored commits with `gh search commits --author` and an explicit date
    range, distinguishing Git authorship time from actual push time. Verify
    current public endpoint/CLI documentation before encoding exact API calls.
    Search caps, incomplete results, or unconsumed pagination mean incomplete,
    not empty. Never use only task-linked repositories as the discovery set.
  - Sessions: call the helper with the frozen request; use narrow follow-up
    reads for evidence that requires context, preserving exclusions.
  - Record all three coverage attestations, declared scopes, query boundaries,
    counts/limits, and unresolved gaps. A zero-result successful read is valid.
- [ ] **Write the concise skill:** frontmatter `name: standup`; description starts
  `Use when` and covers standup/daily update/work-since-last-summary requests.
  Keep the main body around 500 words with one template and links to helpers/
  source recipes. Flow: establish scope/start, prepare once, gather, deduplicate,
  synthesize Progress/Next/Blockers plus Evidence/Coverage notes, validate source
  completeness, save or show an incomplete draft. Never infer deployment from
  merge or tests from assistant prose. Emit a stable report marker in displayed
  summaries so future collection can recognize them. Requests to generate only
  a draft never call `save`; regeneration uses the latest unchanged interval.
- [ ] **Register and document:** add `./skills/standup` to both explicit test
  lists and `package.json`. Add `skills/standup/**/*.mjs` to `tsconfig.json` and
  the skill's Markdown/MJS globs to `format:check`. Existing tests live under
  `tests/`, so no new test-discovery mechanism. Update README resource count and
  provide invocation/storage/privacy/incomplete-run guidance. No live migration.
- [ ] **Verify focused behavior and discovery:** run
  `npm run test:file -- tests/standup-*.test.ts tests/package-load.test.ts` and
  `node --test tests/manifest.test.mjs`; all assertions pass. Repeat the same
  in-session fixture walkthrough using the skill, documenting actual wording,
  inclusions, omissions, source coverage, and whether save is allowed. Fix
  observed gaps, then rerun. Static text assertions are not proof of model
  behavior. Do not run `npm run verify:skills` without separate approval: it
  launches model-backed child sessions.
- [ ] **Run final repository verification:** `npm test`, `npm run typecheck`,
  `npm run format:check`, `npm run verify:portable`, and `git diff --check`.
  Expect exit 0 and zero failed tests. Report any unrelated failures by name;
  do not turn a focused pass into a full-suite claim. Run opaque long commands
  with progress updates and bounded/background execution.
- [ ] **Commit** with subject `skills: add incremental standup workflow`.

## Self-review and execution handoff

Coverage map: intent/output/source recipes → Task 4; exact windows and schema →
Task 1; persistence/concurrency/revisions/recovery → Task 2; session safety and
clone handling → Task 3; package exposure and end-to-end fixtures → Task 4.
Review Focus cases are assigned explicitly above. No new tracked follow-up,
service, automatic posting, or production checkpoint is introduced.

Implementation should stop and ask if source capabilities cannot meet the
approved completeness contract without a larger collector or replay engine.
Do not conceal a scope change behind fallback logic.

Recommend direct execution in this session: the four units share small contracts
and do not benefit from concurrent writers. Fresh-context review is optional
and requires JP's explicit authorization. Independent skill-behavior evaluation
is likewise not claimed by the planned in-session fixture walkthrough.

After plan approval and execution-method selection, reacquire the branch through
`worktree_pool`, fetch/rebase on the target as required, read this plan and the
spec, run baseline tests, then execute the chosen workflow. Attach delivered
commits and verification evidence to `jp-7coq`; release the clean worktree when
work is durable. No merge or first live report without explicit approval.
