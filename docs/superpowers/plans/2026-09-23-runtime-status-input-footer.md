# Runtime Status Input Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the project and current task in the top status row by moving model, uppercase effort, detailed context usage, and icon-prefixed free disk into a distinct full-width footer row owned by the Tahir-derived styled editor.

**Architecture:** `project-status` becomes project/task-only and loses all runtime/disk responsibilities. `styled-editor` owns runtime collection, disk polling, compact formatting, responsive suffix preservation, and a full-width `customMessageBg` row whose content is pinned to the right edge.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9 with NodeNext ESM and `.js` imports, `@earendil-works/pi-coding-agent` 0.84.1, `@earendil-works/pi-tui` 0.84.1, `tsx --test`, Prettier.

**Spec:** `docs/superpowers/specs/2026-09-23-runtime-status-input-footer-design.md`

## Global Constraints

- Preserve Beads queries, lifecycle ownership rules, disk thresholds, and the 60-second disk polling interval.
- Use only supported Pi/TUI APIs supplied to extensions and custom component factories.
- Reuse the existing Tahir-derived rail, input padding, ANSI background repair, autocomplete placement, and trailing spacer.
- Render `customMessageBg` across the entire status row after the rail; never reuse `userMessageBg` for status chrome.
- Pin runtime content to the right edge with one cell of right padding.
- Render effort uppercase, context as `percent (used/window)`, and disk as `⛁ free-space`.
- Treat model and effort strings as untrusted display data before adding theme ANSI.
- Never add a subprocess, unsupported theme key, terminal-position escape sequence, Bun dependency, or cross-extension status transport.
- Keep NodeNext `.js` imports and pass Node 22 portability checks.
- Follow RED/GREEN TDD and keep behavior changes with focused tests.

## Review Focus

- **Zero-width rendering:** top widget and editor footer stay bounded without negative padding; Tasks 1 and 2 add explicit zero/narrow-width tests.
- **Autocomplete open:** status remains inside the editor block while autocomplete remains outside both backgrounds; Task 2 adds ordering/background coverage.
- **Prompt disabled:** runtime remains visible through the plain custom-footer fallback; Task 2 adds `/prompt off` coverage.
- **Hostile model identity:** ANSI, OSC, newlines, tabs, and controls cannot inject rows or terminal actions; Task 2 adds sanitization coverage.
- **Session replacement:** stale disk reads and timers cannot update a replacement session; Task 2 adds generation/shutdown tests.

---

### Task 1: Make Project Status Project/Task-Only

**Files:**
- Modify: `extensions/project-status/index.ts:1-300`
- Modify: `extensions/project-status/index.test.ts:1-420`
- Include in commit: `docs/superpowers/specs/2026-09-23-runtime-status-input-footer-design.md`
- Include in commit: `docs/superpowers/plans/2026-09-23-runtime-status-input-footer.md`

**Interfaces:**
- Consumes: existing Beads client, session project resolution, and `ctx.ui.setWidget()`.
- Produces: a top widget containing only project plus the single session-owned Active task, or aggregate task counts.

- [ ] **Step 1: Rewrite combined-surface tests as header-only expectations**

Rename the harness accessor from `render` to `renderHeader`, then replace combined assertions with:

```ts
test("keeps runtime telemetry out of the project header", async () => {
  const harness = createHarness();
  await start(harness);

  assert.match(harness.renderHeader(), /pi-setup/);
  assert.doesNotMatch(
    harness.renderHeader(),
    /Opus 4\.6|high|32%|disk 200G|⛁/,
  );
});
```

Extend the current-session task test:

```ts
const narrow = harness.renderHeader(24);
assert.ok(visibleWidth(narrow) <= 24);
assert.match(narrow, /jp-b1om/);
assert.doesNotMatch(narrow, /Opus|disk|32%|⛁/);
```

Remove project-status tests for model changes, thinking changes, disk thresholds, and disk failure; Task 2 will recreate those assertions at the new owner.

Add ownership-boundary assertions:

```ts
assert.equal(harness.handlers.get("model_select"), undefined);
assert.equal(harness.handlers.get("thinking_level_select"), undefined);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test:file -- extensions/project-status/index.test.ts
```

Expected: FAIL because runtime telemetry still occupies the top widget and runtime-only handlers remain registered.

- [ ] **Step 3: Remove runtime and disk ownership from project-status**

Delete:

- `node:fs/promises` and `node:os` imports;
- `ThemeColor` and `visibleWidth` imports used only by runtime rendering;
- disk constants, dependencies, state, polling, and formatting;
- model, thinking, context, and right-side construction;
- `model_select` and `thinking_level_select` handlers.

Restore the extension entry point to one dependency-free argument:

