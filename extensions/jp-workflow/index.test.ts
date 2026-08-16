import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsIssue } from "../../lib/beads.js";
import jpWorkflow from "./index.js";

const store = "/tmp/personal/.beads";
process.env.BEADS_DIR = store;

type Handler = (event?: any, context?: any) => Promise<any> | any;
type Tool = {
  name: string;
  description: string;
  parameters: { required?: string[] };
  execute: (id: string, params: any) => Promise<any>;
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function rawIssue(issue: BeadsIssue): Record<string, unknown> {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    labels: issue.labels,
    ...(issue.updatedAt === undefined ? {} : { updated_at: issue.updatedAt }),
  };
}

function createHarness(
  options: {
    sessionName?: string;
    branch?: any[];
    issues?: BeadsIssue[];
    readyIds?: string[];
    exec?: (
      command: string,
      args: string[],
    ) => Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const renderers = new Map<string, Function>();
  const appended: Array<{ customType: string; data: any }> = [];
  const sent: Array<{ message: any; options: any }> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const branch = options.branch ?? [];
  const issues = options.issues ?? [];
  const readyIds = new Set(
    options.readyIds ??
      issues
        .filter((issue) => issue.status === "open")
        .map((issue) => issue.id),
  );

  const defaultExec = async (command: string, args: string[]) => {
    const selected =
      args[0] === "ready"
        ? issues.filter((issue) => readyIds.has(issue.id))
        : issues;
    return {
      code: 0,
      stdout: JSON.stringify(selected.map(rawIssue)),
      stderr: "",
    };
  };

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    registerEntryRenderer(customType: string, renderer: Function) {
      renderers.set(customType, renderer);
    },
    appendEntry(customType: string, data: any) {
      appended.push({ customType, data });
    },
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      return (options.exec ?? defaultExec)(command, args);
    },
    getSessionName() {
      return options.sessionName;
    },
    sendMessage(message: any, sendOptions: any) {
      sent.push({ message, options: sendOptions });
    },
  };
  const context = {
    sessionManager: { getBranch: () => branch },
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
  };

  jpWorkflow(pi as any);

  return {
    appended,
    branch,
    calls,
    context,
    handlers,
    notifications,
    renderers,
    sent,
    tools,
  };
}

const flushDeferred = () => new Promise((resolve) => setTimeout(resolve, 0));

async function start(harness: ReturnType<typeof createHarness>) {
  await harness.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    harness.context,
  );
  await flushDeferred();
}

function renderCard(
  harness: ReturnType<typeof createHarness>,
  width = 100,
): string {
  const renderer = harness.renderers.get("jp-work-startup");
  assert.ok(renderer, "startup renderer was not registered");
  assert.equal(harness.appended.length, 1);
  return renderer(harness.appended[0], {}, theme).render(width).join("\n");
}

function issue(
  id: string,
  status: BeadsIssue["status"] = "open",
  labels: string[] = [],
  title = `Task ${id.replace(/^jp-/, "")}`,
): BeadsIssue {
  return { id, title, status, labels };
}

test("visible startup table contains every active task exactly once and puts inbox last", async () => {
  const issues = [
    issue("jp-doing", "in_progress", ["workstream:alpha"]),
    issue("jp-wait", "open", ["workstream:beta"]),
    issue("jp-ready", "open", ["workstream:alpha"]),
    issue("jp-inbox", "open"),
  ];
  const harness = createHarness({ issues, readyIds: ["jp-ready"] });

  await start(harness);
  const output = renderCard(harness);

  for (const item of issues) {
    assert.equal(output.match(new RegExp(item.id, "g"))?.length, 1, item.id);
  }
  assert.match(output, /IN PROGRESS/);
  assert.match(output, /WAITING/);
  assert.match(output, /READY/);
  assert.ok(
    output.indexOf("ALPHA — 2") < output.indexOf("INBOX • NO PROJECT — 1"),
  );
  assert.ok(
    output.indexOf("BETA — 1") < output.indexOf("INBOX • NO PROJECT — 1"),
  );
});

test("hidden context remains capped while the visible table remains complete", async () => {
  const issues = Array.from({ length: 12 }, (_, index) =>
    issue(`jp-${index}`, "open", ["workstream:core"]),
  );
  const harness = createHarness({ issues });

  const hidden = await harness.handlers.get("before_agent_start")?.();
  await start(harness);
  const visible = renderCard(harness);

  assert.match(hidden.message.content, /Ready \(12, showing 5\)/);
  assert.doesNotMatch(hidden.message.content, /jp-11/);
  assert.match(visible, /CORE — 12/);
  assert.match(visible, /jp-11/);
});

