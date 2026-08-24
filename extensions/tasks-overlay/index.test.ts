import assert from "node:assert/strict";
import test from "node:test";

import type { BeadsExecResult, BeadsIssue } from "../../lib/beads.js";
import tasksOverlay from "./index.js";

process.env.BEADS_DIR = "/tmp/personal/.beads";

type Query = "active" | "ready" | "all" | "update";

type Handler = (event: any, context: any) => Promise<void> | void;
type RegisteredAction = {
  description: string;
  handler: (...args: any[]) => Promise<void>;
};

type Entry = {
  type: "custom";
  customType: string;
  data: unknown;
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
    sessionId?: string;
    entries?: readonly Entry[];
    unavailable?: Query;
    updateMutates?: boolean;
    updateExitCode?: number;
    afterUpdate?: (issue: BeadsIssue) => void;
    registryValue?: string;
    registryGetResults?: BeadsExecResult[];
    registrySetResult?: BeadsExecResult;
    registrySetMutates?: boolean;
    select?: (items: string[]) => string | undefined;
    input?: (title: string, placeholder?: string) => string | undefined;
    confirm?: (title: string, message: string) => boolean;
  } = {},
) {
  const commands = new Map<string, RegisteredAction>();
  const shortcuts = new Map<string, RegisteredAction>();
  const handlers = new Map<string, Handler>();
  const notifications: Array<{ message: string; type: string }> = [];
  const calls: string[][] = [];
  const renamedSessions: string[] = [];
  const appendedEntries: Entry[] = [];
  const entries = [...(options.entries ?? [])];
  const selections: Array<{ title: string; items: string[] }> = [];
  const inputs: Array<{ title: string; placeholder?: string }> = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  let rendered = "";
  let sessionName =
    options.sessionName === null
      ? undefined
      : (options.sessionName ?? "pi-setup");
  const issues = (options.issues ?? []).map((item) => ({
    ...item,
    labels: [...item.labels],
  }));
  const readyIds = new Set(options.readyIds ?? []);
  const registryGetResults = [...(options.registryGetResults ?? [])];
  let registryValue = options.registryValue ?? "";

  const pi = {
    async exec(_command: string, args: string[]) {
      calls.push(args);
      if (args[0] === "config" && args[1] === "get") {
        const queued = registryGetResults.shift();
        if (queued) return queued;
        return {
          code: 0,
          stdout: JSON.stringify({
            key: "custom.pi-project-renames",
            schema_version: 1,
            value: registryValue,
          }),
          stderr: "",
        };
      }
      if (args[0] === "config" && args[1] === "set") {
        const result = options.registrySetResult ?? {
          code: 0,
          stdout: "",
          stderr: "",
        };
        if (
          result.code === 0 &&
          options.registrySetMutates !== false &&
          args[3] !== undefined
        ) {
          registryValue = args[3];
        }
        return result;
      }
      if (args[0] === "update") {
        if (options.updateMutates !== false) {
          const ids: string[] = [];
          let index = 1;
          while (index < args.length && !args[index].startsWith("--")) {
            ids.push(args[index]);
            index += 1;
          }

          const removeLabels: string[] = [];
          const addLabels: string[] = [];
          while (index < args.length) {
            const flag = args[index];
            const value = args[index + 1];
            if (flag === "--remove-label" && value !== undefined) {
              removeLabels.push(value);
              index += 2;
              continue;
            }
            if (flag === "--add-label" && value !== undefined) {
              addLabels.push(value);
              index += 2;
              continue;
            }
            index += flag === "--db" ? 2 : 1;
          }

          for (const task of issues) {
            if (!ids.includes(task.id)) continue;
            task.labels = task.labels.filter(
              (label) => !removeLabels.includes(label),
            );
            for (const label of addLabels) {
              if (!task.labels.includes(label)) task.labels.push(label);
            }
            options.afterUpdate?.(task);
          }
        }
        const code =
          options.unavailable === "update" ? 1 : (options.updateExitCode ?? 0);
        return {
          code,
          stdout: "",
          stderr: code === 0 ? "" : "private failure",
        };
      }

      const query: Query =
        args[0] === "ready"
          ? "ready"
          : args.includes("open,in_progress,blocked,deferred,closed")
            ? "all"
            : "active";
      if (options.unavailable === query) {
        return { code: 1, stdout: "", stderr: "private failure" };
      }
      const statusIndex = args.indexOf("-s");
      const activeStatuses = new Set(
        statusIndex === -1 ? [] : args[statusIndex + 1].split(","),
      );
      const selected =
        query === "ready"
          ? issues.filter((item) => readyIds.has(item.id))
          : issues.filter((item) => activeStatuses.has(item.status));
      return {
        code: 0,
        stdout: JSON.stringify(selected.map(rawIssue)),
        stderr: "",
      };
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(name: string) {
      renamedSessions.push(name);
      sessionName = name || undefined;
    },
    appendEntry(customType: string, data: unknown) {
      const entry: Entry = { type: "custom", customType, data };
      appendedEntries.push(entry);
      entries.push(entry);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
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
    sessionManager: {
      getEntries: () => entries,
      getSessionName: () => sessionName,
      getSessionId: () =>
        options.sessionId ?? "019ff29e-4652-7c2d-90c5-bdf1580c8e67",
    },
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      async custom(factory: Function) {
        const component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(100).join("\n");
      },
      async select(title: string, items: string[]) {
        selections.push({ title, items });
        return options.select?.(items);
      },
      async input(title: string, placeholder?: string) {
        inputs.push({ title, placeholder });
        return options.input?.(title, placeholder);
      },
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return options.confirm?.(title, message) ?? false;
      },
    },
  };

  tasksOverlay(pi as any);
  return {
    appendedEntries,
    calls,
    commands,
    context,
    handlers,
    notifications,
    renamedSessions,
    render: () => rendered,
    selections,
    inputs,
    confirmations,
    issues,
    shortcuts,
  };
}

