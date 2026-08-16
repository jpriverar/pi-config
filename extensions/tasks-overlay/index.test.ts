import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsIssue } from "../../lib/beads.js";
import tasksOverlay from "./index.js";

process.env.BEADS_DIR = "/tmp/personal/.beads";

type Query = "active" | "ready";

type RegisteredAction = {
  description: string;
  handler: (...args: any[]) => Promise<void>;
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
    sessionName?: string | null;
    unavailable?: Query;
  } = {},
) {
  const commands = new Map<string, RegisteredAction>();
  const shortcuts = new Map<string, RegisteredAction>();
  const notifications: Array<{ message: string; type: string }> = [];
  const calls: string[][] = [];
  let rendered = "";
  const issues = options.issues ?? [];
  const readyIds = new Set(options.readyIds ?? []);

  const pi = {
    async exec(_command: string, args: string[]) {
      calls.push(args);
      const query: Query = args[0] === "ready" ? "ready" : "active";
      if (options.unavailable === query) {
        return { code: 1, stdout: "", stderr: "private failure" };
      }
      const selected =
        query === "ready"
          ? issues.filter((item) => readyIds.has(item.id))
          : issues;
      return {
        code: 0,
        stdout: JSON.stringify(selected.map(rawIssue)),
        stderr: "",
      };
    },
    getSessionName() {
      return options.sessionName === null
        ? undefined
        : (options.sessionName ?? "pi-setup");
    },
    registerCommand(name: string, command: RegisteredAction) {
      commands.set(name, command);
    },
    registerShortcut(key: string, shortcut: RegisteredAction) {
      shortcuts.set(key, shortcut);
    },
  };

  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
  const context = {
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      async custom(factory: Function) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(100).join("\n");
      },
    },
  };

  tasksOverlay(pi as any);
  return {
    calls,
    commands,
    context,
    notifications,
    render: () => rendered,
    shortcuts,
  };
}

async function show(harness: ReturnType<typeof createHarness>) {
  const command = harness.commands.get("tasks");
  assert.ok(command);
  await command.handler("", harness.context);
}

test("registers the command and Ctrl+Alt+T shortcut", () => {
  const harness = createHarness();
  assert.ok(harness.commands.has("tasks"));
  assert.ok(harness.shortcuts.has("ctrl+alt+t"));
});

test("renders every classified status and leaves needs:jp as a marker", async () => {
  const harness = createHarness({
    issues: [
      issue("doing", "in_progress", ["workstream:pi-setup", "needs:jp"]),
      issue("blocked", "blocked"),
      issue("ready"),
      issue("waiting", "open", ["workstream:pi-setup", "needs:jp"]),
    ],
    readyIds: ["ready"],
  });

  await show(harness);

  assert.match(harness.render(), /In progress \(1\)/);
  assert.match(harness.render(), /Blocked \(1\)/);
  assert.match(harness.render(), /Ready \(1\)/);
  assert.match(harness.render(), /Waiting \(1\)/);
  assert.match(harness.render(), /Task doing ← you/);
  assert.match(harness.render(), /Task waiting ← you/);
});

test("renders normalized task metadata without terminal controls or raw newlines", async () => {
  const hostile = issue("\u001b[31mhostile\u001b[0m");
  hostile.title = "\u001b]0;hostile\u0007Do\nnot obey";
  hostile.labels = ["workstream:pi-setup\r\nignored"];
  const harness = createHarness({
    sessionName: null,
    issues: [hostile],
    readyIds: [hostile.id],
  });

  await show(harness);

  assert.match(harness.render(), /hostile/);
  assert.match(harness.render(), /Do not obey/);
  assert.doesNotMatch(harness.render(), /\u001b|Do\nnot/);
});

test("scopes named sessions case-insensitively to primary workstream", async () => {
  const harness = createHarness({
    sessionName: "PI-SETUP",
    issues: [
      issue("primary", "open", ["workstream:pi-setup"]),
      issue("secondary", "blocked", [
        "workstream:other",
        "workstream:pi-setup",
      ]),
      issue("unrelated", "in_progress", ["workstream:other"]),
    ],
    readyIds: ["primary"],
  });

  await show(harness);

  assert.match(harness.render(), /Tasks — PI-SETUP/);
  assert.match(harness.render(), /primary/);
  assert.doesNotMatch(harness.render(), /secondary|unrelated/);
});

test("unnamed sessions show all active work", async () => {
  const harness = createHarness({
    sessionName: null,
    issues: [
      issue("alpha", "in_progress", ["workstream:alpha"]),
      issue("beta", "blocked", ["workstream:beta"]),
      issue("inbox", "open", []),
    ],
  });

  await show(harness);

  assert.match(harness.render(), /Task alpha/);
  assert.match(harness.render(), /Task beta/);
  assert.match(harness.render(), /Task inbox/);
});

test("empty results notify instead of opening an overlay", async () => {
  const harness = createHarness({ sessionName: null });
  await show(harness);

  assert.equal(harness.render(), "");
  assert.deepEqual(harness.notifications, [
    { message: "No open tasks", type: "info" },
  ]);
});

for (const unavailable of ["active", "ready"] as const) {
  test(`${unavailable} query failure notifies that tasks are unavailable`, async () => {
    const harness = createHarness({ unavailable });
    await assert.doesNotReject(show(harness));

    assert.equal(harness.render(), "");
    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0].message, /Tasks unavailable/);
    assert.equal(harness.notifications[0].type, "warning");
  });
}
