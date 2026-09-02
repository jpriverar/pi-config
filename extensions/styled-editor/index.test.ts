import assert from "node:assert/strict";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import styledEditor from "./index.js";

const BACKGROUND = "\x1b[48;5;17m";
const RESET_BACKGROUND = "\x1b[49m";
const RAIL = "\x1b[36m█\x1b[39m";

const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};

function createHarness() {
  const handlers = new Map<
    string,
    (event: unknown, context: any) => Promise<void> | void
  >();
  const commands = new Map<string, { handler: Function }>();
  const editorFactories: Array<Function | undefined> = [];
  const footerFactories: Function[] = [];
  const notifications: Array<[string, string]> = [];
  const foregroundCalls: Array<[string, string]> = [];
  const theme = {
    fg(color: string, text: string) {
      foregroundCalls.push([color, text]);
      return `\x1b[36m${text}\x1b[39m`;
    },
    bg(color: string, text: string) {
      assert.equal(color, "userMessageBg");
      return `${BACKGROUND}${text}${RESET_BACKGROUND}`;
    },
    getBgAnsi(color: string) {
      assert.equal(color, "userMessageBg");
      return BACKGROUND;
    },
  };
  const context = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme,
      setEditorComponent(factory: Function | undefined) {
        editorFactories.push(factory);
      },
      setFooter(factory: Function) {
        footerFactories.push(factory);
      },
      notify(message: string, level: string) {
        notifications.push([message, level]);
      },
    },
  };
  const pi = {
    on(
      name: string,
      handler: (event: unknown, context: any) => Promise<void> | void,
    ) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, command);
    },
  };

  styledEditor(pi as any);
  return {
    commands,
    context,
    editorFactories,
    footerFactories,
    foregroundCalls,
    handlers,
    notifications,
  };
}

function instantiate(factory: Function) {
  return factory({ terminal: { rows: 24 }, requestRender() {} }, editorTheme, {
    matches: () => false,
  });
}

async function start(harness: ReturnType<typeof createHarness>) {
  await harness.handlers.get("session_start")?.({}, harness.context);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const factory = harness.editorFactories.at(-1);
  assert.equal(typeof factory, "function");
  return instantiate(factory as Function);
}

async function waitForAutocomplete(editor: any): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (editor.isShowingAutocomplete()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("autocomplete did not become visible");
}

test("matches the private prompt renderer", async () => {
  const harness = createHarness();
  const editor = await start(harness);
  editor.setText("hello");

  const lines = editor.render(40);
  const inputLines = lines.slice(0, -1);
  const contentLine = inputLines.find((line: string) => line.includes("hello"));

  assert.ok(contentLine);
  assert.ok(inputLines.every((line: string) => line.startsWith(RAIL)));
  assert.deepEqual(
    harness.foregroundCalls,
    inputLines.map(() => ["borderAccent", "█"]),
  );
  assert.ok(inputLines.every((line: string) => line.includes(BACKGROUND)));
  assert.ok(
    inputLines.every(
      (line: string) => !stripTerminalSequences(line).includes("─"),
    ),
  );
  assert.ok(contentLine.includes(`\x1b[0m${BACKGROUND}`));
  assert.equal(lines.at(-1), "");
  assert.ok(lines.every((line: string) => visibleWidth(line) <= 40));
});

test("keeps narrow prompt renders within width", async () => {
  const editor = await start(createHarness());
  editor.setText("a long prompt that must wrap safely");

  for (const width of [0, 1, 2, 3, 8]) {
    const lines = editor.render(width);
    assert.ok(
      lines.every((line: string) => visibleWidth(line) <= width),
      `render exceeded width ${width}`,
    );
  }
});

test("keeps autocomplete outside the prompt background", async () => {
  const editor = await start(createHarness());
  editor.setAutocompleteProvider({
    async getSuggestions() {
      return {
        prefix: "/",
        items: [
          { value: "/alpha", label: "/alpha", description: "first command" },
          { value: "/beta", label: "/beta", description: "second command" },
        ],
      };
    },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
      return { lines, cursorLine, cursorCol };
    },
  });

  editor.handleInput("/");
  await waitForAutocomplete(editor);

  const alphaLine = editor
    .render(20)
    .find((line: string) => stripTerminalSequences(line).includes("/alpha"));
  assert.ok(alphaLine);
  assert.ok(!alphaLine.includes(BACKGROUND));
});

test("renders only the disk-space extension status", async () => {
  const harness = createHarness();
  await start(harness);
  const diskStatus = "\x1b[33mdisk 79.5G\x1b[39m";
  const footerData = {
    getExtensionStatuses: () =>
      new Map([
        ["disk-space", diskStatus],
        ["other-status", "hidden"],
      ]),
  };
  const footer = harness.footerFactories.at(-1)?.(
    {},
    harness.context.ui.theme,
    footerData,
  );

  assert.deepEqual(footer.render(80), [diskStatus]);
  assert.ok(footer.render(6).every((line: string) => visibleWidth(line) <= 6));
});

test("reinstalls for shortcuts and identity changes and supports explicit prompt toggles", async () => {
  const harness = createHarness();
  await start(harness);

  assert.ok(harness.editorFactories.length >= 2);
  const footerData = { getExtensionStatuses: () => new Map() };
  assert.deepEqual(
    harness.footerFactories
      .at(-1)?.({}, harness.context.ui.theme, footerData)
      .render(80),
    [],
  );

  const beforeModel = harness.editorFactories.length;
  await harness.handlers.get("model_select")?.({}, harness.context);
  assert.equal(harness.editorFactories.length, beforeModel + 1);

  const beforeThinking = harness.editorFactories.length;
  await harness.handlers.get("thinking_level_select")?.({}, harness.context);
  assert.equal(harness.editorFactories.length, beforeThinking + 1);

  const prompt = harness.commands.get("prompt");
  assert.ok(prompt);
  await prompt.handler("off", harness.context);
  assert.equal(harness.editorFactories.at(-1), undefined);
  await prompt.handler("off", harness.context);
  assert.equal(harness.editorFactories.at(-1), undefined);
  await prompt.handler("on", harness.context);
  assert.equal(typeof harness.editorFactories.at(-1), "function");
  await prompt.handler("toggle", harness.context);
  assert.equal(harness.editorFactories.at(-1), undefined);
  await prompt.handler("on", harness.context);
  assert.equal(typeof harness.editorFactories.at(-1), "function");

  assert.deepEqual(harness.notifications.slice(-5), [
    ["prompt off", "info"],
    ["prompt off", "info"],
    ["prompt on", "info"],
    ["prompt off", "info"],
    ["prompt on", "info"],
  ]);
});