async function show(harness: ReturnType<typeof createHarness>) {
  const command = harness.commands.get("tasks");
  assert.ok(command);
  await command.handler("", harness.context);
}

async function switchProject(harness: ReturnType<typeof createHarness>) {
  const command = harness.commands.get("project");
  assert.ok(command);
  await command.handler("", harness.context);
}

async function renameProject(harness: ReturnType<typeof createHarness>) {
  const command = harness.commands.get("project");
  assert.ok(command);
  await command.handler("rename", harness.context);
}

async function startSession(
  harness: ReturnType<typeof createHarness>,
  reason: "startup" | "reload" | "new" | "resume" | "fork",
) {
  const handler = harness.handlers.get("session_start");
  assert.ok(handler);
  await handler({ type: "session_start", reason }, harness.context);
}

function projectEntry(workstream: unknown): Entry {
  return {
    type: "custom",
    customType: "jp-project-scope",
    data: { version: 1, workstream },
  };
}

test("registers task and project commands with only the task shortcut", () => {
  const harness = createHarness();
  assert.ok(harness.commands.has("tasks"));
  assert.ok(harness.commands.has("project"));
  assert.deepEqual([...harness.shortcuts.keys()], ["ctrl+alt+t"]);
});

const selectProject = (name: string) => (items: string[]) =>
  items.find((item) => item.startsWith(`${name} `));

const GLOBAL_PROJECT = "Global / no project";

test("project picker groups primary workstreams and shows readiness counts", async () => {
  const harness = createHarness({
    sessionName: "other",
    issues: [
      issue("doing", "in_progress", ["workstream:Alpha"]),
      issue("blocked", "blocked", ["workstream:alpha"]),
      issue("ready", "open", ["workstream:ALPHA"]),
      issue("waiting", "open", ["workstream:Alpha"]),
      issue("secondary", "in_progress", [
        "workstream:Beta",
        "workstream:Alpha",
      ]),
      issue("empty", "open", ["workstream:"]),
      issue("unscoped", "open", []),
    ],
    readyIds: ["ready"],
    select: selectProject("Alpha"),
  });

  await switchProject(harness);

  assert.equal(harness.selections.length, 1);
  assert.equal(harness.selections[0].title, "Switch project");
  assert.equal(harness.selections[0].items[0], GLOBAL_PROJECT);
  assert.equal(
    harness.selections[0].items.filter((item) =>
      item.toLowerCase().startsWith("alpha "),
    ).length,
    1,
  );
  assert.match(
    harness.selections[0].items[1],
    /Alpha.*In progress: 1.*Blocked: 1.*Ready: 1.*Waiting: 1/,
  );
  assert.match(harness.selections[0].items[2], /Beta.*In progress: 1/);
  assert.equal(harness.selections[0].items.length, 3);
  assert.deepEqual(harness.renamedSessions, ["Alpha-580c8e67"]);
});

