import assert from "node:assert/strict";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stripTerminalSequences } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const scriptRepository = dirname(dirname(fileURLToPath(import.meta.url)));
const publicManifest = {
  extensions: [
    "./extensions/compact-tools/index.ts",
    "./extensions/permission-gate/index.ts",
    "./extensions/plan-progress/index.ts",
    "./extensions/styled-editor/index.ts",
    "./extensions/jp-workflow/index.ts",
    "./extensions/project-status/index.ts",
    "./extensions/tasks-overlay/index.ts",
  ],
  skills: [
    "./skills/superpowers",
    "./skills/grill-me",
    "./skills/thinking-partner",
    "./skills/handoff",
  ],
  themes: ["./themes/modus-vivendi-tinted.json", "./themes/gold-rush.json"],
};

function packageArgument(argv: string[]): string {
  if (argv.length === 0) return scriptRepository;
  const index = argv.indexOf("--package");
  if (index === -1 || !argv[index + 1] || argv.length !== 2) {
    throw new Error("usage: pi-smoke.ts --package <package-directory>");
  }
  return resolve(argv[index + 1]);
}

function guardedCleanup(path: string) {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(path);
  if (!target.startsWith(`${temporaryRoot}/`)) {
    throw new Error(`refusing unsafe cleanup: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function createFakeBd(root: string) {
  const bin = join(root, "bin");
  const store = join(root, "beads", ".beads");
  const statePath = join(store, "state.json");
  const logPath = join(root, "bd-argv.jsonl");
  mkdirSync(bin, { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        next: 3,
        ready: ["jp-ready"],
        issues: [
          {
            id: "jp-ready",
            title: "Ready release task",
            status: "open",
            labels: ["workstream:public"],
          },
          {
            id: "jp-waiting",
            title: "Waiting dependency task",
            status: "open",
            labels: ["workstream:public"],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const executable = join(bin, "bd");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_BD_LOG, JSON.stringify(args) + "\\n");
const statePath = process.env.FAKE_BD_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const clean = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--db") { index++; continue; }
  if (args[index] === "--json") continue;
  clean.push(args[index]);
}
const command = clean[0];
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
const output = (value) => process.stdout.write(JSON.stringify(value));
if (command === "list") {
  const statusIndex = clean.indexOf("-s");
  const statuses = statusIndex === -1 ? [] : clean[statusIndex + 1].split(",");
  output(state.issues.filter((issue) => statuses.length === 0 || statuses.includes(issue.status)));
} else if (command === "ready") {
  output(state.issues.filter((issue) => state.ready.includes(issue.id) && issue.status === "open"));
} else if (command === "create") {
  if (clean[1] === "MALFORMED") process.stdout.write("not-json");
  else {
    const labelIndex = clean.indexOf("-l");
    const issue = {
      id: "jp-" + state.next++,
      title: clean[1],
      status: "open",
      labels: labelIndex === -1 ? [] : clean[labelIndex + 1].split(","),
    };
    state.issues.push(issue);
    save();
    output(issue);
  }
} else if (command === "update") {
  const issue = state.issues.find((candidate) => candidate.id === clean[1]);
  if (!issue) process.exit(2);
  if (clean.includes("--claim")) issue.status = "in_progress";
  const statusIndex = clean.indexOf("-s");
  if (statusIndex !== -1) issue.status = clean[statusIndex + 1];
  for (let index = 0; index < clean.length; index++) {
    if (clean[index] === "--add-label") issue.labels.push(clean[index + 1]);
    if (clean[index] === "--remove-label") issue.labels = issue.labels.filter((label) => label !== clean[index + 1]);
  }
  save();
  output([issue]);
} else if (command === "close") {
  const issue = state.issues.find((candidate) => candidate.id === clean[1]);
  if (!issue) process.exit(2);
  issue.status = "closed";
  save();
  output([issue]);
} else {
  process.stderr.write("unsupported fake bd command: " + command);
  process.exit(2);
}
`,
  );
  chmodSync(executable, 0o755);
  return { bin, logPath, statePath, store };
}

type RpcRow = Record<string, any>;

type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return false;
}

async function boundedExit(
  exited: Promise<ProcessExit>,
  timeoutMs: number,
  description: string,
): Promise<ProcessExit> {
  return await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`${description} did not exit within ${timeoutMs}ms`),
          ),
        timeoutMs,
      ),
    ),
  ]);
}

