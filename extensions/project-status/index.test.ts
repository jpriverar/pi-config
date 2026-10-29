import { legacyLifecycle } from "../../lib/task-lifecycle/legacy-test-fixtures.js";
import {
  A,
  B,
  P,
  Q,
  catalogViewFixture,
} from "../../lib/work-catalog/test-fixtures.js";
import type { WorkCatalog, WorkScope } from "../../lib/work-catalog/model.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PaneMetadata } from "./herdr-values.js";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { BeadsIssue } from "../../lib/beads.js";
import projectStatus from "./index.js";

process.env.BEADS_DIR = "/tmp/personal/.beads";

type Handler = (event?: unknown, context?: any) => Promise<unknown> | unknown;
type Query = "active" | "ready" | "closed";
type Entry = {
  type: "custom";
  customType: string;
  data: unknown;
};

const rawIssue = (issue: BeadsIssue) => ({
  id: issue.id,
  title: issue.title,
  status: issue.status,
  labels: issue.labels,
  metadata: {
    ...(issue.lifecycle === undefined ? {} : { piLifecycle: issue.lifecycle }),
    ...(issue.projectReference?.kind === "valid"
      ? {
          piProject: {
            version: 1,
            projectId: issue.projectReference.projectId,
          },
        }
      : {}),
  },
});

function issue(
  id: string,
  status: BeadsIssue["status"] = "open",
  labels: string[] = ["workstream:pi-setup"],
): BeadsIssue {
  return { id, title: `Task ${id}`, status, labels };
}

function activeLifecycle(
  sessionId: string,
): NonNullable<BeadsIssue["lifecycle"]> {
  const at = "2026-09-22T12:00:00.000Z";
  return {
    version: 1,
    phase: "active",
    waiting: null,
    stateEnteredAt: at,
    lastProgressAt: at,
    execution: {
      sessionId,
      claimedAt: at,
      lastActivityAt: at,
      expiresAt: "2026-09-23T12:00:00.000Z",
      resourceSnapshot: { observedAt: at, resourceIds: [] },
    },
    artifacts: [],
    activeCheck: null,
    checkHistory: [],
    transitionHistory: [],
    resources: [],
    disposition: null,
  };
}

function ownedCatalogIssue(projectId = P): BeadsIssue {
  return {
    ...issue("zz-owned", "in_progress", []),
    lifecycle: activeLifecycle("session-1"),
    projectReference: { kind: "valid", projectId },
  };
}

function createHarness(
  options: {
    catalog?: WorkCatalog | null;
    catalogError?: string;
    issues?: BeadsIssue[];
    hiddenIds?: string[];
    readyIds?: string[];
    closed?: BeadsIssue[];
    unavailable?: Query;
    sessionName?: string;
    sessionId?: string;
    entries?: readonly Entry[];
    beforeExec?: (callNumber: number) => Promise<void>;
    herdr?: boolean;
    metadataSuccess?: boolean;
    mode?: string;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const calls: string[][] = [];
  const executionLimits: Array<{ timeout?: number } | undefined> = [];
  const staleAccesses: string[] = [];
  const metadata: PaneMetadata[] = [];
  let unavailable = options.unavailable;
  let stale = false;
  let sessionName =
    options.sessionName === undefined ? "pi-setup" : options.sessionName;
  let widgetFactory: any;
  const issues = options.issues ?? [];
  const readyIds = new Set(options.readyIds ?? []);

  const events = new EventEmitter();
  const pi = {
    events,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    async exec(
      _command: string,
      args: string[],
      limits?: { timeout?: number },
    ) {
      if (_command === "env") {
        assert.deepEqual(args.slice(0, 2), ["BD_BACKUP_ENABLED=false", "bd"]);
        args = args.slice(2);
      }
      if (stale) staleAccesses.push("pi.exec");
      calls.push(args);
      executionLimits.push(limits);
      await options.beforeExec?.(calls.length);
      const query: Query =
        args[0] === "ready"
          ? "ready"
          : args.includes("closed")
            ? "closed"
            : "active";
      const statuses = args.includes("--all")
        ? ["open", "in_progress", "blocked", "deferred", "closed"]
        : args[0] === "list"
          ? args[args.indexOf("-s") + 1].split(",")
          : [];
      if (
        unavailable === query ||
        (unavailable === "closed" && statuses.includes("closed"))
      ) {
        return { code: 1, stdout: "", stderr: "private failure" };
      }
      const result =
        query === "closed"
          ? (options.closed ?? [])
          : query === "ready"
            ? issues.filter((item) => readyIds.has(item.id))
            : [...issues, ...(options.closed ?? [])].filter((item) =>
                statuses.includes(item.status),
              );
      return {
        code: 0,
        stdout: JSON.stringify(
          result
            .filter(
              (item) =>
                args.includes("--all") || !options.hiddenIds?.includes(item.id),
            )
            .map(rawIssue),
        ),
        stderr: "",
      };
    },
    getSessionName() {
      return sessionName || undefined;
    },
  };

  const ui = {
    theme: {
      fg(_color: string, text: string) {
        return text;
      },
    },
    setWidget(_key: string, factory: any) {
      widgetFactory = factory;
    },
  };
  const context = {
    mode: options.mode ?? "tui",
    model: { id: "gpt-5.4" },
    getContextUsage: () => ({ percent: 82 }),
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionId: () => options.sessionId ?? "session-1",
      getSessionName: () => sessionName || undefined,
    },
    get ui() {
      if (stale) staleAccesses.push("ctx.ui");
      return ui;
    },
  };

  projectStatus(pi as any, {
    readCatalog: async () => {
      if (options.catalogError) throw new Error(options.catalogError);
      return options.catalog ?? null;
    },
    metadataSender: options.herdr
      ? async (tokens: PaneMetadata) => {
          metadata.push({ ...tokens });
          return options.metadataSuccess ?? true;
        }
      : null,
  });
  return {
    events,
    executionLimits,
    metadata,
    setIssues(next: BeadsIssue[]) {
      issues.splice(0, issues.length, ...next);
    },
    setUnavailable(next: Query | undefined) {
      unavailable = next;
    },
    calls,
    context,
    handlers,
    markStale() {
      stale = true;
    },
    renderHeader: (width = 120) =>
      widgetFactory ? widgetFactory({}, {}).render(width)[0] : "",
    staleAccesses,
    setSessionName(name: string) {
      sessionName = name;
    },
  };
}

