import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";

import { createCompactTools } from "./index.js";

type Theme = {
  fg: (color: string, text: string) => string;
};

type RegisteredTool = {
  name: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
  renderCall: (
    args: any,
    theme: Theme,
  ) => { render: (width: number) => string[] };
  renderResult: (
    result: any,
    options: any,
    theme: Theme,
    context: any,
  ) => { render: (width: number) => string[] };
};

const names = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
const theme: Theme = {
  fg: (_color: string, text: string) => text,
};

function createHarness() {
  const factoryCalls: Array<{ name: string; cwd: string }> = [];
  const executeCalls: Array<{ name: string; cwd: string; args: any[] }> = [];
  const results = Object.fromEntries(
    names.map((name) => [
      name,
      { content: [{ type: "text", text: `${name} result` }] },
    ]),
  );
  const factories = Object.fromEntries(
    names.map((name) => [
      name,
      (cwd: string) => {
        factoryCalls.push({ name, cwd });
        return {
          parameters: { marker: name },
          async execute(...args: any[]) {
            executeCalls.push({ name, cwd, args });
            return results[name];
          },
        };
      },
    ]),
  );
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  };

  createCompactTools(factories as any)(pi as any);
  return { executeCalls, factoryCalls, results, tools };
}

function render(component: { render: (width: number) => string[] }): string {
  return component
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

test("registers the exact built-in tool set through the supplied factories", () => {
  const harness = createHarness();

  assert.deepEqual([...harness.tools.keys()], names);
  for (const name of names) {
    assert.deepEqual(harness.tools.get(name)?.parameters, { marker: name });
  }
  assert.deepEqual(
    harness.factoryCalls,
    names.map((name) => ({ name, cwd: process.cwd() })),
  );
});

test("delegates every execution argument unchanged and returns the built-in result", async () => {
  const harness = createHarness();
  const signal = new AbortController().signal;
  const onUpdate = () => undefined;

  for (const name of names) {
    const params = { marker: name };
    const result = await harness.tools
      .get(name)
      ?.execute("call-id", params, signal, onUpdate, { cwd: "/tmp/other" });
    assert.equal(result, harness.results[name]);
    assert.deepEqual(harness.executeCalls.at(-1), {
      name,
      cwd: "/tmp/other",
      args: ["call-id", params, signal, onUpdate],
    });
  }

  assert.equal(
    harness.factoryCalls.filter(({ cwd }) => cwd === "/tmp/other").length,
    names.length,
  );
});

test("renders compact one-line call summaries with home abbreviation and truncation", () => {
  const { tools } = createHarness();
  const summaries = {
    read: render(
      tools
        .get("read")!
        .renderCall(
          { path: `${homedir()}/notes/file.ts`, offset: 2, limit: 3 },
          theme,
        ),
    ),
    grep: render(
      tools
        .get("grep")!
        .renderCall({ pattern: "needle", path: `${homedir()}/src` }, theme),
    ),
    find: render(
      tools.get("find")!.renderCall({ pattern: "*.ts", path: "/tmp" }, theme),
    ),
    ls: render(tools.get("ls")!.renderCall({ path: "/tmp" }, theme)),
    bash: render(
      tools.get("bash")!.renderCall({ command: "x".repeat(81) }, theme),
    ),
    edit: render(
      tools
        .get("edit")!
        .renderCall({ path: `${homedir()}/file.ts`, edits: [{}, {}] }, theme),
    ),
    write: render(
      tools
        .get("write")!
        .renderCall(
          { path: `${homedir()}/file.ts`, content: "one\ntwo" },
          theme,
        ),
    ),
  };

  assert.deepEqual(summaries, {
    read: "read ~/notes/file.ts:2-4",
    grep: "grep needle ~/src",
    find: "find *.ts /tmp",
    ls: "ls /tmp",
    bash: `$ ${"x".repeat(77)}...`,
    edit: "edit ~/file.ts (2 edits)",
    write: "write ~/file.ts (2 lines)",
  });
  for (const summary of Object.values(summaries)) {
    assert.doesNotMatch(summary, /\n/);
  }
});

test("normalizes CR and LF in every user-controlled call summary field", () => {
  const { tools } = createHarness();
  const summaries = [
    render(
      tools.get("read")!.renderCall({ path: "/tmp/read\r\npath.ts" }, theme),
    ),
    render(
      tools
        .get("grep")!
        .renderCall(
          { pattern: "first\r\nsecond", path: "/tmp/grep\npath" },
          theme,
        ),
    ),
    render(
      tools
        .get("find")!
        .renderCall(
          { pattern: "*.ts\r\n*.tsx", path: "/tmp/find\rpath" },
          theme,
        ),
    ),
    render(tools.get("ls")!.renderCall({ path: "/tmp/ls\npath" }, theme)),
    render(
      tools
        .get("bash")!
        .renderCall({ command: "printf first\r\nprintf second" }, theme),
    ),
    render(
      tools
        .get("edit")!
        .renderCall({ path: "/tmp/edit\r\npath", edits: [{}] }, theme),
    ),
    render(
      tools
        .get("write")!
        .renderCall({ path: "/tmp/write\npath", content: "content" }, theme),
    ),
  ];

  assert.deepEqual(summaries, [
    "read /tmp/read path.ts",
    "grep first second /tmp/grep path",
    "find *.ts *.tsx /tmp/find path",
    "ls /tmp/ls path",
    "$ printf first printf second",
    "edit /tmp/edit path",
    "write /tmp/write path (1 lines)",
  ]);
  for (const summary of summaries) assert.doesNotMatch(summary, /[\r\n]/);
});

test("abbreviates only the home directory and its descendants", () => {
  const { tools } = createHarness();
  const ls = tools.get("ls")!;

  assert.equal(render(ls.renderCall({ path: homedir() }, theme)), "ls ~");
  assert.equal(
    render(ls.renderCall({ path: `${homedir()}-old/file` }, theme)),
    `ls ${homedir()}-old/file`,
  );
});

test("hides ordinary results but renders errors even when collapsed", () => {
  const { tools } = createHarness();
  const success = { content: [{ type: "text", text: "ordinary output" }] };
  const failure = { content: [{ type: "text", text: "failed safely" }] };

  for (const name of names) {
    const tool = tools.get(name)!;
    assert.equal(
      render(
        tool.renderResult(success, { expanded: false }, theme, {
          isError: false,
        }),
      ),
      "",
      name,
    );
    assert.match(
      render(
        tool.renderResult(failure, { expanded: false }, theme, {
          isError: true,
        }),
      ),
      /failed safely/,
      name,
    );
  }
});