test("project picker sorts workstreams case-insensitively by canonical name", async () => {
  const harness = createHarness({
    sessionName: "other",
    issues: [
      issue("zulu", "open", ["workstream:Zulu"]),
      issue("alpha-first", "open", ["workstream:aLPHa"]),
      issue("beta", "open", ["workstream:Beta"]),
      issue("alpha-second", "blocked", ["workstream:ALPHA"]),
    ],
    select: selectProject("aLPHa"),
  });

  await switchProject(harness);

  assert.deepEqual(
    harness.selections[0].items.map((item) => item.split(" —")[0]),
    [GLOBAL_PROJECT, "aLPHa", "Beta", "Zulu"],
  );
  assert.deepEqual(harness.renamedSessions, ["aLPHa-580c8e67"]);
});

test("project selection persists canonical scope and generates a unique name", async () => {
  const harness = createHarness({
    sessionName: "other",
    issues: [issue("one", "open", ["workstream:pi-setup"])],
    select: selectProject("pi-setup"),
  });

  await switchProject(harness);

  assert.deepEqual(harness.appendedEntries, [projectEntry("pi-setup")]);
  assert.deepEqual(harness.renamedSessions, ["pi-setup-580c8e67"]);
});

test("selecting Global clears the project scope", async () => {
  const harness = createHarness({
    issues: [issue("one")],
    select: (items) => items[0],
  });

  await switchProject(harness);

  assert.deepEqual(harness.appendedEntries, [projectEntry(null)]);
  assert.deepEqual(harness.renamedSessions, [""]);
});

test("selecting Global when already explicitly global is a no-op", async () => {
  const harness = createHarness({
    entries: [projectEntry(null)],
    issues: [issue("one")],
    select: (items) => items[0],
  });

  await switchProject(harness);

  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, []);
});

test("cancelling project selection does not mutate project scope", async () => {
  const harness = createHarness({ issues: [issue("one")] });

  await switchProject(harness);

  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, []);
});

test("project picker offers only Global when no issue has a workstream", async () => {
  const harness = createHarness({
    sessionName: null,
    issues: [issue("unscoped", "open", [])],
  });

  await switchProject(harness);

  assert.deepEqual(harness.selections[0].items, [GLOBAL_PROJECT]);
  assert.deepEqual(harness.renamedSessions, []);
});

test("project picker excludes workstreams represented only by closed tasks", async () => {
  const harness = createHarness({
    sessionName: null,
    issues: [
      issue("closed", "closed", ["workstream:Closed Project"]),
      issue("open", "open", ["workstream:Active Project"]),
    ],
  });

  await switchProject(harness);

  assert.deepEqual(
    harness.selections[0].items.map((item) => item.split(" —")[0]),
    [GLOBAL_PROJECT, "Active Project"],
  );
});

test("selecting an explicit current project is a case-insensitive no-op", async () => {
  const harness = createHarness({
    sessionName: "manual display name",
    entries: [projectEntry("ALPHA")],
    issues: [issue("one", "open", ["workstream:Alpha"])],
    select: selectProject("Alpha"),
  });

  await switchProject(harness);

  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, []);
});

test("selecting a legacy exact-name project upgrades its scope", async () => {
  const harness = createHarness({
    sessionName: "Alpha",
    issues: [issue("one", "open", ["workstream:Alpha"])],
    select: selectProject("Alpha"),
  });

  await switchProject(harness);

  assert.deepEqual(harness.appendedEntries, [projectEntry("Alpha")]);
  assert.deepEqual(harness.renamedSessions, ["Alpha-580c8e67"]);
});