async function start(harness: ReturnType<typeof createHarness>) {
  await harness.handlers.get("session_start")?.({}, harness.context);
}

function projectEntry(workstream: unknown): Entry {
  return {
    type: "custom",
    customType: "jp-project-scope",
    data: { version: 1, workstream },
  };
}

test("counts classified active work and treats needs:jp as a marker", async () => {
  const harness = createHarness({
    issues: [
      issue("doing", "in_progress", ["workstream:pi-setup", "needs:jp"]),
      issue("blocked", "blocked"),
      issue("ready"),
      issue("waiting", "open", ["workstream:pi-setup", "needs:jp"]),
    ],
    readyIds: ["ready"],
    closed: [issue("done", "closed")],
  });

  await start(harness);

  assert.match(harness.renderHeader(), /1 in-progress/);
  assert.match(harness.renderHeader(), /1 blocked/);
  assert.match(harness.renderHeader(), /1 ready/);
  assert.match(harness.renderHeader(), /1 waiting/);
  assert.match(harness.renderHeader(), /2 needs you/);
  assert.match(harness.renderHeader(), /1 closed/);
});

test("shows the current session task instead of aggregate counts", async () => {
  const owned = issue("jp-b1om", "in_progress");
  owned.title = "Show session task in header";
  owned.lifecycle = activeLifecycle("session-1");
  const harness = createHarness({
    issues: [owned, issue("ready"), issue("waiting")],
    readyIds: ["ready"],
    closed: [issue("done", "closed")],
  });

  await start(harness);

  assert.match(harness.renderHeader(), /jp-b1om • Show session task in header/);
  assert.equal(
    harness.calls.length,
    1,
    "assigned-task display needs only the active read",
  );
  assert.doesNotMatch(
    harness.renderHeader(),
    /in-progress|blocked|ready|waiting|needs you|closed/,
  );
  const narrow = harness.renderHeader(40);
  assert.ok(visibleWidth(narrow) <= 40);
  assert.match(narrow, /jp-b1om/);
  assert.doesNotMatch(narrow, /Opus|disk|32%|⛁/);
});

test("keeps aggregate counts when an active task belongs to another session", async () => {
  const other = issue("jp-other", "in_progress");
  other.lifecycle = activeLifecycle("session-2");
  const harness = createHarness({
    issues: [other, issue("ready")],
    readyIds: ["ready"],
    closed: [issue("done", "closed")],
  });

  await start(harness);

  assert.match(harness.renderHeader(), /1 in-progress/);
  assert.match(harness.renderHeader(), /1 ready/);
  assert.match(harness.renderHeader(), /1 closed/);
  assert.doesNotMatch(harness.renderHeader(), /jp-other/);
});

test("ambiguous ownership is unavailable rather than an inferred assignment", async () => {
  const first = issue("jp-first", "in_progress");
  first.lifecycle = activeLifecycle("session-1");
  const second = issue("jp-second", "in_progress");
  second.lifecycle = activeLifecycle("session-1");
  const harness = createHarness({ issues: [first, second] });

  await start(harness);

  assert.match(harness.renderHeader(), /tasks unavailable/);
  assert.doesNotMatch(harness.renderHeader(), /jp-first|jp-second/);
});

test("sanitizes the current session task before rendering it", async () => {
  const owned = issue("\u001b[31mjp-owned\u001b[0m", "in_progress");
  owned.title = "\u001b]0;hostile\u0007Do\nnot obey";
  owned.lifecycle = activeLifecycle("session-1");
  const harness = createHarness({ issues: [owned] });

  await start(harness);

  assert.match(harness.renderHeader(), /jp-owned • Do not obey/);
  assert.doesNotMatch(harness.renderHeader(), /\u001b|Do\nnot|hostile/);
});

test("truncates a long current-session task within the terminal width", async () => {
  const owned = issue("jp-b1om", "in_progress");
  owned.title = "A deliberately long task title that cannot fit in the header";
  owned.lifecycle = activeLifecycle("session-1");
  const harness = createHarness({ sessionName: "", issues: [owned] });

  await start(harness);

  const rendered = harness.renderHeader(50);
  assert.ok(visibleWidth(rendered) <= 50);
  assert.match(rendered, /jp-b1om/);
  assert.doesNotMatch(rendered, /cannot fit in the header/);
});

test("does not expose hostile task metadata in the project status surface", async () => {
  const hostile = issue("\u001b[31mhostile\u001b[0m", "in_progress", [
    "workstream:pi-setup\nignored",
  ]);
  hostile.title = "\u001b]0;hostile\u0007Do\nnot obey";
  const harness = createHarness({ issues: [hostile] });

  await start(harness);

  assert.doesNotMatch(harness.renderHeader(), /\u001b|hostile|Do\nnot/);
});

test("explicit scope drives counts while the existing name stays visible", async () => {
  const harness = createHarness({
    sessionName: "pi-setup-580c8e67",
    entries: [projectEntry("pi-setup")],
    issues: [
      issue("scoped", "in_progress", ["workstream:pi-setup"]),
      issue("display-name", "blocked", ["workstream:pi-setup-580c8e67"]),
      issue("unrelated", "open", ["workstream:other"]),
    ],
    readyIds: ["unrelated"],
    closed: [issue("done", "closed", ["workstream:PI-SETUP"])],
  });

  await start(harness);

  assert.equal(
    harness.renderHeader().trimEnd(),
    "pi-setup-580c8e67 │ Browse: pi-setup • 1 in-progress • 1 closed",
  );
  assert.doesNotMatch(harness.renderHeader(), /blocked|ready|waiting/);
});