```ts
export default function projectStatus(pi: ExtensionAPI) {
```

Render `left` only:

```ts
if (!left) {
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  return;
}

ctx.ui.setWidget(WIDGET_KEY, () => ({
  render(width: number) {
    if (width <= 0) return [""];
    return [truncateToWidth(left, width, "…", true)];
  },
  invalidate() {},
}));
```

Keep the existing generation checks and task refreshes on `session_start`, `session_info_changed`, and `turn_end`. `session_shutdown` only invalidates the generation.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npm run test:file -- extensions/project-status/index.test.ts
npm run typecheck
```

Expected: all project-status tests and typecheck PASS.

- [ ] **Step 5: Commit the project/task-only header**

Before committing, run:

```bash
git diff --cached --name-only
```

Stage only project-status source/tests, the approved spec, and the updated plan. Commit:

```bash
git commit -m "ui: reserve header for task status"
```

### Task 2: Add Editor-Owned Runtime Footer

**Files:**
- Modify: `extensions/styled-editor/index.ts:1-195`
- Modify: `extensions/styled-editor/index.test.ts:1-240`

**Interfaces:**
- Consumes: `ExtensionContext.model`, `getContextUsage()`, `pi.getThinkingLevel()`, `node:fs/promises.statfs`, and the supported TUI/editor factories.
- Produces: a full-width `customMessageBg` status row with right-sticky runtime segments and a plain custom-footer fallback when styled mode is disabled.

- [ ] **Step 1: Extend the styled-editor harness with runtime and disk state**

Add configurable model, usage, effort, and disk inputs:

```ts
function createHarness(
  options: {
    modelName?: string;
    thinkingLevel?: string;
    usage?: { tokens?: number; contextWindow?: number; percent?: number | null };
    diskFreeGiB?: bigint;
    diskUnavailable?: boolean;
  } = {},
) {
```

Add `pi.getThinkingLevel()`, `context.model`, and `context.getContextUsage()`. Inject deterministic disk dependencies as the second argument to `styledEditor(...)`:

```ts
styledEditor(pi as any, {
  homePath: "/tmp",
  async statfs() {
    if (options.diskUnavailable) throw new Error("disk unavailable");
    return { bavail: options.diskFreeGiB ?? 200n, bsize: GiB };
  },
  setInterval() {
    return { unref() {} };
  },
  clearInterval() {},
});
```

Update the fake theme so `bg()` and `getBgAnsi()` support both `userMessageBg` and `customMessageBg` with distinct escape sequences.

- [ ] **Step 2: Write failing tests for approved content**

Add:

```ts
test("formats editor-owned runtime state", async () => {
  const editor = await start(
    createHarness({
      thinkingLevel: "high",
      usage: { tokens: 440_000, contextWindow: 1_000_000, percent: 44 },
      diskFreeGiB: 200n,
    }),
  );

  const rendered = stripTerminalSequences(editor.render(80).join("\n"));
  assert.match(
    rendered,
    /Opus 4\.6 • HIGH • 44% \(440k\/1M\) • ⛁ 200G/,
  );
});
```

Add token-format table coverage for `999`, `1_200`, `440_000`, `1_000_000`, and `1_500_000`. Add fallback coverage where token detail is absent but percent exists.

Add hostile model coverage using OSC, newline, and tab characters; assert the rendered status contains no injected row or control sequence.

- [ ] **Step 3: Write failing tests for the full-width status row**

Use a distinct `STATUS_BACKGROUND` escape and assert:

```ts
const lines = editor.render(48);
const statusLine = lines.find((line: string) => line.includes("⛁ 200G"));
assert.ok(statusLine);
assert.ok(statusLine.startsWith(RAIL));
assert.ok(statusLine.includes(STATUS_BACKGROUND));
assert.ok(!statusLine.includes(INPUT_BACKGROUND));
assert.match(stripTerminalSequences(statusLine), /⛁ 200G $/);
assert.equal(lines.at(-1), "");
```

For widths `[0, 1, 2, 3, 8, 24, 48]`, assert every line satisfies `visibleWidth(line) <= width`.

At a constrained width, assert leading identity is omitted while trailing health remains:

```ts
const narrow = stripTerminalSequences(editor.render(32).join("\n"));
assert.doesNotMatch(narrow, /Opus 4\.6/);
assert.match(narrow, /44%.*⛁ 200G/);
```

- [ ] **Step 4: Write failing tests for autocomplete, fallback, disk thresholds, and stale sessions**

Extend autocomplete coverage so the status row precedes `/alpha`, uses `customMessageBg`, and `/alpha` uses neither prompt background.

Toggle `/prompt off` and assert the custom footer still renders the runtime content as one plain width-bounded row.

Move the former project-status threshold table here:

```ts
for (const [diskFreeGiB, color] of [
  [150n, "dim"],
  [149n, "warning"],
  [79n, "error"],
] as const) {
  // render and assert theme.fg(color, `⛁ ${diskFreeGiB}G`)
}
```

Add disk failure coverage for `⛁ ?`. Add a deferred disk read, shut down the session, start a replacement, release the old read, and assert stale state never reaches the replacement editor.

- [ ] **Step 5: Run focused tests and verify RED**

Run:

```bash
npm run test:file -- extensions/styled-editor/index.test.ts
```

Expected: FAIL because styled-editor does not yet collect runtime state or render a status row.

- [ ] **Step 6: Move disk dependencies and formatting into styled-editor**

Add the runtime dependencies and constants formerly owned by project-status:

```ts
const GiB = 1024n ** 3n;
const POLL_INTERVAL_MILLISECONDS = 60_000;
const WARNING_FREE_BYTES = 150n * GiB;
const ERROR_FREE_BYTES = 80n * GiB;
const DISK_ICON = "⛁";

type DiskStatus = { color: ThemeColor; text: string };
type RuntimeStatusSegment = { color: ThemeColor; text: string };
```

Keep the existing `formatFreeGiB`. Add compact token formatting compatible with Pi but without redundant `.0`:

```ts
function stripZeroFraction(value: string): string {
  return value.replace(/\.0$/, "");
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) {
    return `${stripZeroFraction((count / 1_000).toFixed(1))}k`;
  }
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) {
    return `${stripZeroFraction((count / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(count / 1_000_000)}M`;
}
```

Add single-line sanitation with `stripTerminalSequences(...)`, control replacement, whitespace collapse, and trimming.

- [ ] **Step 7: Build structured runtime segments**

Add a pure helper that returns fields in display order:

```ts
function buildRuntimeStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  diskStatus: DiskStatus | undefined,
): RuntimeStatusSegment[] {
  const segments: RuntimeStatusSegment[] = [];
  const model = sanitizeInlineStatus(ctx.model?.name || ctx.model?.id || "")
    .replace(/^Claude /, "")
    .replace(/\s*\(AI Gateway.*\)$/, "");
  if (model) segments.push({ color: "dim", text: model });

  const effort = sanitizeInlineStatus(pi.getThinkingLevel() || "");
  if (effort && effort !== "off") {
    segments.push({ color: "dim", text: effort.toUpperCase() });
  }

  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  const percent =
    usage?.percent ??
    (usage?.tokens != null && contextWindow
      ? (usage.tokens / contextWindow) * 100
      : null);
  if (percent != null) {
    const rounded = Math.round(percent);
    const detail =
      usage?.tokens != null && contextWindow
        ? ` (${formatTokenCount(usage.tokens)}/${formatTokenCount(contextWindow)})`
        : "";
    segments.push({
      color: rounded > 90 ? "error" : rounded > 70 ? "warning" : "dim",
      text: `${rounded}%${detail}`,
    });
  }

  if (diskStatus) segments.push(diskStatus);
  return segments;
}
```

Preserve the disk threshold color in `DiskStatus`.

- [ ] **Step 8: Render a full-width right-sticky status row**

Import `sliceByColumn` and implement left truncation for the final surviving field:

```ts
function truncateFromLeft(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text;
  if (width <= 0) return "";
  if (width === 1) return "…";
  return `…${sliceByColumn(text, textWidth - width + 1, width - 1, true)}`;
}
```

Fit whole suffix segments first: drop model, then effort, before truncating context or disk:

```ts
function runtimeStatusWidth(segments: RuntimeStatusSegment[]): number {
  return segments.reduce(
    (total, segment, index) =>
      total + visibleWidth(segment.text) + (index === 0 ? 0 : 3),
    0,
  );
}

