import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(repository, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const publicResources = {
  extensions: [
    "./extensions/compact-tools/index.ts",
    "./extensions/permission-gate/index.ts",
    "./extensions/plan-progress/index.ts",
    "./extensions/styled-editor/index.ts",
    "./extensions/herdr-ask-user-bridge/index.ts",
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

async function discoverSkillFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await discoverSkillFiles(child)));
    else if (entry.isFile() && entry.name === "SKILL.md") files.push(child);
  }
  return files;
}

function createPiHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Function[]>();
  const entryRenderers = new Map<string, Function>();
  const duplicate = (kind: string, name: string) => {
    throw new Error(`duplicate ${kind} registration: ${name}`);
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
    registerEntryRenderer(name: string, renderer: Function) {
      if (entryRenderers.has(name)) duplicate("entry renderer", name);
      entryRenderers.set(name, renderer);
    },
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: Function) {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
      },
      emit(name: string, payload: unknown) {
        for (const handler of eventHandlers.get(name) ?? []) handler(payload);
      },
    },
    appendEntry() {},
    sendMessage() {},
    async exec() {
      return { code: 0, stdout: "[]", stderr: "" };
    },
    getSessionName() {
      return undefined;
    },
    getThinkingLevel() {
      return "off";
    },
  };
  return { commands, entryRenderers, handlers, pi, shortcuts, tools };
}

test("resolves every explicit manifest resource", async () => {
  assert.deepEqual(manifest.pi, publicResources);

  for (const type of Object.keys(publicResources) as Array<
    keyof typeof publicResources
  >) {
    for (const resource of publicResources[type]) {
      assert.ok(
        existsSync(resolve(repository, resource)),
        `${resource} exists`,
      );
    }
  }

  const skillFiles = (
    await Promise.all(
      publicResources.skills.map((skill) =>
        discoverSkillFiles(resolve(repository, skill)),
      ),
    )
  ).flat();
  assert.ok(skillFiles.length > publicResources.skills.length);
  for (const skill of publicResources.skills) {
    assert.ok(
      skillFiles.some((file) => file.startsWith(resolve(repository, skill))),
      `${skill} exposes a SKILL.md`,
    );
  }

  const themeNames = await Promise.all(
    publicResources.themes.map(async (themePath) => {
      const theme = JSON.parse(
        await readFile(resolve(repository, themePath), "utf8"),
      );
      return theme.name;
    }),
  );
  assert.deepEqual(themeNames, ["modus-vivendi-tinted", "gold-rush"]);
});

test("imports and registers every manifest extension without collisions", async () => {
  const harness = createPiHarness();
  for (const extension of publicResources.extensions) {
    const module = await import(
      pathToFileURL(resolve(repository, extension)).href
    );
    assert.equal(typeof module.default, "function", extension);
    assert.doesNotThrow(() => module.default(harness.pi as any), extension);
  }

  assert.deepEqual([...harness.tools.keys()].sort(), [
    "bash",
    "close_issue",
    "complete_step",
    "edit",
    "file_issue",
    "find",
    "grep",
    "ls",
    "read",
    "set_plan",
    "set_spec",
    "update_issue",
    "write",
  ]);
  for (const command of [
    "plan-clear",
    "plan-view",
    "spec-view",
    "prompt",
    "tasks",
  ]) {
    assert.ok(harness.commands.has(command), `${command} is registered`);
  }
  for (const shortcut of ["ctrl+alt+p", "ctrl+alt+s", "ctrl+alt+t"]) {
    assert.ok(harness.shortcuts.has(shortcut), `${shortcut} is registered`);
  }
  assert.ok(harness.entryRenderers.has("jp-work-startup"));
  assert.ok(harness.handlers.has("session_compact"));
  assert.ok(harness.handlers.has("session_info_changed"));
  assert.ok(harness.handlers.has("turn_end"));
});