test("session name changes visible identity without changing explicit scope", async () => {
  const harness = createHarness({
    sessionName: "pi-setup-580c8e67",
    entries: [projectEntry("pi-setup")],
    issues: [
      issue("scoped", "in_progress", ["workstream:pi-setup"]),
      issue("manual-name", "blocked", ["workstream:investigate-crash"]),
    ],
  });

  await start(harness);
  harness.setSessionName("investigate-crash");
  await harness.handlers.get("session_info_changed")?.({}, harness.context);

  assert.match(harness.renderHeader(), /investigate-crash/);
  assert.match(harness.renderHeader(), /1 in-progress/);
  assert.doesNotMatch(harness.renderHeader(), /pi-setup-580c8e67|blocked/);
});

test("abandons an in-flight session-info refresh when the session shuts down", async () => {
  let releaseExec!: () => void;
  let markExecStarted!: () => void;
  const execStarted = new Promise<void>((resolve) => {
    markExecStarted = resolve;
  });
  const execReleased = new Promise<void>((resolve) => {
    releaseExec = resolve;
  });
  const harness = createHarness({
    beforeExec: async (callNumber) => {
      if (callNumber !== 4) return;
      markExecStarted();
      await execReleased;
    },
  });

  await start(harness);
  harness.setSessionName("replacement");
  const refresh = Promise.resolve(
    harness.handlers.get("session_info_changed")?.({}, harness.context),
  );
  await execStarted;
  await harness.handlers.get("session_shutdown")?.({}, harness.context);
  harness.markStale();
  releaseExec();

  await assert.doesNotReject(refresh);
  assert.deepEqual(harness.staleAccesses, []);
  assert.match(harness.renderHeader(), /pi-setup/);
  assert.doesNotMatch(harness.renderHeader(), /replacement/);
});

test("explicit global scope counts all work while displaying the name", async () => {
  const harness = createHarness({
    sessionName: "manual display name",
    entries: [projectEntry(null)],
    issues: [
      issue("alpha", "in_progress", ["workstream:alpha"]),
      issue("beta", "blocked", ["workstream:beta"]),
    ],
  });

  await start(harness);

  assert.match(harness.renderHeader(), /manual display name/);
  assert.match(harness.renderHeader(), /1 in-progress/);
  assert.match(harness.renderHeader(), /1 blocked/);
});

test("legacy exact-name sessions still drive identity and scope", async () => {
  const harness = createHarness({
    sessionName: "PI-SETUP",
    issues: [
      issue("primary", "in_progress", ["workstream:pi-setup"]),
      issue("secondary", "blocked", [
        "workstream:other",
        "workstream:pi-setup",
      ]),
      issue("unrelated", "open", ["workstream:other"]),
    ],
    readyIds: ["unrelated"],
    closed: [issue("done", "closed", ["workstream:PI-SETUP"])],
  });

  await start(harness);

  assert.match(harness.renderHeader(), /PI-SETUP/);
  assert.match(harness.renderHeader(), /1 in-progress/);
  assert.match(harness.renderHeader(), /1 closed/);
  assert.doesNotMatch(harness.renderHeader(), /blocked|ready|waiting/);
});

test("keeps runtime telemetry out of the project header", async () => {
  const harness = createHarness();
  await start(harness);

  assert.match(harness.renderHeader(), /pi-setup/);
  assert.doesNotMatch(harness.renderHeader(), /Opus 4\.6|high|32%|disk 200G|⛁/);
  await harness.handlers.get("model_select")?.({}, harness.context);
  assert.doesNotMatch(harness.renderHeader(), /gpt-5\.4|Context|82%/);
});

test("fits dense global status within the terminal width", async () => {
  const inProgress = Array.from({ length: 2 }, (_, index) =>
    issue(`doing-${index}`, "in_progress"),
  );
  const blocked = [issue("blocked", "blocked")];
  const ready = Array.from({ length: 19 }, (_, index) =>
    issue(`ready-${index}`),
  );
  const waiting = Array.from({ length: 2 }, (_, index) =>
    issue(`waiting-${index}`),
  );
  const closed = Array.from({ length: 115 }, (_, index) =>
    issue(`closed-${index}`, "closed"),
  );
  const harness = createHarness({
    sessionName: "",
    issues: [...inProgress, ...blocked, ...ready, ...waiting],
    readyIds: ready.map((item) => item.id),
    closed,
  });

  await start(harness);

  const rendered = harness.renderHeader(80);
  assert.ok(
    visibleWidth(rendered) <= 80,
    `status width ${visibleWidth(rendered)} exceeds 80`,
  );
  assert.match(rendered, /2 in-progress/);
  assert.match(rendered, /1 blocked/);
});

test("empty queries render zero task counts without hiding identity", async () => {
  const harness = createHarness();
  await start(harness);

  assert.match(harness.renderHeader(), /pi-setup/);
  assert.doesNotMatch(
    harness.renderHeader(),
    /Opus 4\.6|high|32%|disk|⛁|in-progress|blocked|ready|waiting|needs you|closed|unavailable/,
  );
});

for (const unavailable of ["active", "ready", "closed"] as const) {
  test(`${unavailable} query failure renders task state unavailable and preserves identity`, async () => {
    const harness = createHarness({ unavailable });
    await assert.doesNotReject(start(harness));

    assert.match(harness.renderHeader(), /tasks unavailable/);
    assert.doesNotMatch(harness.renderHeader(), /Opus 4\.6|high|32%|disk|⛁/);
  });
}

test("Herdr uses the existing issue read and actual current model", async () => {
  const task = issue("jp-owned", "in_progress");
  task.lifecycle = activeLifecycle("session-1");
  const h = createHarness({ issues: [task], herdr: true });
  await start(h);
  await setImmediate();
  assert.equal(h.calls.length, 1);
  assert.equal(h.metadata.at(-1)?.pi_task, "Task jp-owned");
  assert.equal(h.metadata.at(-1)?.pi_model, "gpt-5.4");
  assert.equal(h.metadata.at(-1)?.pi_context_warning, "Context 82%");
  h.context.model = { id: "another-model" };
  await h.handlers.get("model_select")?.({}, h.context);
  await setImmediate();
  assert.equal(h.metadata.at(-1)?.pi_model, "another-model");
  assert.equal(h.calls.length, 1, "model changes must not query Beads");
  await h.handlers.get("session_shutdown")?.({}, h.context);
});