function fitRuntimeStatus(
  segments: RuntimeStatusSegment[],
  maxWidth: number,
): { omitted: boolean; segments: RuntimeStatusSegment[] } {
  if (maxWidth <= 0 || segments.length === 0) {
    return { omitted: false, segments: [] };
  }
  for (let start = 0; start < segments.length; start++) {
    const suffix = segments.slice(start);
    const markerWidth = start === 0 ? 0 : visibleWidth("… • ");
    if (markerWidth + runtimeStatusWidth(suffix) <= maxWidth) {
      return { omitted: start > 0, segments: suffix };
    }
  }
  const last = segments.at(-1);
  return last
    ? {
        omitted: false,
        segments: [
          { ...last, text: truncateFromLeft(last.text, maxWidth) },
        ],
      }
    : { omitted: false, segments: [] };
}
```

Add a dedicated renderer:

```ts
function renderRuntimeStatusLine(
  theme: Theme,
  segments: RuntimeStatusSegment[],
  width: number,
): string {
  if (width <= 0) return "";
  const railWidth = Math.min(visibleWidth(PROMPT_RAIL), width);
  const rail = theme.fg("borderAccent", PROMPT_RAIL.slice(0, railWidth));
  const bodyWidth = Math.max(0, width - railWidth);
  const fitted = fitRuntimeStatus(segments, Math.max(0, bodyWidth - 1));
  const renderedSegments = fitted.segments
    .map((segment) => theme.fg(segment.color, segment.text))
    .join(theme.fg("dim", " • "));
  const content = `${
    fitted.omitted ? theme.fg("dim", "… • ") : ""
  }${renderedSegments}`;
  const leftPadding = " ".repeat(
    Math.max(0, bodyWidth - visibleWidth(content) - 1),
  );
  const row = `${leftPadding}${content}${bodyWidth > 0 ? " " : ""}`;
  return `${rail}${fillThemeBackground(theme, "customMessageBg", row)}`;
}
```

Use the existing background-repair helper with `customMessageBg` so nested foreground resets cannot clear the footer background.

- [ ] **Step 9: Insert status before autocomplete**

Extend `PromptEditor` with:

```ts
private readonly getRuntimeStatus: () => RuntimeStatusSegment[];
```

During `render(width)`, append the optional status line after the padded input rows and before `autocompleteLines`:

```ts
const runtimeStatus = this.getRuntimeStatus();
const statusLines =
  runtimeStatus.length > 0
    ? [renderRuntimeStatusLine(this.uiTheme, runtimeStatus, width)]
    : [];

