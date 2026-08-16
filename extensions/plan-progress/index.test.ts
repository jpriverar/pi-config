import assert from "node:assert/strict";
import test from "node:test";

import planProgress from "./index.js";

type Handler = (event?: unknown, context?: any) => Promise<unknown> | unknown;
type RegisteredAction = {
  description: string;
  handler: (...args: any[]) => Promise<unknown> | unknown;
};
type RegisteredTool = {
  execute: (...args: any[]) => Promise<{ content: Array<{ text: string }> }>;
};

function createHarness() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredAction>();
  const shortcuts = new Map<string, RegisteredAction>();
  const handlers = new Map<string, Handler>();
  const entries: any[] = [];
  const appended: any[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const widgets = new Map<string, string[] | undefined>();
  const documents: string[] = [];

  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
  const context = {
    sessionManager: {
      getEntries() {
        return entries;
      },
    },
    ui: {
      theme,
      setWidget(key: string, value: string[] | undefined) {
        widgets.set(key, value);
      },
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      async custom(factory: Function, options: any) {
        options?.onHandle?.({
          focus() {},
          unfocus() {},
          setHidden() {},
          hide() {},
        });
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        documents.push(component.render(100).join("\n"));
      },
    },
  };
  const pi = {
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom", customType, data };
      appended.push(entry);
      entries.push(entry);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: RegisteredAction) {
      commands.set(name, command);
    },
    registerShortcut(key: string, shortcut: RegisteredAction) {
      shortcuts.set(key, shortcut);
    },
  };

  planProgress(pi as any);
  return {
    appended,
    commands,
    context,
    documents,
    entries,
    handlers,
    notifications,
    shortcuts,
    tools,
    widgets,
  };
}

async function executeTool(
  harness: ReturnType<typeof createHarness>,
  name: string,
  params: unknown,
) {
  const tool = harness.tools.get(name);
  assert.ok(tool, `${name} is registered`);
  return tool.execute("call-id", params, undefined, undefined, harness.context);
}

async function runCommand(
  harness: ReturnType<typeof createHarness>,
  name: string,
) {
  const command = harness.commands.get(name);
  assert.ok(command, `${name} is registered`);
  await command.handler("", harness.context);
}

test("set_plan stores ordered steps and markdown", async () => {
  const harness = createHarness();

  await executeTool(harness, "set_plan", {
    steps: ["First", "Second"],
    markdown: "# The plan",
  });

  assert.deepEqual(harness.appended.at(-1)?.data, {
    steps: [
      { number: 1, text: "First", done: false },
      { number: 2, text: "Second", done: false },
    ],
    planMarkdown: "# The plan",
    specMarkdown: undefined,
  });
  assert.deepEqual(harness.widgets.get("plan-progress"), [
    "Plan (0/2)",
    "  ☐ First",
    "  ☐ Second",
  ]);
});

test("complete_step rejects invalid and duplicate indices and completes valid steps", async () => {
  const harness = createHarness();
  await executeTool(harness, "set_plan", { steps: ["First", "Second"] });

  const invalid = await executeTool(harness, "complete_step", { step: 3 });
  assert.equal(
    invalid.content[0].text,
    "Step 3 not found or already complete.",
  );
  assert.equal(harness.appended.length, 1);

  const completed = await executeTool(harness, "complete_step", { step: 1 });
  assert.equal(completed.content[0].text, "Step 1 done. 1 remaining.");
  assert.equal(harness.appended.at(-1)?.data.steps[0].done, true);

  const duplicate = await executeTool(harness, "complete_step", { step: 1 });
  assert.equal(
    duplicate.content[0].text,
    "Step 1 not found or already complete.",
  );
  assert.equal(harness.appended.length, 2);
});

test("set_spec replaces the current spec", async () => {
  const harness = createHarness();

  await executeTool(harness, "set_spec", { markdown: "old spec" });
  await executeTool(harness, "set_spec", { markdown: "new spec" });
  await runCommand(harness, "spec-view");

  assert.match(harness.documents.at(-1) ?? "", /new spec/);
  assert.doesNotMatch(harness.documents.at(-1) ?? "", /old spec/);
  assert.equal(harness.appended.at(-1)?.data.specMarkdown, "new spec");
});

test("plan and spec commands and shortcuts remain distinct", async () => {
  const harness = createHarness();
  assert.deepEqual(
    [...harness.commands.keys()],
    ["plan-clear", "plan-view", "spec-view"],
  );
  assert.ok(harness.shortcuts.has("ctrl+alt+p"));
  assert.ok(harness.shortcuts.has("ctrl+alt+s"));

  await executeTool(harness, "set_plan", {
    steps: ["Only step"],
    markdown: "plan-only-content",
  });
  await executeTool(harness, "set_spec", { markdown: "spec-only-content" });

  await harness.shortcuts.get("ctrl+alt+p")?.handler(harness.context);
  assert.match(harness.documents.at(-1) ?? "", /📋 Plan/);
  assert.match(harness.documents.at(-1) ?? "", /plan-only-content/);
  assert.doesNotMatch(harness.documents.at(-1) ?? "", /spec-only-content/);

  await harness.shortcuts.get("ctrl+alt+s")?.handler(harness.context);
  assert.match(harness.documents.at(-1) ?? "", /📄 Spec/);
  assert.match(harness.documents.at(-1) ?? "", /spec-only-content/);
  assert.doesNotMatch(harness.documents.at(-1) ?? "", /plan-only-content/);
});

test("viewer commands notify when empty and render populated documents", async () => {
  const harness = createHarness();

  await runCommand(harness, "plan-view");
  await runCommand(harness, "spec-view");
  assert.deepEqual(harness.notifications, [
    { message: "No 📋 plan to display", type: "info" },
    { message: "No 📄 spec to display", type: "info" },
  ]);
  assert.equal(harness.documents.length, 0);

  await executeTool(harness, "set_plan", { steps: ["Fallback plan"] });
  await executeTool(harness, "set_spec", { markdown: "Populated spec" });
  await runCommand(harness, "plan-view");
  await runCommand(harness, "spec-view");

  assert.match(harness.documents[0], /Fallback plan/);
  assert.match(harness.documents[1], /Populated spec/);
});

test("a new session cannot see state from the previous session", async () => {
  const harness = createHarness();
  await executeTool(harness, "set_plan", {
    steps: ["Previous session step"],
    markdown: "previous plan",
  });
  await executeTool(harness, "set_spec", { markdown: "previous spec" });

  harness.entries.length = 0;
  await harness.handlers.get("session_start")?.({}, harness.context);
  await runCommand(harness, "plan-view");
  await runCommand(harness, "spec-view");

  assert.deepEqual(harness.notifications.slice(-2), [
    { message: "No 📋 plan to display", type: "info" },
    { message: "No 📄 spec to display", type: "info" },
  ]);

  const freshHarness = createHarness();
  await freshHarness.handlers.get("session_start")?.({}, freshHarness.context);
  await runCommand(freshHarness, "plan-view");
  assert.deepEqual(freshHarness.notifications, [
    { message: "No 📋 plan to display", type: "info" },
  ]);
});