test("claim and release events re-read ownership, including failed close", async () => {
  const h = createHarness({ herdr: true });
  await start(h);
  await setImmediate();
  assert.equal(h.metadata.at(-1)?.pi_task, "Unassigned");
  const task = issue("jp-owned", "in_progress");
  task.lifecycle = activeLifecycle("session-1");
  h.setIssues([task]);
  await h.handlers.get("tool_execution_end")?.(
    { toolName: "task_claim", isError: false },
    h.context,
  );
  await setImmediate();
  assert.equal(h.metadata.at(-1)?.pi_task, "Task jp-owned");
  const calls = h.calls.length;
  await h.handlers.get("tool_execution_end")?.(
    { toolName: "task_close", isError: true },
    h.context,
  );
  await setImmediate();
  assert.equal(h.calls.length, calls + 1);
  assert.equal(h.metadata.at(-1)?.pi_task, "Task jp-owned");
  h.setIssues([]);
  await h.handlers.get("tool_execution_end")?.(
    { toolName: "task_wait" },
    h.context,
  );
  await setImmediate();
  assert.equal(h.metadata.at(-1)?.pi_task, "Unassigned");
  h.setUnavailable("active");
  await h.handlers.get("before_agent_start")?.({}, h.context);
  await setImmediate();
  assert.equal(h.metadata.at(-1)?.pi_task, "Task unavailable");
  await h.handlers.get("session_shutdown")?.({}, h.context);
});

for (const unavailable of ["ready", "closed"] as const) {
  test(`${unavailable} read failure respects the ownership discovery boundary`, async () => {
    const task = issue("jp-owned", "in_progress");
    task.lifecycle = activeLifecycle("session-1");
    const h = createHarness({ issues: [task], herdr: true, unavailable });
    await start(h);
    await setImmediate();
    if (unavailable === "closed") {
      assert.match(h.renderHeader(), /tasks unavailable/);
      assert.equal(h.metadata.at(-1)?.pi_task_state, "unavailable");
      assert.equal(h.metadata.at(-1)?.pi_task, "Task unavailable");
      assert.notEqual(h.metadata.at(-1)?.pi_task_state, "unassigned");
    } else {
      assert.match(h.renderHeader(), /jp-owned • Task jp-owned/);
      assert.doesNotMatch(h.renderHeader(), /tasks unavailable/);
      assert.equal(h.metadata.at(-1)?.pi_task, "Task jp-owned");
    }
    assert.equal(h.calls.length, 1);
    assert.equal(
      legacyLifecycle(task.lifecycle).execution?.sessionId,
      "session-1",
    );
    assert.ok(h.calls.every((args) => args[0] === "list"));
    await h.handlers.get("session_shutdown")?.({}, h.context);
  });
}

test("RPC sessions inheriting a valid sender do not overwrite the parent", async () => {
  const h = createHarness({ herdr: true, mode: "rpc" });
  await start(h);
  await h.handlers.get("model_select")?.({}, h.context);
  await h.handlers.get("session_shutdown")?.({}, h.context);
  assert.deepEqual(h.metadata, []);
});

test("shutdown abandons an in-flight task read before it can publish stale metadata", async () => {
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = createHarness({
    herdr: true,
    beforeExec: async (n) => {
      if (n === 4) {
        began();
        await blocked;
      }
    },
  });
  await start(h);
  await setImmediate();
  const refresh = Promise.resolve(h.handlers.get("turn_end")?.({}, h.context));
  await started;
  await h.handlers.get("session_shutdown")?.({}, h.context);
  h.markStale();
  release();
  await refresh;
  await setImmediate();
  assert.deepEqual(h.staleAccesses, []);
  assert.ok(Object.values(h.metadata.at(-1)!).every((v) => v === null));
});

