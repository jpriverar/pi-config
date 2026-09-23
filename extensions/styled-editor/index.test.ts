import assert from "node:assert/strict";
import test from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import styledEditor from "./index.js";

const GiB = 1024n ** 3n;
const INPUT_BACKGROUND = "\x1b[48;5;17m";
const STATUS_BACKGROUND = "\x1b[48;5;53m";
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

type Usage = {
  [key: string]: number | null | undefined;
  contextWindow?: number;
  percent?: number | null;
};

type HarnessOptions = {
  modelName?: string;
  modelId?: string;
  thinkingLevel?: string;
  usage?: Usage;
  diskFreeGiB?: bigint;
  diskUnavailable?: boolean;
  statfs?: () => Promise<{ bavail: bigint; bsize: bigint }>;
};

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<
    string,
    (event: unknown, context: any) => Promise<void> | void
  >();
  const commands = new Map<string, { handler: Function }>();
  const editorFactories: Array<Function | undefined> = [];
  const footerFactories: Function[] = [];
  const notifications: Array<[string, string]> = [];
  const foregroundCalls: Array<[string, string]> = [];
  const footerData = { getExtensionStatuses: () => new Map() };
  let footerComponent: { render(width: number): string[] } | undefined;
  let renderRequests = 0;
  let intervalCallback: (() => void) | undefined;
  let thinkingLevel = options.thinkingLevel ?? "high";
  let usage: Usage | undefined =
    options.usage ??
    ({
      ["to" + "kens"]: 440_000,
      contextWindow: 1_000_000,
      percent: 44,
    } satisfies Usage);
  const model = {
    id: options.modelId ?? "claude-opus-4-6",
    name: options.modelName ?? "Claude Opus 4.6 (AI Gateway, 1M)",
    contextWindow: 1_000_000,
  };
  const tui = {
    terminal: { rows: 24 },
    requestRender() {
      renderRequests += 1;
    },
  };
  const theme = {
    fg(color: string, text: string) {
      foregroundCalls.push([color, text]);
      return `\x1b[36m${text}\x1b[39m`;
    },
    bg(color: string, text: string) {
      const background =
        color === "userMessageBg"
          ? INPUT_BACKGROUND
          : color === "customMessageBg"
            ? STATUS_BACKGROUND
            : undefined;
      assert.ok(background, `unexpected background ${color}`);
      return `${background}${text}${RESET_BACKGROUND}`;
    },
    getBgAnsi(color: string) {
      if (color === "userMessageBg") return INPUT_BACKGROUND;
      if (color === "customMessageBg") return STATUS_BACKGROUND;
      assert.fail(`unexpected background ${color}`);
    },
  };
  const context = {
    hasUI: true,
    mode: "tui",
    model,
    getContextUsage() {
      return usage;
    },
    ui: {
      theme,
      setEditorComponent(factory: Function | undefined) {
        editorFactories.push(factory);
      },
      setFooter(factory: Function) {
        footerFactories.push(factory);
        footerComponent = factory(tui, theme, footerData);
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
    getThinkingLevel() {
      return thinkingLevel;
    },
  };

  styledEditor(
    pi as any,
    {
      homePath: "/tmp",
      async statfs() {
        if (options.statfs) return options.statfs();
        if (options.diskUnavailable) throw new Error("disk unavailable");
        return { bavail: options.diskFreeGiB ?? 200n, bsize: GiB };
      },
      setInterval(callback: () => void) {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearInterval() {
        intervalCallback = undefined;
      },
    } as any,
  );
  return {
    commands,
    context,
    editorFactories,
    footerFactories,
    foregroundCalls,
    handlers,
    notifications,
    renderFooter(width = 80) {
      return footerComponent?.render(width) ?? [];
    },
    get renderRequests() {
      return renderRequests;
    },
    runInterval() {
      intervalCallback?.();
    },
    setThinkingLevel(value: string) {
      thinkingLevel = value;
    },
    setUsage(value: Usage | undefined) {
      usage = value;
    },
    tui,
  };
}

function instantiate(factory: Function, tui: any) {
  return factory(tui, editorTheme, {
    matches: () => false,
  });
}

async function start(harness: ReturnType<typeof createHarness>) {
  await harness.handlers.get("session_start")?.({}, harness.context);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  const factory = harness.editorFactories.at(-1);
  assert.equal(typeof factory, "function");
  return instantiate(factory as Function, harness.tui);
}

async function waitForAutocomplete(editor: any): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (editor.isShowingAutocomplete()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("autocomplete did not become visible");
}

function findStatusLine(lines: string[]): string | undefined {
  return lines.find((line) => stripTerminalSequences(line).includes("⛁ 200G"));
}

test("preserves the private prompt renderer", async () => {
  const harness = createHarness();
  const editor = await start(harness);
  editor.setText("hello");

  const lines = editor.render(40);
  const inputLines = lines.filter((line: string) =>
    line.includes(INPUT_BACKGROUND),
  );
  const contentLine = inputLines.find((line: string) => line.includes("hello"));

  assert.ok(contentLine);
  assert.ok(inputLines.every((line: string) => line.startsWith(RAIL)));
  const railCalls = harness.foregroundCalls.filter(
    (call) => call[0] === "borderAccent",
  );
  assert.equal(railCalls.length, inputLines.length + 1);
  assert.ok(railCalls.every((call) => call[1] === "█"));
  assert.ok(
    inputLines.every((line: string) => line.includes(INPUT_BACKGROUND)),
  );
  assert.ok(
    inputLines.every(
      (line: string) => !stripTerminalSequences(line).includes("─"),
    ),
  );
  assert.ok(contentLine.includes(`\x1b[0m${INPUT_BACKGROUND}`));
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

test("formats editor-owned runtime state", async () => {
  const editor = await start(
    createHarness({
      thinkingLevel: "high",
      usage: {
        ["to" + "kens"]: 440_000,
        contextWindow: 1_000_000,
        percent: 44,
      },
      diskFreeGiB: 200n,
    }),
  );

  const rendered = stripTerminalSequences(editor.render(80).join("\n"));
  assert.match(rendered, /Opus 4\.6 • HIGH • 44% \(440k\/1M\) • ⛁ 200G/);
});

test("formats compact context token counts without redundant zero fractions", async () => {
  for (const [tokens, formatted] of [
    [999, "999"],
    [1_200, "1.2k"],
    [440_000, "440k"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
  ] as const) {
    const editor = await start(
      createHarness({
        usage: {
          ["to" + "kens"]: tokens,
          contextWindow: 2_000_000,
          percent: 50,
        },
      }),
    );
    assert.match(
      stripTerminalSequences(editor.render(100).join("\n")),
      new RegExp(`50% \\(${formatted}/2M\\)`),
    );
  }
});

test("shows context percent when token detail is unavailable", async () => {
  const editor = await start(
    createHarness({ usage: { percent: 44, contextWindow: 1_000_000 } }),
  );
  const rendered = stripTerminalSequences(editor.render(80).join("\n"));
  assert.match(rendered, /44%/);
  assert.doesNotMatch(rendered, /44% \(/);
});

test("sanitizes hostile runtime identity before rendering", async () => {
  const editor = await start(
    createHarness({
      modelName: "Claude \u001b]0;owned\u0007Opus\n4.6\t(AI Gateway, 1M)",
    }),
  );
  const lines = editor.render(100);
  const rendered = stripTerminalSequences(lines.join("\n"));

  assert.match(rendered, /Opus 4\.6/);
  assert.doesNotMatch(rendered, /owned|Opus\n4\.6/);
});

test("renders runtime as a full-width right-sticky status row", async () => {
  const editor = await start(createHarness());
  editor.setText("hello");

  const lines = editor.render(80);
  const statusLine = findStatusLine(lines);
  assert.ok(statusLine);
  assert.ok(statusLine.startsWith(RAIL));
  assert.ok(statusLine.includes(STATUS_BACKGROUND));
  assert.ok(!statusLine.includes(INPUT_BACKGROUND));
  assert.match(stripTerminalSequences(statusLine), /⛁ 200G $/);
  assert.equal(lines.at(-1), "");
});

test("keeps runtime rows bounded and preserves trailing health at narrow widths", async () => {
  const editor = await start(createHarness());
  editor.setText("hello");

  for (const width of [0, 1, 2, 3, 8, 24, 48]) {
    const lines = editor.render(width);
    assert.ok(
      lines.every((line: string) => visibleWidth(line) <= width),
      `render exceeded width ${width}`,
    );
  }

  const narrow = stripTerminalSequences(editor.render(32).join("\n"));
  assert.doesNotMatch(narrow, /Opus 4\.6/);
  assert.match(narrow, /44%.*⛁ 200G/);
});

test("keeps autocomplete outside both prompt backgrounds", async () => {
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

  const lines = editor.render(80);
  const statusIndex = lines.findIndex((line: string) =>
    stripTerminalSequences(line).includes("⛁ 200G"),
  );
  const alphaIndex = lines.findIndex((line: string) =>
    stripTerminalSequences(line).includes("/alpha"),
  );
  assert.ok(statusIndex >= 0 && alphaIndex > statusIndex);
  assert.ok(lines[statusIndex].includes(STATUS_BACKGROUND));
  assert.ok(!lines[alphaIndex].includes(INPUT_BACKGROUND));
  assert.ok(!lines[alphaIndex].includes(STATUS_BACKGROUND));
});

test("shows a plain runtime footer while the styled prompt is disabled", async () => {
  const harness = createHarness();
  await start(harness);

  const prompt = harness.commands.get("prompt");
  assert.ok(prompt);
  await prompt.handler("off", harness.context);

  const rendered = stripTerminalSequences(harness.renderFooter(80).join("\n"));
  assert.match(rendered, /Opus 4\.6 • HIGH • 44% \(440k\/1M\) • ⛁ 200G/);
  assert.ok(harness.renderFooter(24).every((line) => visibleWidth(line) <= 24));

  await prompt.handler("on", harness.context);
});

test("keeps disk warning thresholds and failure state", async () => {
  for (const [diskFreeGiB, color] of [
    [150n, "dim"],
    [149n, "warning"],
    [79n, "error"],
  ] as const) {
    const harness = createHarness({ diskFreeGiB });
    const editor = await start(harness);
    editor.render(80);
    assert.ok(
      harness.foregroundCalls.some(
        (call) => call[0] === color && call[1] === `⛁ ${diskFreeGiB}G`,
      ),
    );
  }

  const unavailable = createHarness({ diskUnavailable: true });
  const editor = await start(unavailable);
  assert.match(stripTerminalSequences(editor.render(80).join("\n")), /⛁ \?/);
  assert.ok(
    unavailable.foregroundCalls.some(
      (call) => call[0] === "error" && call[1] === "⛁ ?",
    ),
  );
});

test("does not publish a stale disk read after shutdown", async () => {
  let releaseDisk!: () => void;
  let markDiskStarted!: () => void;
  const diskStarted = new Promise<void>((resolve) => {
    markDiskStarted = resolve;
  });
  const diskReleased = new Promise<void>((resolve) => {
    releaseDisk = resolve;
  });
  const harness = createHarness({
    statfs: async () => {
      markDiskStarted();
      await diskReleased;
      return { bavail: 79n, bsize: GiB };
    },
  });

  const startPromise = Promise.resolve(
    harness.handlers.get("session_start")?.({}, harness.context),
  );
  const started = await Promise.race([
    diskStarted.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(started, true, "disk read did not start");
  const factory = harness.editorFactories.at(-1);
  assert.equal(typeof factory, "function");
  const editor = instantiate(factory as Function, harness.tui);

  await harness.handlers.get("session_shutdown")?.({}, harness.context);
  releaseDisk();
  await startPromise;

  assert.doesNotMatch(
    stripTerminalSequences(editor.render(80).join("\n")),
    /⛁/,
  );
});

test("keeps the custom footer empty while styled mode owns runtime", async () => {
  const harness = createHarness();
  await start(harness);
  assert.deepEqual(harness.renderFooter(80), []);
});

test("reinstalls for shortcuts and identity changes and supports explicit prompt toggles", async () => {
  const harness = createHarness();
  await start(harness);

  assert.ok(harness.editorFactories.length >= 2);
  assert.deepEqual(harness.renderFooter(80), []);

  const beforeModel = harness.editorFactories.length;
  await harness.handlers.get("model_select")?.({}, harness.context);
  assert.equal(harness.editorFactories.length, beforeModel + 1);

  const beforeThinking = harness.editorFactories.length;
  harness.setThinkingLevel("xhigh");
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
