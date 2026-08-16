import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsIssue } from "../../lib/beads.js";
import projectStatus from "./index.js";

process.env.BEADS_DIR = "/tmp/personal/.beads";

type Handler = (event?: unknown, context?: any) => Promise<unknown> | unknown;
type Query = "active" | "ready" | "closed";

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
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const calls: string[][] = [];
  let thinkingLevel = "high";
  let sessionName =
    options.sessionName === undefined ? "pi-setup" : options.sessionName;
  let renderedWidget = "";
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
        renderedWidget = factory ? factory({}, {}).render(120)[0] : "";
      },
    },
  };

  projectStatus(pi as any);
  return {
    calls,
    context,
    handlers,
    render: () => renderedWidget,
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

test("scopes named sessions case-insensitively to the primary workstream", async () => {
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