test("coalesces overlapping task refreshes and preserves the latest snapshot", async () => {
  let release!: () => void;
  let began!: () => void;
  const beganPromise = new Promise<void>((resolve) => {
    began = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = createHarness({
    herdr: true,
    beforeExec: async (n) => {
      if (n === 4) {
        began();
        await blocked;
      }
    },
  });
  await start(h);
  const running = Promise.resolve(h.handlers.get("turn_end")?.({}, h.context));
  await beganPromise;
  const task = issue("jp-latest", "in_progress");
  task.lifecycle = activeLifecycle("session-1");
  h.setIssues([task]);
  const requests = Array.from({ length: 5 }, () =>
    h.handlers.get("before_agent_start")?.({}, h.context),
  );
  assert.equal(h.calls.length, 4);
  release();
  await Promise.all([running, ...requests]);
  await setImmediate();
  assert.equal(
    h.calls.length,
    5,
    "one active refresh plus one coalesced refresh",
  );
  assert.equal(h.metadata.at(-1)?.pi_task, "Task jp-latest");
  await h.handlers.get("session_shutdown")?.({}, h.context);
});

test("a stalled display lookup cannot prevent a prompt from starting", async () => {
  let release!: () => void;
  let began!: () => void;
  const beganPromise = new Promise<void>((resolve) => {
    began = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = createHarness({
    beforeExec: async (n) => {
      if (n === 4) {
        began();
        await blocked;
      }
    },
  });
  await start(h);
  const hook = Promise.resolve(
    h.handlers.get("before_agent_start")?.({}, h.context),
  );
  await beganPromise;
  const continued = await Promise.race([
    hook.then(() => true),
    setImmediate().then(() => false),
  ]);
  release();
  await hook;
  await setImmediate();
  await h.handlers.get("session_shutdown")?.({}, h.context);
  assert.equal(
    continued,
    true,
    "optional display reads must not gate model startup",
  );
});

test("task display queries pass a finite timeout to the process boundary", async () => {
  const h = createHarness();
  await start(h);
  assert.equal(h.executionLimits.length, 3);
  assert.ok(h.executionLimits.every((limits) => limits?.timeout === 1500));
});

test("Herdr preserves an idle task label instead of reporting legacy lease expiry", async () => {
  const owned = {
    ...issue("jp-idle", "in_progress"),
    lifecycle: activeLifecycle("session-1"),
  };
  legacyLifecycle(owned.lifecycle)!.execution!.expiresAt =
    "2026-09-15T12:00:00Z";
  const h = createHarness({ herdr: true, issues: [owned] });
  await start(h);
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_task, "Task jp-idle");
  await h.handlers.get("session_shutdown")?.({}, h.context);
});

for (const { scope, name, expected } of [
  {
    scope: { kind: "global" },
    name: "api-580c8e67",
    expected: "api-580c8e67 │ 3 ready",
  },
  {
    scope: { kind: "area", areaId: B },
    name: "api-580c8e67",
    expected: "api-580c8e67 │ Browse: Tooling (area) • 1 ready",
  },
  {
    scope: { kind: "project", projectId: P },
    name: "api-580c8e67",
    expected: "api-580c8e67 │ Browse: API • 1 ready",
  },
  {
    scope: { kind: "global" },
    name: "",
    expected: "3 ready",
  },
] satisfies { scope: WorkScope; name: string; expected: string }[]) {
  test(`unassigned catalog ${scope.kind} header separates identity from browsing despite display ${JSON.stringify(name)}`, async () => {
    const h = createHarness({
      ...catalogViewFixture(),
      sessionName: name,
      entries: [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 2, scope },
        },
      ],
    });
    await start(h);
    assert.equal(h.renderHeader().trimEnd(), expected);
    assert.equal(
      h.calls.length,
      3,
      "separate complete ownership, normal browsing and native readiness",
    );
  });
}

test("empty global view keeps identity without a redundant browse label", async () => {
  const h = createHarness({
    ...catalogViewFixture(),
    issues: [],
    entries: [
      {
        type: "custom",
        customType: "jp-project-scope",
        data: { version: 2, scope: { kind: "global" } },
      },
    ],
  });
  await start(h);
  assert.equal(h.renderHeader().trimEnd(), "pi-setup");
  assert.equal(h.calls.length, 3);
});

test("Herdr publishes owned project and area independently of the browse view", async () => {
  const fixture = catalogViewFixture();
  const h = createHarness({
    ...fixture,
    herdr: true,
    issues: [ownedCatalogIssue()],
    entries: [projectEntry("maintenance")],
  });
  await start(h);
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_project, "API");
  assert.equal(h.metadata.at(-1)!.pi_area, "Product");
  assert.equal(h.calls.length, 1, "reuse the existing owned-task lookup");

  fixture.catalog.projects[P].name = "API v2";
  fixture.catalog.projects[P].areaId = B;
  fixture.catalog.areas[B].name = "Developer Tools";
  await h.handlers.get("turn_end")!({}, h.context);
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_project, "API v2");
  assert.equal(h.metadata.at(-1)!.pi_area, "Developer Tools");
  assert.equal(h.calls.length, 2);
  await h.handlers.get("session_shutdown")!({}, h.context);
  assert.equal(h.metadata.at(-1)!.pi_project, null);
  assert.equal(h.metadata.at(-1)!.pi_area, null);
});

for (const transition of [
  "release",
  "task failure",
  "catalog failure",
  "missing area",
  "legacy",
] as const) {
  test(`Herdr clears stale project and area after ${transition}`, async () => {
    const fixture = catalogViewFixture();
    const options = {
      ...fixture,
      catalog: fixture.catalog as WorkCatalog | null,
      catalogError: undefined as string | undefined,
      herdr: true,
      issues: [ownedCatalogIssue()],
      entries: [projectEntry("maintenance")],
    };
    const h = createHarness(options);
    await start(h);
    await setImmediate();
    assert.equal(h.metadata.at(-1)!.pi_area, "Product");
    if (transition === "release") h.setIssues([]);
    else if (transition === "task failure") h.setUnavailable("active");
    else if (transition === "catalog failure")
      options.catalogError = "Unavailable";
    else if (transition === "missing area")
      fixture.catalog.projects[P].areaId = null;
    else options.catalog = null;
    await h.handlers.get("turn_end")!({}, h.context);
    await setImmediate();
    assert.equal(h.metadata.at(-1)!.pi_project, null);
    assert.equal(h.metadata.at(-1)!.pi_area, null);
    await h.handlers.get("session_shutdown")!({}, h.context);
  });
}

test("unclassified projects do not display an invented area", async () => {
  const fixture = catalogViewFixture();
  fixture.catalog.projects[P].areaId = null;
  const h = createHarness({
    ...fixture,
    sessionName: "api-580c8e67",
    entries: [projectEntry("api")],
  });
  await start(h);
  assert.equal(
    h.renderHeader().trimEnd(),
    "api-580c8e67 │ Browse: API • 1 ready",
  );
});

for (const failure of ["catalog", "scope"] as const) {
  test(`${failure} failure distinguishes identity availability from browse availability`, async () => {
    const options = {
      ...catalogViewFixture(),
      catalogError: undefined as string | undefined,
      sessionName: "api-580c8e67",
      issues: [ownedCatalogIssue()],
      entries: [projectEntry("api")],
    };
    const h = createHarness(options);
    await start(h);
    assert.equal(
      h.renderHeader().trimEnd(),
      "api-580c8e67 • API • Product │ zz-owned • Task zz-owned",
    );
    if (failure === "catalog") options.catalogError = "Catalog unavailable";
    else options.entries.push(projectEntry("missing-project"));
    await h.handlers.get("session_info_changed")!({}, h.context);
    assert.equal(
      h.renderHeader().trimEnd(),
      failure === "catalog"
        ? "api-580c8e67 • identity unavailable │ tasks unavailable"
        : "api-580c8e67 • API • Product │ tasks unavailable",
    );
  });
}

test("a project's changed area appears on the next refresh without renaming the session", async () => {
  const fixture = catalogViewFixture();
  const h = createHarness({
    ...fixture,
    sessionName: "custom-580c8e67",
    issues: [ownedCatalogIssue()],
    entries: [projectEntry("api")],
  });
  await start(h);
  assert.equal(
    h.renderHeader().trimEnd(),
    "custom-580c8e67 • API • Product │ zz-owned • Task zz-owned",
  );
  fixture.catalog.projects[P].areaId = B;
  fixture.catalog.revision += 1;
  await h.handlers.get("turn_end")!({}, h.context);
  assert.equal(
    h.renderHeader().trimEnd(),
    "custom-580c8e67 • API • Tooling │ zz-owned • Task zz-owned",
  );
});