test("project rename preflights the registry before confirmation and update", async () => {
  const harness = createHarness({
    issues: [issue("one", "open", ["workstream:Alpha"])],
    registryGetResults: [
      {
        code: 0,
        stdout: JSON.stringify({ value: "{" }),
        stderr: "private registry details",
      },
    ],
    select: selectProject("Alpha"),
    input: () => "Renamed",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.deepEqual(
    harness.calls.map((args) => args.slice(0, 2)),
    [
      ["list", "-s"],
      ["config", "get"],
    ],
  );
  assert.deepEqual(harness.confirmations, []);
  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.notifications, [
    {
      message:
        "Project rename unavailable because session migrations cannot be prepared",
      type: "warning",
    },
  ]);
});

test("project rename updates matching workstreams across statuses, verifies the result, records the alias, and refreshes the current session", async () => {
  const harness = createHarness({
    entries: [projectEntry("ALPHA")],
    issues: [
      issue("open", "open", ["needs:jp", "workstream:Alpha", "topic:x"]),
      issue("deferred", "deferred", [
        "topic:y",
        "workstream:beta",
        "workstream:ALPHA",
      ]),
      issue("closed", "closed", [
        "workstream:alpha",
        "workstream:ALPHA",
        "topic:z",
      ]),
      issue("unrelated", "blocked", ["workstream:beta"]),
    ],
    select: selectProject("Alpha"),
    input: () => "Renamed",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.equal(harness.selections[0].title, "Rename project");
  assert.equal(harness.inputs[0].title, "New project name");
  assert.match(harness.confirmations[0].message, /Alpha → Renamed/);
  assert.match(harness.confirmations[0].message, /3 tasks/);
  assert.deepEqual(
    harness.calls.map((args) =>
      args[0] === "list"
        ? args[2]
        : args[0] === "config"
          ? `${args[0]}:${args[1]}`
          : args[0],
    ),
    [
      "open,in_progress,blocked,deferred,closed",
      "config:get",
      "update",
      "open,in_progress,blocked,deferred,closed",
      "config:get",
      "config:set",
      "config:get",
    ],
  );
  assert.deepEqual(harness.calls[2], [
    "update",
    "open",
    "deferred",
    "closed",
    "--remove-label",
    "workstream:Alpha",
    "--remove-label",
    "workstream:ALPHA",
    "--remove-label",
    "workstream:alpha",
    "--add-label",
    "workstream:Renamed",
    "--db",
    "/tmp/personal/.beads",
  ]);
  assert.deepEqual(harness.calls[5], [
    "config",
    "set",
    "custom.pi-project-renames",
    '{"version":1,"aliases":{"alpha":"Renamed"}}',
    "--json",
    "--db",
    "/tmp/personal/.beads",
  ]);
  assert.deepEqual(
    harness.issues.map((task) => ({ id: task.id, labels: task.labels })),
    [
      { id: "open", labels: ["needs:jp", "topic:x", "workstream:Renamed"] },
      {
        id: "deferred",
        labels: ["topic:y", "workstream:beta", "workstream:Renamed"],
      },
      { id: "closed", labels: ["topic:z", "workstream:Renamed"] },
      { id: "unrelated", labels: ["workstream:beta"] },
    ],
  );
  assert.deepEqual(harness.appendedEntries, [projectEntry("Renamed")]);
  assert.deepEqual(harness.renamedSessions, ["Renamed-580c8e67"]);
  assert.deepEqual(harness.notifications, [
    {
      message: "Renamed project Alpha → Renamed across 3 tasks",
      type: "info",
    },
  ]);
});

test("project rename partially succeeds when the registry write fails", async () => {
  const harness = createHarness({
    entries: [projectEntry("Alpha")],
    issues: [issue("one", "open", ["workstream:Alpha"])],
    registrySetResult: {
      code: 1,
      stdout: "private registry output",
      stderr: "private registry error",
    },
    select: selectProject("Alpha"),
    input: () => "Renamed",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.deepEqual(harness.appendedEntries, [projectEntry("Renamed")]);
  assert.deepEqual(harness.renamedSessions, ["Renamed-580c8e67"]);
  assert.equal(
    harness.calls.some((args) => args[0] === "config" && args[1] === "set"),
    true,
  );
  assert.deepEqual(harness.notifications, [
    {
      message:
        "Renamed project Alpha → Renamed, but other sessions cannot migrate automatically",
      type: "warning",
    },
  ]);
});

test("project rename partially succeeds when registry read-back does not verify", async () => {
  const harness = createHarness({
    entries: [projectEntry("Alpha")],
    issues: [issue("one", "open", ["workstream:Alpha"])],
    registrySetMutates: false,
    select: selectProject("Alpha"),
    input: () => "Renamed",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.deepEqual(harness.appendedEntries, [projectEntry("Renamed")]);
  assert.deepEqual(harness.renamedSessions, ["Renamed-580c8e67"]);
  assert.deepEqual(harness.notifications, [
    {
      message:
        "Renamed project Alpha → Renamed, but other sessions cannot migrate automatically",
      type: "warning",
    },
  ]);
});

test("project rename rejects case-insensitive collisions with another workstream", async () => {
  const harness = createHarness({
    issues: [
      issue("alpha", "open", ["workstream:Alpha"]),
      issue("beta", "closed", ["workstream:Beta"]),
    ],
    select: selectProject("Alpha"),
    input: () => "beta",
  });

  await renameProject(harness);

  assert.deepEqual(harness.calls, [
    [
      "list",
      "-s",
      "open,in_progress,blocked,deferred,closed",
      "-n",
      "0",
      "--json",
      "--db",
      "/tmp/personal/.beads",
    ],
  ]);
  assert.deepEqual(harness.confirmations, []);
  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, []);
  assert.deepEqual(harness.notifications, [
    { message: "Project beta already exists", type: "warning" },
  ]);
});

test("project rename permits case-only canonicalization", async () => {
  const harness = createHarness({
    entries: [projectEntry("alpha")],
    issues: [
      issue("open", "open", ["workstream:alpha"]),
      issue("closed", "closed", ["workstream:ALPHA"]),
    ],
    select: selectProject("alpha"),
    input: () => "ALPHA",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.deepEqual(harness.calls[2], [
    "update",
    "open",
    "closed",
    "--remove-label",
    "workstream:alpha",
    "--remove-label",
    "workstream:ALPHA",
    "--add-label",
    "workstream:ALPHA",
    "--db",
    "/tmp/personal/.beads",
  ]);
  assert.deepEqual(harness.appendedEntries, [projectEntry("ALPHA")]);
  assert.deepEqual(harness.renamedSessions, ["ALPHA-580c8e67"]);
});

test("project rename succeeds when verification matches after a non-zero update exit", async () => {
  const harness = createHarness({
    entries: [projectEntry("Alpha")],
    issues: [
      issue("open", "open", ["needs:jp", "workstream:Alpha", "topic:x"]),
      issue("closed", "closed", [
        "workstream:ALPHA",
        "workstream:beta",
        "topic:y",
      ]),
    ],
    updateExitCode: 1,
    select: selectProject("Alpha"),
    input: () => "Renamed",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.equal(harness.calls.length, 7);
  assert.equal(
    harness.calls.some((args) => args[0] === "config" && args[1] === "set"),
    true,
  );
  assert.deepEqual(harness.appendedEntries, [projectEntry("Renamed")]);
  assert.deepEqual(harness.renamedSessions, ["Renamed-580c8e67"]);
  assert.deepEqual(harness.notifications, [
    {
      message: "Renamed project Alpha → Renamed across 2 tasks",
      type: "info",
    },
  ]);
});

test("project rename reports a verification failure when re-listing still shows the old workstream", async () => {
  const harness = createHarness({
    entries: [projectEntry("Alpha")],
    issues: [issue("one", "open", ["workstream:Alpha"])],
    updateMutates: false,
    select: selectProject("Alpha"),
    input: () => "Renamed",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.equal(harness.calls.length, 4);
  assert.equal(
    harness.calls.some((args) => args[0] === "config" && args[1] === "set"),
    false,
  );
  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, []);
  assert.deepEqual(harness.notifications, [
    {
      message: "Project rename could not be verified for Renamed",
      type: "warning",
    },
  ]);
});

test("project rename reports a verification failure when update drops an unrelated label", async () => {
  const harness = createHarness({
    entries: [projectEntry("Alpha")],
    issues: [
      issue("one", "open", [
        "needs:jp",
        "topic:x",
        "workstream:beta",
        "workstream:Alpha",
      ]),
    ],
    afterUpdate(task) {
      task.labels = task.labels.filter((label) => label !== "workstream:beta");
    },
    select: selectProject("Alpha"),
    input: () => "Renamed",
    confirm: () => true,
  });

  await renameProject(harness);

  assert.equal(harness.calls.length, 4);
  assert.equal(
    harness.calls.some((args) => args[0] === "config" && args[1] === "set"),
    false,
  );
  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, []);
  assert.deepEqual(harness.notifications, [
    {
      message: "Project rename could not be verified for Renamed",
      type: "warning",
    },
  ]);
});

for (const [name, message] of [
  ["Alpha,Beta", "Project name must not contain commas"],
  [
    "Alpha\tBeta",
    "Project name contains unsupported whitespace or control characters",
  ],
  [
    "Alpha ",
    "Project name contains unsupported whitespace or control characters",
  ],
  [
    "Alpha\t",
    "Project name contains unsupported whitespace or control characters",
  ],
  [
    `${"x".repeat(117)} `,
    "Project name contains unsupported whitespace or control characters",
  ],
  ["x".repeat(118), "Project name must be 117 characters or fewer"],
] as const) {
  test(`project rename rejects invalid name ${JSON.stringify(name)} before update`, async () => {
    const harness = createHarness({
      issues: [issue("one", "open", ["workstream:Alpha"])],
      select: selectProject("Alpha"),
      input: () => name,
    });

    await renameProject(harness);

    assert.deepEqual(harness.calls, [
      [
        "list",
        "-s",
        "open,in_progress,blocked,deferred,closed",
        "-n",
        "0",
        "--json",
        "--db",
        "/tmp/personal/.beads",
      ],
    ]);
    assert.deepEqual(harness.confirmations, []);
    assert.deepEqual(harness.appendedEntries, []);
    assert.deepEqual(harness.renamedSessions, []);
    assert.deepEqual(harness.notifications, [{ message, type: "warning" }]);
  });
}

for (const unavailable of ["active", "ready"] as const) {
  test(`${unavailable} query failure warns and does not rename the project`, async () => {
    const harness = createHarness({
      issues: [issue("one")],
      unavailable,
      select: selectProject("pi-setup"),
    });

    await assert.doesNotReject(switchProject(harness));

    assert.deepEqual(harness.selections, []);
    assert.deepEqual(harness.appendedEntries, []);
    assert.deepEqual(harness.renamedSessions, []);
    assert.deepEqual(harness.notifications, [
      { message: "Projects unavailable", type: "warning" },
    ]);
  });
}

test("forking an explicitly scoped session regenerates its unique name", async () => {
  const harness = createHarness({
    sessionName: "manual copied name",
    sessionId: "019ff29e-4652-7c2d-90c5-123456789abc",
    entries: [projectEntry("pi-setup")],
  });

  await startSession(harness, "fork");

  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, ["pi-setup-56789abc"]);
});

for (const reason of ["startup", "resume", "reload", "fork"] as const) {
  test(`${reason} migrates an explicitly aliased session scope`, async () => {
    const harness = createHarness({
      entries: [projectEntry("alpha")],
      registryValue: '{"version":1,"aliases":{"alpha":"Beta"}}',
    });

    await startSession(harness, reason);

    assert.deepEqual(harness.appendedEntries, [projectEntry("Beta")]);
    assert.deepEqual(harness.renamedSessions, ["Beta-580c8e67"]);
    assert.deepEqual(harness.notifications, []);
  });
}

test("session start migrates a legacy exact-name scope and makes it explicit", async () => {
  const harness = createHarness({
    sessionName: "alpha",
    registryValue: '{"version":1,"aliases":{"alpha":"Beta"}}',
  });

  await startSession(harness, "startup");

  assert.deepEqual(harness.appendedEntries, [projectEntry("Beta")]);
  assert.deepEqual(harness.renamedSessions, ["Beta-580c8e67"]);
});

for (const [label, workstream] of [
  ["unrelated", "Gamma"],
  ["already canonical", "Beta"],
] as const) {
  test(`session start leaves an ${label} scope untouched`, async () => {
    const harness = createHarness({
      entries: [projectEntry(workstream)],
      registryValue: '{"version":1,"aliases":{"alpha":"Beta"}}',
    });

    await startSession(harness, "startup");

    assert.deepEqual(harness.appendedEntries, []);
    assert.deepEqual(harness.renamedSessions, []);
    assert.deepEqual(harness.notifications, []);
  });
}

for (const [label, registryValue] of [
  ["malformed", "{"],
  ["cyclic", '{"version":1,"aliases":{"alpha":"Beta","beta":"alpha"}}'],
] as const) {
  test(`session start warns and preserves scope for ${label} registry data`, async () => {
    const harness = createHarness({
      entries: [projectEntry("alpha")],
      registryValue,
    });

    await startSession(harness, "startup");

    assert.deepEqual(harness.appendedEntries, []);
    assert.deepEqual(harness.renamedSessions, []);
    assert.deepEqual(harness.notifications, [
      {
        message: "Project scope could not be migrated automatically",
        type: "warning",
      },
    ]);
  });
}

test("session start without a workstream does not query Beads", async () => {
  const harness = createHarness({ entries: [projectEntry(null)] });

  await startSession(harness, "startup");

  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.appendedEntries, []);
  assert.deepEqual(harness.renamedSessions, []);
});

for (const [label, options] of [
  ["explicit global", { entries: [projectEntry(null)] }],
  ["malformed metadata", { entries: [projectEntry("")] }],
  ["legacy display name", { sessionName: "pi-setup" }],
  ["absent metadata", { sessionName: null }],
] as const) {
  test(`forking with ${label} does not rename`, async () => {
    const harness = createHarness(options);

    await startSession(harness, "fork");

    assert.deepEqual(harness.appendedEntries, []);
    assert.deepEqual(harness.renamedSessions, []);
  });
}

for (const reason of ["startup", "reload", "new", "resume"] as const) {
  test(`${reason} does not rename an explicitly scoped session`, async () => {
    const harness = createHarness({ entries: [projectEntry("pi-setup")] });

    await startSession(harness, reason);

    assert.deepEqual(harness.appendedEntries, []);
    assert.deepEqual(harness.renamedSessions, []);
  });
}

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

test("explicit scope overrides a generated display name", async () => {
  const harness = createHarness({
    sessionName: "pi-setup-580c8e67",
    entries: [projectEntry("pi-setup")],
    issues: [
      issue("scoped", "open", ["workstream:pi-setup"]),
      issue("display-name", "blocked", ["workstream:pi-setup-580c8e67"]),
      issue("unrelated", "in_progress", ["workstream:other"]),
    ],
    readyIds: ["scoped"],
  });

  await show(harness);

  assert.match(harness.render(), /Tasks — pi-setup/);
  assert.match(harness.render(), /Task scoped/);
  assert.doesNotMatch(harness.render(), /display-name|unrelated/);
});

test("explicit global scope ignores a display name", async () => {
  const harness = createHarness({
    sessionName: "manual display name",
    entries: [projectEntry(null)],
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
  assert.doesNotMatch(harness.render(), /Tasks — manual display name/);
});

test("legacy exact-name sessions still filter case-insensitively", async () => {
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

test("malformed explicit metadata does not route by display name", async () => {
  const harness = createHarness({
    sessionName: "pi-setup-580c8e67",
    entries: [projectEntry("")],
    issues: [
      issue("alpha", "in_progress", ["workstream:alpha"]),
      issue("beta", "blocked", ["workstream:beta"]),
    ],
  });

  await show(harness);

  assert.match(harness.render(), /Task alpha/);
  assert.match(harness.render(), /Task beta/);
  assert.doesNotMatch(harness.render(), /Tasks — pi-setup-580c8e67/);
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

test("empty results notify with the resolved workstream", async () => {
  const harness = createHarness({
    sessionName: "pi-setup-580c8e67",
    entries: [projectEntry("pi-setup")],
  });
  await show(harness);

  assert.equal(harness.render(), "");
  assert.deepEqual(harness.notifications, [
    { message: "No open tasks for pi-setup", type: "info" },
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
