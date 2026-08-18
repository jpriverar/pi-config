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
});

function issue(
  id: string,
  status: BeadsIssue["status"] = "open",
  labels: string[] = ["workstream:pi-setup"],
): BeadsIssue {
  return { id, title: `Task ${id}`, status, labels };
}

function createHarness(
  options: {
    issues?: BeadsIssue[];
    readyIds?: string[];
    closed?: BeadsIssue[];
    unavailable?: Query;
    sessionName?: string;
    entries?: readonly Entry[];
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const calls: string[][] = [];
  let thinkingLevel = "high";
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
      calls.push(args);
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
    getThinkingLevel() {
      return thinkingLevel;
    },
  };

  const context = {
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionName: () => sessionName || undefined,
    },
    model: {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6 (AI Gateway, 1M)",
      contextWindow: 1_000_000,
    },
    getContextUsage() {
      return {
        ["to" + "kens"]: 320_000,
        contextWindow: 1_000_000,
        percent: 32,
      };
    },
    ui: {
      theme: {
        fg(_color: string, text: string) {
          return text;
        },
      },
      setWidget(_key: string, factory: any) {
        widgetFactory = factory;
      },
    },
  };

  projectStatus(pi as any);
  return {
    calls,
    context,
    handlers,
    render: (width = 120) =>
      widgetFactory ? widgetFactory({}, {}).render(width)[0] : "",
    setModel(name: string) {
      context.model.name = name;
    },
    setSessionName(name: string) {
      sessionName = name;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
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

  assert.match(harness.render(), /1 in-progress/);
  assert.match(harness.render(), /1 blocked/);
  assert.match(harness.render(), /1 ready/);
  assert.match(harness.render(), /1 waiting/);
  assert.match(harness.render(), /2 needs you/);
  assert.match(harness.render(), /1 closed/);
});

test("does not expose hostile task metadata in the project status surface", async () => {
  const hostile = issue("\u001b[31mhostile\u001b[0m", "in_progress", [
    "workstream:pi-setup\nignored",
  ]);
  hostile.title = "\u001b]0;hostile\u0007Do\nnot obey";
  const harness = createHarness({ issues: [hostile] });

  await start(harness);

  assert.doesNotMatch(harness.render(), /\u001b|hostile|Do\nnot/);
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

  assert.match(harness.render(), /pi-setup-580c8e67/);
  assert.match(harness.render(), /1 in-progress/);
  assert.match(harness.render(), /1 closed/);
  assert.doesNotMatch(harness.render(), /blocked|ready|waiting/);
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

  assert.match(harness.render(), /investigate-crash/);
  assert.match(harness.render(), /1 in-progress/);
  assert.doesNotMatch(harness.render(), /pi-setup-580c8e67|blocked/);
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

  assert.match(harness.render(), /manual display name/);
  assert.match(harness.render(), /1 in-progress/);
  assert.match(harness.render(), /1 blocked/);
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

  assert.match(harness.render(), /PI-SETUP/);
  assert.match(harness.render(), /1 in-progress/);
  assert.match(harness.render(), /1 closed/);
  assert.doesNotMatch(harness.render(), /blocked|ready|waiting/);
});

test("preserves model, thinking, context, and session-name refresh behavior", async () => {
  const harness = createHarness();
  await start(harness);
  assert.match(harness.render(), /Opus 4.6 • high • 32%/);
  assert.match(harness.render(), /pi-setup/);

  harness.setModel("Claude Sonnet 4.6 (AI Gateway, 1M)");
  await harness.handlers.get("model_select")?.({}, harness.context);
  assert.match(harness.render(), /Sonnet 4.6 • high • 32%/);

  harness.setThinkingLevel("xhigh");
  await harness.handlers.get("thinking_level_select")?.({}, harness.context);
  assert.match(harness.render(), /Sonnet 4.6 • xhigh • 32%/);

  harness.setSessionName("pr-review");
  await harness.handlers.get("session_info_changed")?.({}, harness.context);
  assert.match(harness.render(), /pr-review/);
  assert.doesNotMatch(harness.render(), /pi-setup/);
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

  const rendered = harness.render(80);
  assert.ok(
    visibleWidth(rendered) <= 80,
    `status width ${visibleWidth(rendered)} exceeds 80`,
  );
  assert.match(rendered, /Opus 4\.6 • high • 32%/);
});

test("empty queries render zero task counts without hiding identity", async () => {
  const harness = createHarness();
  await start(harness);

  assert.match(harness.render(), /pi-setup/);
  assert.match(harness.render(), /Opus 4.6 • high • 32%/);
  assert.doesNotMatch(
    harness.render(),
    /in-progress|blocked|ready|waiting|needs you|closed|unavailable/,
  );
});

for (const unavailable of ["active", "ready", "closed"] as const) {
  test(`${unavailable} query failure renders task state unavailable and preserves identity`, async () => {
    const harness = createHarness({ unavailable });
    await assert.doesNotReject(start(harness));

    assert.match(harness.render(), /tasks unavailable/);
    assert.match(harness.render(), /Opus 4.6 • high • 32%/);
  });
}