test("area headers retain Unicode and fit narrow terminal widths", async () => {
  const fixture = catalogViewFixture();
  fixture.catalog.areas[A].name = "開発🧰";
  const h = createHarness({
    ...fixture,
    sessionName: "session-580c8e67",
    issues: [ownedCatalogIssue()],
    entries: [projectEntry("api")],
  });
  await start(h);
  assert.equal(
    h.renderHeader().trimEnd(),
    "session-580c8e67 • API • 開発🧰 │ zz-owned • Task zz-owned",
  );
  for (const width of [0, 1, 12, 24, 60]) {
    assert.ok(visibleWidth(h.renderHeader(width)) <= width);
  }
});
test("scope changes during status refresh discard the old projection", async () => {
  const entries: Entry[] = [
    {
      type: "custom",
      customType: "jp-project-scope",
      data: { version: 2, scope: { kind: "area", areaId: A } },
    },
  ];
  const h = createHarness({
    catalog: catalogViewFixture().catalog,
    entries,
    beforeExec: async (n) => {
      if (n === 1)
        entries.push({
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 2, scope: { kind: "project", projectId: Q } },
        });
    },
    issues: [issue("zz-api", "open", ["workstream:api"])],
    readyIds: ["zz-api"],
  });
  await h.handlers.get("session_start")!({}, h.context);
  assert.equal(h.renderHeader(), "");
  await h.handlers.get("session_info_changed")!({}, h.context);
  assert.equal(h.renderHeader().trimEnd(), "pi-setup │ Browse: Maintenance");
});

test("corrupt catalog reports unavailable rather than global counts", async () => {
  const h = createHarness({
    catalogError: "Corrupt catalog fixture",
    issues: [issue("zz-hidden")],
    readyIds: ["zz-hidden"],
  });
  await h.handlers.get("session_start")!({}, h.context);
  assert.match(h.renderHeader(), /tasks unavailable/);
  assert.doesNotMatch(h.renderHeader(), /1 ready/);
});

test("catalog view changes keep the session-owned task visible with an outside-view marker", async () => {
  const fixture = catalogViewFixture();
  const h = createHarness({
    catalog: fixture.catalog,
    entries: [
      {
        type: "custom",
        customType: "jp-project-scope",
        data: { version: 2, scope: { kind: "area", areaId: A } },
      },
    ],
    issues: [
      {
        ...issue("zz-owned", "in_progress", ["workstream:maintenance"]),
        lifecycle: activeLifecycle("session-1"),
      },
    ],
  });
  await h.handlers.get("session_start")!({}, h.context);
  assert.equal(
    h.renderHeader().trimEnd(),
    "pi-setup • Maintenance • Tooling │ zz-owned • Task zz-owned (outside current view)",
  );
});

test("unknown catalog ownership is unavailable rather than unassigned", async () => {
  const fixture = catalogViewFixture();
  const h = createHarness({
    ...fixture,
    issues: [{ ...ownedCatalogIssue(), lifecycle: null }],
    entries: [projectEntry("api")],
  });
  await start(h);
  assert.match(h.renderHeader(), /identity unavailable/);
  assert.doesNotMatch(h.renderHeader(), /unassigned|Product/);
  assert.equal(h.calls.length, 1);
});

for (const conflict of ["deferred status", "non-active execution"] as const) {
  test(`catalog header reports ${conflict} as unavailable, not unassigned`, async () => {
    const row = ownedCatalogIssue();
    if (conflict === "deferred status") row.status = "deferred";
    else row.lifecycle!.phase = "actionable";
    const h = createHarness({
      ...catalogViewFixture(),
      issues: [row],
      entries: [projectEntry("api")],
      sessionName: "API-session1",
    });
    await start(h);
    assert.match(h.renderHeader(), /API-session1.*identity unavailable/);
    assert.doesNotMatch(h.renderHeader(), /unassigned/);
    assert.equal(h.calls.length, 1);
  });
}

test("deferred ownership facts do not broaden visible task counts", async () => {
  const deferred = {
    ...issue("zz-deferred", "deferred", ["workstream:api"]),
    lifecycle: {
      ...activeLifecycle("session-1"),
      phase: "deferred" as const,
      execution: null,
    },
  };
  const h = createHarness({
    ...catalogViewFixture(),
    issues: [deferred],
    entries: [projectEntry("api")],
    readyIds: [deferred.id],
  });
  await start(h);
  assert.match(h.renderHeader(), /pi-setup/);
  assert.doesNotMatch(h.renderHeader(), /1 ready|1 waiting|1 in-progress/);
});

test("a malformed browse filter cannot hide valid working identity", async () => {
  const h = createHarness({
    ...catalogViewFixture(),
    issues: [ownedCatalogIssue()],
    entries: [projectEntry("unknown")],
  });
  await start(h);
  assert.match(h.renderHeader(), /pi-setup • API • Product/);
  assert.match(h.renderHeader(), /tasks unavailable/);
  assert.equal(h.calls.length, 1);
});

test("browse changes refresh counts without a session rename and ignore retired sessions", async () => {
  const entries = [projectEntry("api")];
  const h = createHarness({ ...catalogViewFixture(), entries });
  await start(h);
  entries.push(projectEntry("maintenance"));
  h.events.emit(
    "pi:work-scope-changed",
    h.context.sessionManager.getSessionId(),
  );
  await setImmediate();
  assert.equal(
    h.renderHeader().trimEnd(),
    "pi-setup │ Browse: Maintenance • 1 ready",
  );
  assert.equal(h.context.sessionManager.getSessionName(), "pi-setup");
  const calls = h.calls.length;
  h.events.emit("pi:work-scope-changed", "another-session");
  await setImmediate();
  assert.equal(h.calls.length, calls);
  await h.handlers.get("session_shutdown")?.({}, h.context);
  h.markStale();
  h.events.emit("pi:work-scope-changed", "session-1");
  await setImmediate();
  assert.equal(h.calls.length, calls);
  assert.deepEqual(h.staleAccesses, []);
});

