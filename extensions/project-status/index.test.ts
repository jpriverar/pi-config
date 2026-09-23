import assert from "node:assert/strict";
import test from "node:test";

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
  ...(issue.lifecycle === undefined
    ? {}
    : { metadata: { piLifecycle: issue.lifecycle } }),
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

function createHarness(
  options: {
    issues?: BeadsIssue[];
    readyIds?: string[];
    closed?: BeadsIssue[];
    unavailable?: Query;
    sessionName?: string;
    sessionId?: string;
    entries?: readonly Entry[];
    beforeExec?: (callNumber: number) => Promise<void>;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const calls: string[][] = [];
  const staleAccesses: string[] = [];
  let stale = false;
  let sessionName =
    options.sessionName === undefined ? "pi-setup" : options.sessionName;
  let widgetFactory: any;
  const issues = options.issues ?? [];
  const readyIds = new Set(options.readyIds ?? []);

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    async exec(_command: string, args: string[]) {
      if (stale) staleAccesses.push("pi.exec");
      calls.push(args);
      await options.beforeExec?.(calls.length);
      const query: Query =
        args[0] === "ready"
          ? "ready"
          : args.includes("closed")
            ? "closed"
            : "active";
      if (options.unavailable === query) {
        return { code: 1, stdout: "", stderr: "private failure" };
      }
      const result =
        query === "closed"
          ? (options.closed ?? [])
          : query === "ready"
            ? issues.filter((item) => readyIds.has(item.id))
            : issues;
      return {
        code: 0,
        stdout: JSON.stringify(result.map(rawIssue)),
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
    mode: "tui",
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

  projectStatus(pi as any);
  return {
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
  assert.doesNotMatch(
    harness.renderHeader(),
    /in-progress|blocked|ready|waiting|needs you|closed/,
  );
  const narrow = harness.renderHeader(24);
  assert.ok(visibleWidth(narrow) <= 24);
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

test("keeps aggregate counts when the session owns multiple active tasks", async () => {
  const first = issue("jp-first", "in_progress");
  first.lifecycle = activeLifecycle("session-1");
  const second = issue("jp-second", "in_progress");
  second.lifecycle = activeLifecycle("session-1");
  const harness = createHarness({ issues: [first, second] });

  await start(harness);

  assert.match(harness.renderHeader(), /2 in-progress/);
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

test("explicit scope drives counts while the generated name stays visible", async () => {
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

  assert.match(harness.renderHeader(), /pi-setup-580c8e67/);
  assert.match(harness.renderHeader(), /1 in-progress/);
  assert.match(harness.renderHeader(), /1 closed/);
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
  assert.equal(harness.handlers.get("model_select"), undefined);
  assert.equal(harness.handlers.get("thinking_level_select"), undefined);
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