const out = [
  ...paddedEntryLines.map((line) =>
    renderEntryBlockLine(this.uiTheme, line, width),
  ),
  ...statusLines,
  ...autocompleteLines,
  "",
];
```

- [ ] **Step 10: Add session-scoped refresh and cleanup**

Change the extension signature to accept injectable disk dependencies:

```ts
export default function styledEditor(
  pi: ExtensionAPI,
  diskDeps: DiskSpaceDependencies = runtimeDiskSpaceDependencies,
): void {
```

Maintain `currentContext`, `currentDiskStatus`, `sessionGeneration`, `diskPollTimer`, and a `requestRender` callback captured from the supported editor/footer TUI factories.

On `session_start`, reset prior state, install footer/editor, read disk, then start the unref'd 60-second timer in TUI mode. On `model_select`, `thinking_level_select`, and `turn_end`, update `currentContext` and request or reinstall rendering. On `session_shutdown`, increment generation, clear the timer, and clear runtime references.

Guard every async disk result with its captured generation.

When `enabled` is false, the custom footer renders a plain right-aligned, width-bounded form of the same segments. When `enabled` is true, the custom footer remains empty because `PromptEditor` owns the row.

- [ ] **Step 11: Run focused tests and verify GREEN**

Run:

```bash
npm run test:file -- extensions/styled-editor/index.test.ts
npm run test:file -- \
  extensions/project-status/index.test.ts \
  extensions/styled-editor/index.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck PASS.

- [ ] **Step 12: Commit the editor-owned runtime footer**

Before committing, run:

```bash
git diff --cached --name-only
```

Stage only styled-editor source/tests. Commit:

```bash
git commit -m "ui: add runtime editor footer"
```

### Task 3: Repository Verification and Delivery Evidence

**Files:**
- Modify only if a verification failure identifies a defect in Task 1 or Task 2 files.

**Interfaces:**
- Consumes: the two committed behavior changes.
- Produces: repository-wide evidence that the package remains loadable, portable, formatted, licensed, and smoke-testable.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all TypeScript and manifest tests PASS with zero failures.

- [ ] **Step 2: Run static and portability gates**

Run:

```bash
npm run typecheck
npm run format:check
npm run verify:portable
npm run licenses:check
```

Expected: every command exits zero.

- [ ] **Step 3: Run the Pi smoke suite**

Run:

```bash
npm run verify:smoke
```

Expected: PASS with project-status, styled-editor, and the package manifest loading together.

- [ ] **Step 4: Inspect final state**

Run:

```bash
git status --short --branch
git diff main...HEAD --stat
git diff --check
```

Expected: only approved source, tests, spec, and plan differ from `main`; no generated, dependency, or unrelated files are tracked.

- [ ] **Step 5: Report for explicit integration approval**

Report:

- commit SHAs;
- focused and repository-wide verification counts;
- worktree path and branch;
- full-width footer behavior and `/prompt off` fallback;
- the limitation that live visual verification requires explicit integration, installation, and `/reload` approval.

Do not push, integrate, install, reload, release the worktree, or close `jp-yatk` until the user explicitly chooses those actions.