for (const transport of ["success", "failure", "absent"] as const) {
  test(`task remains in Pi status with ${transport} Herdr delivery`, async () => {
    const h = createHarness({
      ...catalogViewFixture(),
      issues: [ownedCatalogIssue()],
      entries: [projectEntry("maintenance")],
      herdr: transport !== "absent",
      metadataSuccess: transport !== "failure",
    });
    await start(h);
    await setImmediate();
    assert.match(
      h.renderHeader(),
      /pi-setup • API • Product.*zz-owned • Task zz-owned.*outside current view/,
    );
    assert.equal(h.calls.length, 1);
    if (transport === "absent") assert.deepEqual(h.metadata, []);
    else
      assert.equal(h.metadata.at(-1)!.displayAgent, "zz-owned • Task zz-owned");
  });
}

test("Herdr label follows existing refresh snapshots without a second task read", async () => {
  const h = createHarness({
    ...catalogViewFixture(),
    issues: [ownedCatalogIssue()],
    entries: [projectEntry("api")],
    herdr: true,
  });
  await start(h);
  await setImmediate();
  h.setIssues([{ ...ownedCatalogIssue(), title: "Changed title" }]);
  await h.handlers.get("turn_end")!({}, h.context);
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.displayAgent, "zz-owned • Changed title");
  assert.match(h.renderHeader(), /zz-owned • Changed title/);
  assert.equal(h.calls.length, 2);
  h.setIssues([]);
  await h.handlers.get("tool_execution_end")!(
    { toolName: "task_close" },
    h.context,
  );
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.displayAgent, "pi-setup");
  assert.match(h.renderHeader(), /pi-setup/);
  h.setUnavailable("active");
  await h.handlers.get("turn_end")!({}, h.context);
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.displayAgent, "Task unavailable");
  assert.match(h.renderHeader(), /identity unavailable/);
});

test("waiting events publish and clear an independent sidebar label", async () => {
  const h = createHarness({ herdr: true });
  await start(h);
  assert.equal(h.metadata.at(-1)!.pi_waiting, null);
  const task = h.metadata.at(-1)!.pi_task;
  const calls = h.calls.length;
  h.events.emit("pi:wakeup-waiting", "Waiting · until 15:05 UTC");
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_waiting, "Waiting · until 15:05 UTC");
  assert.equal(h.metadata.at(-1)!.pi_task, task);
  assert.equal(h.calls.length, calls, "waiting UI must not query Beads");
  const sent = h.metadata.length;
  h.events.emit("pi:wakeup-waiting", "Waiting · until 15:05 UTC");
  h.events.emit("pi:wakeup-waiting", { invalid: true });
  await setImmediate();
  assert.equal(h.metadata.length, sent);
  h.events.emit("pi:wakeup-waiting", null);
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_waiting, null);
  h.events.emit("pi:wakeup-waiting", "Waiting · until 16:00 UTC");
  await setImmediate();
  await h.handlers.get("session_shutdown")?.({}, h.context);
  assert.equal(h.metadata.at(-1)!.pi_waiting, null);
  h.events.emit("pi:wakeup-waiting", "Stale wait");
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_waiting, null);
});

for (const name of ["Investigation notes", ""]) {
  test(`catalog task context is explicit without replacing session name ${JSON.stringify(name)}`, async () => {
    const fixture = catalogViewFixture();
    const h = createHarness({
      ...fixture,
      sessionName: name,
      issues: [ownedCatalogIssue()],
      entries: [projectEntry("maintenance")],
      herdr: true,
    });
    await start(h);
    await setImmediate();
    assert.equal(
      h.renderHeader(200).trimEnd(),
      `${name ? name + " • " : ""}API • Product │ zz-owned • Task zz-owned (outside current view)`,
    );
    assert.equal(h.context.sessionManager.getSessionName(), name || undefined);
    assert.equal(h.metadata.at(-1)!.displayAgent, "zz-owned • Task zz-owned");
    assert.equal(h.calls.length, 1);
    h.setIssues([]);
    await h.handlers.get("tool_execution_end")!(
      { toolName: "task_close" },
      h.context,
    );
    await setImmediate();
    assert.equal(h.metadata.at(-1)!.displayAgent, name || "Unassigned");
    assert.doesNotMatch(
      h.renderHeader(),
      /Product|zz-owned|unassigned-session/,
    );
    assert.equal(h.context.sessionManager.getSessionName(), name || undefined);
    await h.handlers.get("session_shutdown")!({}, h.context);
  });
}

test("manual names and catalog project renames update independent status fields", async () => {
  const fixture = catalogViewFixture();
  const h = createHarness({
    ...fixture,
    sessionName: "My notes",
    issues: [ownedCatalogIssue()],
    entries: [projectEntry("api")],
  });
  await start(h);
  h.setSessionName("Renamed notes");
  fixture.catalog.projects[P].name = "API renamed";
  fixture.catalog.revision++;
  await h.handlers.get("session_info_changed")!({}, h.context);
  assert.equal(
    h.renderHeader(200).trimEnd(),
    "Renamed notes • API renamed • Product │ zz-owned • Task zz-owned",
  );
  assert.equal(h.context.sessionManager.getSessionName(), "Renamed notes");
  assert.equal(h.calls.length, 2);
});

test("legacy owned workstream is explicit and independent of the session name and browse filter", async () => {
  const owned = {
    ...issue("owned", "in_progress", ["workstream:Actual project"]),
    lifecycle: activeLifecycle("session-1"),
  };
  const h = createHarness({
    sessionName: "My notes",
    issues: [owned],
    entries: [projectEntry("Different project")],
  });
  await start(h);
  assert.equal(
    h.renderHeader(200).trimEnd(),
    "My notes • Actual project │ owned • Task owned",
  );
  assert.equal(h.calls.length, 1);
});