test("multiple workstream labels preserve source order and the first controls scoping", async () => {
  const crossCutting = issue("jp-cross", "open", [
    "workstream:zeta",
    "workstream:alpha",
  ]);
  const global = createHarness({ issues: [crossCutting] });
  const scoped = createHarness({
    sessionName: "alpha",
    issues: [crossCutting],
  });

  await start(global);
  await start(scoped);
  const hidden = await global.handlers.get("before_agent_start")?.();

  assert.match(renderCard(global), /ZETA — 1/);
  assert.doesNotMatch(renderCard(global), /ALPHA — 1/);
  assert.match(hidden.message.content, /\[zeta,alpha\]/);
  assert.match(renderCard(scoped), /No tracked work for project 'alpha'/);
});

test("empty and unavailable Beads produce stable states without throwing", async (t) => {
  await t.test("empty", async () => {
    const harness = createHarness();
    await start(harness);

    assert.match(renderCard(harness), /Store is empty/);
    const hidden = await harness.handlers.get("before_agent_start")?.();
    assert.match(hidden.message.content, /Store is empty/);
  });

  await t.test("unavailable", async () => {
    const sentinel = "SECRET TASK: customer incident";
    const harness = createHarness({
      exec: async () => ({ code: 127, stdout: "", stderr: sentinel }),
    });

    await assert.doesNotReject(start(harness));
    assert.equal(harness.appended.length, 0);
    assert.equal(harness.notifications.length, 1);
    assert.match(
      harness.notifications[0].message,
      /list issues.*\/tmp\/personal\/\.beads.*bd CLI is unavailable/,
    );
    assert.doesNotMatch(harness.notifications[0].message, /SECRET TASK/);

    const hidden = await harness.handlers.get("before_agent_start")?.();
    assert.match(
      hidden.message.content,
      /Unavailable: list issues.*\/tmp\/personal\/\.beads.*bd CLI is unavailable/,
    );
    assert.doesNotMatch(hidden.message.content, /SECRET TASK/);
  });
});

test("mutation tools preserve schemas, arguments, and decoded JSON output", async () => {
  const responses = [
    { id: "jp-new", title: "New task", status: "open" },
    [{ id: "jp-new", title: "New task", status: "in_progress" }],
    [{ id: "jp-new", title: "New task", status: "closed" }],
  ];
  let response = 0;
  const harness = createHarness({
    exec: async () => ({
      code: 0,
      stdout: JSON.stringify(responses[response++]),
      stderr: "",
    }),
  });
  const file = harness.tools.get("file_issue");
  const update = harness.tools.get("update_issue");
  const close = harness.tools.get("close_issue");
  assert.ok(file);
  assert.ok(update);
  assert.ok(close);

  assert.deepEqual(file.parameters.required, ["title", "why"]);
  assert.deepEqual(close.parameters.required, ["id", "reason"]);
  assert.match(file.description, /explicitly approved/);
  assert.match(update.description, /No approval needed/);
  assert.match(close.description, /No approval needed/);

  const filed = await file.execute("call-1", {
    title: "New task",
    why: "It matters",
    workstream: "core",
    needs_jp: true,
  });
  const updated = await update.execute("call-2", {
    id: "jp-new",
    status: "in_progress",
  });
  const closed = await close.execute("call-3", {
    id: "jp-new",
    reason: "Verified",
  });

  assert.deepEqual(harness.calls, [
    {
      command: "bd",
      args: [
        "create",
        "New task",
        "-d",
        "It matters",
        "-l",
        "workstream:core,needs:jp",
        "--json",
        "--db",
        store,
      ],
    },
    {
      command: "bd",
      args: ["update", "jp-new", "--claim", "--json", "--db", store],
    },
    {
      command: "bd",
      args: [
        "close",
        "jp-new",
        "-r",
        "Verified",
        "--suggest-next",
        "--json",
        "--db",
        store,
      ],
    },
  ]);
  assert.deepEqual(JSON.parse(filed.content[0].text), responses[0]);
  assert.deepEqual(JSON.parse(updated.content[0].text), responses[1]);
  assert.deepEqual(JSON.parse(closed.content[0].text), responses[2]);
});

test("update_issue rejects an empty mutation without invoking Beads", async () => {
  const harness = createHarness();
  const update = harness.tools.get("update_issue");
  assert.ok(update);

  await assert.rejects(
    update.execute("call", { id: "jp-1" }),
    /update_issue jp-1: no changes given/,
  );
  assert.equal(harness.calls.length, 0);
});

test("mutation failures include operation and store but redact process output", async () => {
  const sentinel = "SECRET TASK: customer incident";
  const harness = createHarness({
    exec: async () => ({ code: 2, stdout: "", stderr: sentinel }),
  });
  const file = harness.tools.get("file_issue");
  assert.ok(file);

  await assert.rejects(
    file.execute("call", { title: "New", why: "Needed" }),
    (error: Error) => {
      assert.match(error.message, /create issue/);
      assert.match(error.message, /\/tmp\/personal\/\.beads/);
      assert.match(error.message, /bd exited with code 2/);
      assert.doesNotMatch(error.message, /SECRET TASK/);
      return true;
    },
  );
});
