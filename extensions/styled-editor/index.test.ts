import assert from "node:assert/strict";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { createStyledEditorExtension, StyledEditor } from "./index.js";
import { INPUT_BACKGROUND_ANSI } from "./theme.js";

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

function createEditor(): StyledEditor {
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  };
  const keybindings = { matches: () => false };
  return new StyledEditor(tui as any, editorTheme, keybindings as any);
}

async function waitForAutocomplete(editor: StyledEditor): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (editor.isShowingAutocomplete()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("autocomplete did not become visible");
}

test("keeps the tinted background active after the fake cursor reset", () => {
  const editor = createEditor();
  editor.setText("hello");

  const lines = editor.render(20);
  const contentLine = lines.find((line) => line.includes("hello"));
  assert.ok(contentLine);
  assert.match(contentLine, /\x1b\[7m/);
  assert.ok(
    contentLine.includes(`\x1b[0m${INPUT_BACKGROUND_ANSI}`),
    "the full cursor reset must immediately restore the input background",
  );
});

test("puts a plain spacer below and outside the tinted input block", () => {
  const editor = createEditor();
  const lines = editor.render(12);

  assert.equal(lines.at(-1), "");
  assert.ok(
    lines.slice(0, -1).every((line) => line.startsWith(INPUT_BACKGROUND_ANSI)),
  );
});

test("keeps narrow renders within width", () => {
  const editor = createEditor();
  editor.setText("a long prompt that must wrap safely");

  for (const width of [1, 2, 3, 8]) {
    const lines = editor.render(width);
    assert.ok(lines.length >= 4);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `render exceeded width ${width}`,
    );
  }
});

test("keeps Pi 0.84.1 autocomplete rows visible and outside the tint", async () => {
  const editor = createEditor();
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
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  });

  editor.handleInput("/");
  await waitForAutocomplete(editor);

  const lines = editor.render(14);
  const alphaLine = lines.find((line) =>
    stripTerminalSequences(line).includes("/alpha"),
  );
  assert.ok(alphaLine, "autocomplete row should remain in the output");
  assert.ok(!alphaLine.startsWith(INPUT_BACKGROUND_ANSI));
  assert.equal(lines.at(-1), "");
  assert.ok(lines.every((line) => visibleWidth(line) <= 14));
});

type Handler = (event: any, context: any) => void | Promise<void>;

test("reinstalls after shortcut wiring, hides the footer, and toggles only styled/default", async () => {
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const scheduled: Array<() => void> = [];
  const pi = {
    on(name: string, handler: Handler) {
      events.set(name, handler);
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command);
    },
  };
  const editorFactories: Array<unknown> = [];
  const footerFactories: Array<unknown> = [];
  const context = {
    mode: "tui",
    ui: {
      setEditorComponent(factory: unknown) {
        editorFactories.push(factory);
      },
      setFooter(factory: unknown) {
        footerFactories.push(factory);
      },
    },
  };

  createStyledEditorExtension((callback) => scheduled.push(callback))(
    pi as any,
  );
  await events.get("session_start")?.({}, context);

  assert.equal(editorFactories.length, 1);
  assert.equal(typeof editorFactories[0], "function");
  assert.equal(footerFactories.length, 1);
  assert.deepEqual((footerFactories[0] as Function)().render(80), []);

  // Pi wires extension shortcuts after session_start; the scheduled install must run later.
  scheduled.shift()?.();
  assert.equal(editorFactories.length, 2);
  assert.equal(typeof editorFactories[1], "function");

  const prompt = commands.get("prompt");
  assert.ok(prompt);
  await prompt.handler("", context);
  assert.equal(editorFactories.at(-1), undefined);
  await prompt.handler("", context);
  assert.equal(typeof editorFactories.at(-1), "function");
});