async function ownedV2(
  phase: "active" | "actionable" | "waiting" | "deferred" | "done",
): Promise<BeadsIssue> {
  const { state, withCheck, OWNER, NOW } = await import(
    "../../lib/task-lifecycle/v2-test-fixtures.js"
  );
  const { blockLifecycleV2, fingerprintConditionV2, nativeStatusV2 } =
    await import("../../lib/task-lifecycle/v2-model.js");
  const owner = { ...OWNER, sessionId: "session-1" };
  const current = withCheck({ owner });
  const lifecycle =
    phase === "waiting"
      ? blockLifecycleV2(current, {
          operationId: "pause",
          sessionId: owner.sessionId,
          now: NOW,
          reason: "Wait",
          conditionFingerprint: fingerprintConditionV2(current, [])!,
        })
      : phase === "actionable"
        ? withCheck({ phase, owner, pause: null })
        : state({
            phase,
            owner,
            disposition:
              phase === "done"
                ? {
                    kind: "completed",
                    reason: "Delivered",
                    at: NOW,
                    evidenceArtifactIds: [],
                  }
                : null,
          });
  return {
    ...ownedCatalogIssue(),
    lifecycle,
    status: nativeStatusV2(lifecycle),
  };
}

for (const [phase, label] of [
  ["waiting", "Blocked"],
  ["actionable", "Ready to resume"],
  ["deferred", "Deferred"],
  ["done", "Done"],
] as const) {
  test(`header and optional Herdr keep title/project/area for owned ${phase}`, async () => {
    const row = await ownedV2(phase);
    const h = createHarness({
      catalog: catalogViewFixture().catalog,
      entries: [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 2, scope: { kind: "global" } },
        },
      ],
      issues: [row],
      herdr: true,
    });
    await start(h);
    await setImmediate();
    const metadata = h.metadata.at(-1)!;
    assert.equal(metadata.pi_task_state, "assigned");
    assert.equal(metadata.pi_task_id, row.id);
    assert.equal(metadata.pi_task_phase, phase);
    assert.equal(metadata.pi_task_status, label);
    assert.ok(metadata.pi_project);
    assert.ok(metadata.pi_area);
    assert.match(h.renderHeader(240), new RegExp(row.id));
    assert.ok(h.renderHeader(240).includes(label));
    assert.equal(h.calls.length, 1);
    await h.handlers.get("session_shutdown")?.({}, h.context);
  });
}

test("new lifecycle transitions refresh phase without clearing identity or wakeup text", async () => {
  const h = createHarness({
    catalog: catalogViewFixture().catalog,
    entries: [
      {
        type: "custom",
        customType: "jp-project-scope",
        data: { version: 2, scope: { kind: "global" } },
      },
    ],
    issues: [ownedCatalogIssue()],
    herdr: true,
  });
  await start(h);
  h.events.emit("pi:wakeup-waiting", "Waiting until 15:05");
  for (const [toolName, phase] of [
    ["task_block", "waiting"],
    ["task_resume", "active"],
  ] as const) {
    h.setIssues([await ownedV2(phase)]);
    await h.handlers.get("tool_execution_end")?.({ toolName }, h.context);
    await setImmediate();
    const metadata = h.metadata.at(-1)!;
    assert.equal(metadata.pi_task_state, "assigned");
    assert.equal(metadata.pi_task_phase, phase);
    assert.equal(metadata.pi_waiting, "Waiting until 15:05");
  }
  const released = await ownedV2("actionable");
  if (released.lifecycle?.version !== 2) throw new Error("invalid fixture");
  released.lifecycle.owner = null;
  h.setIssues([released]);
  await h.handlers.get("tool_execution_end")?.(
    { toolName: "task_release" },
    h.context,
  );
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_task_state, "unassigned");
  assert.equal(h.metadata.at(-1)!.pi_task_phase, null);
  assert.equal(h.metadata.at(-1)!.pi_project, null);
  assert.equal(h.metadata.at(-1)!.pi_area, null);
  await h.handlers.get("session_shutdown")?.({}, h.context);
});

test("native-hidden ownership still supplies the header and Herdr identity", async () => {
  const row = await ownedV2("actionable");
  const h = createHarness({
    catalog: catalogViewFixture().catalog,
    entries: [
      {
        type: "custom",
        customType: "jp-project-scope",
        data: { version: 2, scope: { kind: "global" } },
      },
    ],
    issues: [row],
    hiddenIds: [row.id],
    herdr: true,
  });
  await start(h);
  await setImmediate();
  assert.equal(h.metadata.at(-1)!.pi_task_id, row.id);
  assert.match(h.renderHeader(240), /Ready to resume/);
  assert.equal(h.calls.length, 1);
  await h.handlers.get("session_shutdown")?.({}, h.context);
});

test("complete ownership discovery does not add native-hidden work to backlog counts", async () => {
  const h = createHarness({
    issues: [issue("jp-visible"), issue("jp-hidden")],
    hiddenIds: ["jp-hidden"],
    readyIds: ["jp-visible", "jp-hidden"],
  });
  await start(h);
  assert.match(h.renderHeader(240), /1 ready/);
  assert.doesNotMatch(h.renderHeader(240), /2 ready/);
  assert.equal(h.calls.filter((args) => args.includes("--all")).length, 1);
  assert.equal(
    h.calls.filter((args) => args[0] === "list" && !args.includes("--all"))
      .length,
    1,
  );
});

test("owned successful work with retained resources has an explicit cleanup header", async () => {
  const row = await ownedV2("actionable");
  const { resource, NOW } = await import(
    "../../lib/task-lifecycle/v2-test-fixtures.js"
  );
  row.lifecycle!.activeCheck!.onSatisfied = "close";
  row.lifecycle!.activeCheck!.state = "satisfied";
  row.lifecycle!.activeCheck!.lastCheckedAt = NOW;
  row.lifecycle!.activeCheck!.lastObservation = "Delivered";
  row.lifecycle!.resources = [resource()];
  const h = createHarness({
    catalog: catalogViewFixture().catalog,
    entries: [
      {
        type: "custom",
        customType: "jp-project-scope",
        data: { version: 2, scope: { kind: "global" } },
      },
    ],
    issues: [row],
  });
  await start(h);
  assert.match(h.renderHeader(240), /Ready.*cleanup required/i);
});