export async function terminateProcessGroup(
  child: ChildProcess,
  exited: Promise<ProcessExit>,
  graceMs = 500,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    await boundedExit(exited, graceMs, "process");
    return;
  }

  if (!(await waitForProcessGroupExit(pid, graceMs))) {
    signalProcessGroup(child, "SIGTERM");
  }
  if (!(await waitForProcessGroupExit(pid, graceMs))) {
    signalProcessGroup(child, "SIGKILL");
  }
  await boundedExit(exited, graceMs, `process ${pid}`);
  if (!(await waitForProcessGroupExit(pid, graceMs))) {
    throw new Error(`process group ${pid} survived SIGKILL`);
  }
}

async function runRpc(
  packagePath: string,
  cwd: string,
  agentDirectory: string,
  fakeBd: ReturnType<typeof createFakeBd>,
) {
  const pi = join(scriptRepository, "node_modules", ".bin", "pi");
  const child = spawn(
    pi,
    ["-e", packagePath, "--mode", "rpc", "--no-session", "--offline"],
    {
      cwd,
      env: {
        ...process.env,
        BEADS_DIR: fakeBd.store,
        FAKE_BD_LOG: fakeBd.logPath,
        FAKE_BD_STATE: fakeBd.statePath,
        PATH: `${fakeBd.bin}:${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = new Promise<ProcessExit>((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const rows: RpcRow[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const pending = new Map<
    string,
    { resolve: (row: RpcRow) => void; reject: (error: Error) => void }
  >();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let row: RpcRow;
    try {
      row = JSON.parse(line);
    } catch {
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`Pi emitted non-JSON RPC output: ${line}`));
      }
      return;
    }
    rows.push(row);
    if (row.type === "response" && row.id && pending.has(row.id)) {
      pending.get(row.id)?.resolve(row);
      pending.delete(row.id);
    }
  });

  let nextId = 0;
  const request = (command: Record<string, unknown>) => {
    const id = `smoke-${++nextId}`;
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return new Promise<RpcRow>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(
          new Error(`timed out waiting for ${command.type}; stderr: ${stderr}`),
        );
      }, 15_000);
      pending.set(id, {
        resolve(row) {
          clearTimeout(timer);
          resolveRequest(row);
        },
        reject(error) {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
    });
  };

  try {
    const state = await request({ type: "get_state" });
    const commands = await request({ type: "get_commands" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const entries = await request({ type: "get_entries" });
    const invoked: RpcRow[] = [];
    for (const command of [
      "tasks",
      "plan-view",
      "spec-view",
      "plan-clear",
      "prompt",
    ]) {
      invoked.push(await request({ type: "prompt", message: `/${command}` }));
    }
    return { commands, entries, invoked, rows, state, stderr };
  } finally {
    child.stdin.end();
    try {
      await terminateProcessGroup(child, exited);
    } catch (error) {
      throw new Error(
        `Pi RPC process-group shutdown failed; stderr: ${stderr}`,
        { cause: error },
      );
    }
  }
}

function discoverSkillFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discoverSkillFiles(path);
    return entry.isFile() && entry.name === "SKILL.md" ? [path] : [];
  });
}

function plainTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return `\x1b[48;5;17m${text}\x1b[49m`;
    },
    getBgAnsi(_color: string) {
      return "\x1b[48;5;17m";
    },
    bold(text: string) {
      return text;
    },
  };
}

async function createContractHarness(
  packagePath: string,
  cwd: string,
  fakeBd: ReturnType<typeof createFakeBd>,
) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const entries: any[] = [];
  const documents: string[] = [];
  const notifications: string[] = [];
  const widgets = new Map<string, any>();
  let editorFactory: Function | undefined;
  let footerFactory: Function | undefined;
  const execCalls: string[][] = [];
  const theme = plainTheme();
  const duplicate = (kind: string, name: string) => {
    throw new Error(`duplicate ${kind}: ${name}`);
  };
  const pi = {
    registerTool(tool: any) {
      if (tools.has(tool.name)) duplicate("tool", tool.name);
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      if (commands.has(name)) duplicate("command", name);
      commands.set(name, command);
    },
    registerShortcut(key: string, shortcut: any) {
      if (shortcuts.has(key)) duplicate("shortcut", key);
      shortcuts.set(key, shortcut);
    },
    registerEntryRenderer() {},
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage() {},
    async exec(command: string, args: string[]) {
      execCalls.push([command, ...args]);
      try {
        const result = await execFileAsync(command, args, {
          cwd,
          env: {
            ...process.env,
            BEADS_DIR: fakeBd.store,
            FAKE_BD_LOG: fakeBd.logPath,
            FAKE_BD_STATE: fakeBd.statePath,
            PATH: `${fakeBd.bin}:${process.env.PATH ?? ""}`,
          },
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error: any) {
        return {
          code: error.code ?? 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
        };
      }
    },
    getSessionName() {
      return undefined;
    },
    getThinkingLevel() {
      return "off";
    },
  };
  const context = {
    hasUI: true,
    mode: "tui",
    model: undefined,
    getContextUsage() {
      return undefined;
    },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => [],
      getSessionName: () => pi.getSessionName(),
    },
    ui: {
      theme,
      setWidget(key: string, value: unknown) {
        widgets.set(key, value);
      },
      notify(message: string) {
        notifications.push(message);
      },
      async custom(factory: Function, options?: any) {
        options?.onHandle?.({ hide() {} });
        const component = factory(
          { requestRender() {}, terminal: { rows: 24 } },
          theme,
          { matches: () => false },
          () => {},
        );
        documents.push(component.render(100).join("\n"));
      },
      setEditorComponent(factory: Function | undefined) {
        editorFactory = factory;
      },
      setFooter(factory: Function) {
        footerFactory = factory;
      },
    },
  };

  const manifest = JSON.parse(
    readFileSync(join(packagePath, "package.json"), "utf8"),
  );
  assert.deepEqual(manifest.pi, publicManifest);
  const previousBeadsDirectory = process.env.BEADS_DIR;
  process.env.BEADS_DIR = fakeBd.store;
  try {
    for (const extension of manifest.pi.extensions) {
      const entrypoint = resolve(packagePath, extension);
      const module = await import(pathToFileURL(entrypoint).href);
      module.default(pi as any);
    }
  } finally {
    if (previousBeadsDirectory === undefined) delete process.env.BEADS_DIR;
    else process.env.BEADS_DIR = previousBeadsDirectory;
  }
  return {
    commands,
    context,
    documents,
    entries,
    execCalls,
    footer: () => footerFactory,
    handlers,
    notifications,
    pi,
    shortcuts,
    styledEditor: () => editorFactory,
    tools,
    widgets,
  };
}

function render(component: { render(width: number): string[] }): string {
  return component.render(100).join("\n");
}

async function invokeTool(
  harness: Awaited<ReturnType<typeof createContractHarness>>,
  name: string,
  params: unknown,
) {
  const tool = harness.tools.get(name);
  assert.ok(tool, `${name} registered`);
  return tool.execute(
    "smoke-call",
    params,
    new AbortController().signal,
    undefined,
    harness.context,
  );
}

async function verifyContractHarness(
  packagePath: string,
  cwd: string,
  fakeBd: ReturnType<typeof createFakeBd>,
) {
  const harness = await createContractHarness(packagePath, cwd, fakeBd);

  const filed = await invokeTool(harness, "file_issue", {
    title: "Release fixture",
    why: "Exercise package behavior",
    workstream: "public",
  });
  const created = JSON.parse(filed.content[0].text);
  assert.equal(created.status, "open");
  const updated = await invokeTool(harness, "update_issue", {
    id: created.id,
    status: "in_progress",
    add_labels: ["verified"],
  });
  assert.equal(JSON.parse(updated.content[0].text)[0].status, "in_progress");
  const closed = await invokeTool(harness, "close_issue", {
    id: created.id,
    reason: "Smoke verified",
  });
  assert.equal(JSON.parse(closed.content[0].text)[0].status, "closed");
  assert.ok(
    harness.execCalls.every(
      (call) =>
        call[0] === "bd" &&
        call.includes("--json") &&
        call.includes("--db") &&
        call.includes(fakeBd.store),
    ),
  );
  await assert.rejects(
    invokeTool(harness, "file_issue", {
      title: "MALFORMED",
      why: "Exercise contextual decoding error",
    }),
    (error: Error) => {
      assert.match(error.message, /create issue/);
      assert.match(error.message, /bd returned malformed JSON/);
      assert.match(
        error.message,
        new RegExp(fakeBd.store.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      return true;
    },
  );

  await invokeTool(harness, "set_plan", {
    steps: ["First smoke step", "Second smoke step"],
    markdown: "Smoke plan\n\nPlan body",
  });
  await invokeTool(harness, "complete_step", { step: 1 });
  await invokeTool(harness, "set_spec", {
    markdown: "Smoke spec\n\nSpec body",
  });
  await harness.commands.get("plan-view").handler("", harness.context);
  await harness.commands.get("spec-view").handler("", harness.context);
  assert.match(harness.documents[0], /Smoke plan/);
  assert.match(harness.documents[1], /Smoke spec/);
  assert.match(harness.widgets.get("plan-progress").join("\n"), /1\/2/);

  const bash = harness.tools.get("bash");
  const result = await bash.execute(
    "compact-smoke",
    { command: "printf compact-smoke" },
    new AbortController().signal,
    undefined,
    { cwd },
  );
  const successRender = render(
    bash.renderResult(result, { expanded: true }, plainTheme(), {
      isError: false,
    }),
  );
  const errorRender = render(
    bash.renderResult(
      { content: [{ type: "text", text: "compact-error" }] },
      { expanded: false },
      plainTheme(),
      { isError: true },
    ),
  );
  assert.match(successRender, /compact-smoke/);
  assert.match(errorRender, /compact-error/);

  for (const handler of harness.handlers.get("session_start") ?? []) {
    await handler({ reason: "startup" }, harness.context);
  }
  await harness.commands.get("tasks").handler("", harness.context);
  assert.match(harness.documents.at(-1) ?? "", /Ready release task/);
  const statusWidget = harness.widgets.get("project-status");
  assert.equal(typeof statusWidget, "function");
  assert.match(render(statusWidget()), /1 ready.*1 waiting/);

  const editorFactory = harness.styledEditor();
  assert.ok(editorFactory);
  const editor = editorFactory(
    { terminal: { rows: 24 }, requestRender() {} },
    {
      borderColor: (text: string) => text,
      selectList: {
        selectedPrefix: (text: string) => text,
        selectedText: (text: string) => text,
        description: (text: string) => text,
        scrollInfo: (text: string) => text,
        noMatch: (text: string) => text,
      },
    },
    { matches: () => false },
  );
  editor.setText("styled smoke");
  editor.handleInput("\u001b[D");
  const editorLines = editor.render(40);
  assert.ok(
    editorLines.some((line: string) =>
      stripTerminalSequences(line).includes("styled smoke"),
    ),
  );
  assert.ok(
    editorLines
      .slice(0, -1)
      .every((line: string) => line.includes("\u001b[48;5;17m")),
  );
  assert.ok(
    editorLines
      .slice(0, -1)
      .every((line: string) => stripTerminalSequences(line).startsWith("█ ")),
  );
  assert.ok(
    editorLines
      .slice(0, -1)
      .every((line: string) => !stripTerminalSequences(line).includes("─")),
  );
  assert.equal(editorLines.at(-1), "");
  assert.deepEqual(harness.footer()?.().render(80), []);
}

async function main() {
  const packagePath = packageArgument(process.argv.slice(2));
  const manifest = JSON.parse(
    readFileSync(join(packagePath, "package.json"), "utf8"),
  );
  assert.deepEqual(manifest.pi, publicManifest);

  const root = mkdtempSync(join(tmpdir(), "pi-package-smoke-"));
  try {
    const workspace = join(root, "workspace");
    const agentDirectory = join(root, "agent");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(agentDirectory, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    const fakeBd = createFakeBd(root);

    const rpc = await runRpc(packagePath, workspace, agentDirectory, fakeBd);
    for (const response of [
      rpc.state,
      rpc.commands,
      rpc.entries,
      ...rpc.invoked,
    ]) {
      assert.equal(response.type, "response");
      assert.equal(response.success, true, response.error);
    }
    assert.ok(!rpc.rows.some((row) => row.type === "extension_error"));
    const registered = rpc.commands.data.commands;
    const commandNames = registered.map((command: any) => command.name);
    assert.equal(new Set(commandNames).size, commandNames.length);
    for (const command of [
      "tasks",
      "plan-view",
      "spec-view",
      "plan-clear",
      "prompt",
    ]) {
      assert.ok(commandNames.includes(command), `${command} loaded in real Pi`);
    }
    const loadedPackagePaths = new Set<string>(
      registered
        .filter((command: any) => command.sourceInfo?.source === "cli")
        .map((command: any) => resolve(command.sourceInfo.path)),
    );
    const allowedPackagePaths = new Set<string>([
      ...publicManifest.extensions.map((path) => resolve(packagePath, path)),
      ...publicManifest.skills.flatMap((path) =>
        discoverSkillFiles(resolve(packagePath, path)),
      ),
    ]);
    for (const path of loadedPackagePaths) {
      assert.ok(
        allowedPackagePaths.has(path),
        `unexpected loaded resource: ${path}`,
      );
    }
    for (const skill of [...allowedPackagePaths].filter((path) =>
      path.endsWith("SKILL.md"),
    )) {
      assert.ok(
        loadedPackagePaths.has(skill),
        `skill was not loaded: ${skill}`,
      );
    }
    const startup = rpc.entries.data.entries.find(
      (entry: any) => entry.customType === "jp-work-startup",
    );
    assert.ok(startup, "startup task state was appended");
    const readiness = startup.data.state.active.map(
      (issue: any) => issue.readiness,
    );
    assert.deepEqual(readiness.sort(), ["ready", "waiting"]);

    await verifyContractHarness(packagePath, workspace, fakeBd);
    console.log(
      `Pi package smoke verified (${publicManifest.extensions.length} extensions, ${publicManifest.skills.length} skill roots, ${publicManifest.themes.length} themes)`,
    );
  } finally {
    guardedCleanup(root);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
