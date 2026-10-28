import { legacyLifecycle } from "../lib/task-lifecycle/legacy-test-fixtures.js";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { TaskLifecycleService } from "../lib/task-lifecycle/service.js";
import { createTaskLifecycleExtension } from "../extensions/task-lifecycle/index.js";
import { readSessionFacts } from "../extensions/task-lifecycle/task-context.js";
import tasksOverlay from "../extensions/tasks-overlay/index.js";
import herdrClone from "../extensions/herdr-clone/index.js";
import {
  createCatalogService,
  type CatalogCommand,
} from "../lib/work-catalog/service.js";
import { buildWorkView } from "../lib/work-catalog/membership.js";
import {
  persistSessionWorkScope,
  resolveSessionSelection,
} from "../lib/session-project.js";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";
import { createActionableLifecycle } from "../lib/task-lifecycle/model.js";
import { loadWorkManagementConfig } from "../lib/work-management/config.js";
import { target } from "../lib/work-management/test-fixtures.js";
import {
  createMigrationIO,
  readMigrationJson,
} from "../lib/work-catalog/migration-io.js";
import {
  activateCatalogMigration,
  decodeCatalogMigrationPlan,
} from "../lib/work-catalog/migration.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  rm,
  realpath,
  writeFile,
  readFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBeadsClient, type BeadsExec } from "../lib/beads.js";
import { createCatalogStore } from "../lib/work-catalog/store.js";
import { catalogFixture, P } from "../lib/work-catalog/test-fixtures.js";
const exec = promisify(execFile);

test(
  "real Beads persists a complete 63 KiB work catalog",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-catalog-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { BEADS_DIR: _dir, BEADS_DB: _db, ...env } = process.env;
    await exec(
      "bd",
      ["init", "--init-if-missing", "--non-interactive", "--prefix", "zz"],
      { cwd: root, env, timeout: 20000 },
    );
    const storePath = join(root, ".beads");
    let commandFailure: { code?: number | string; stderr: string } | undefined;
    const run: BeadsExec = async (command, args, options) => {
      try {
        const output = await exec(command, [...args], {
          cwd: root,
          env: { ...env, ...options?.env },
          maxBuffer: 1024 * 1024,
          timeout: 10000,
        });
        return { code: 0, ...output };
      } catch (error) {
        const e = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        commandFailure = {
          code: e.code,
          stderr: (e.stderr ?? "").slice(-1000),
        };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    };
    const store = createCatalogStore(
      createBeadsClient(run, { env: { BEADS_DIR: storePath } }),
    );
    assert.equal(await store.read(), null);
    const catalog = catalogFixture();
    for (let i = 0; i < 60; i++) {
      const id = "77777777-7777-4777-8777-" + String(i).padStart(12, "0");
      catalog.projects[id] = {
        ...catalog.projects[P],
        id,
        name: "project-" + i,
        workstreamKey: "project-" + i,
        description: "x",
        aliases: [],
      };
    }
    for (const project of Object.values(catalog.projects)) {
      const remaining = 64512 - Buffer.byteLength(JSON.stringify(catalog));
      project.description += "x".repeat(
        Math.min(remaining, 1024 - project.description!.length),
      );
    }
    assert.equal(Buffer.byteLength(JSON.stringify(catalog)), 64512);
    try {
      await store.write(catalog);
    } catch (error) {
      throw new Error(
        `${String(error)}; synthetic-fixture command error: ${JSON.stringify(commandFailure)}`,
      );
    }
    assert.deepEqual(await store.read(), catalog);
  },
);

test(
  "real-store migration, routing, and session views preserve existing task history",
  { timeout: 120000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "pi-migration-test-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const { BEADS_DIR: _dir, BEADS_DB: _db, ...base } = process.env;
    const env = {
      ...base,
      BD_BACKUP_ENABLED: "false",
      PI_TASK_RECONCILER_CONFIG: join(root, "no-live-daemon.json"),
    };
    await exec(
      "bd",
      ["init", "--init-if-missing", "--non-interactive", "--prefix", "zz"],
      { cwd: root, env, timeout: 20000 },
    );
    const storePath = join(root, ".beads");
    const run: BeadsExec = async (command, args, options) => {
      try {
        return {
          code: 0,
          ...(await exec(command, [...args], {
            cwd: root,
            env: { ...env, ...options?.env },
            timeout: 10000,
            maxBuffer: 4 * 1024 * 1024,
          })),
        };
      } catch (error) {
        const e = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    };
    const client = createBeadsClient(run, { env: { BEADS_DIR: storePath } });
    const catalog = createCatalogStore(client);
    await writeFile(
      join(storePath, "pi-work-management.json"),
      JSON.stringify({
        version: 1,
        ddAuthPath: process.execPath,
        curlPath: process.execPath,
        defaultTarget: target,
        workstreams: {},
      }),
      { mode: 0o600 },
    );
    const store = createLifecycleStore(run, {
      store: storePath,
      readCatalog: () => catalog.read(),
      readWorkManagementConfig: () => loadWorkManagementConfig(storePath),
    });
    const owner = {
      pid: process.pid,
      host: hostname(),
      sessionId: "migration-fixture",
      started: Date.now(),
    };
    const lifecycle = createActionableLifecycle(new Date().toISOString());
    const old = await store.create(
      {
        title: "Sensitive fixture title",
        why: "Isolated fixture",
        needsJp: false,
        workstream: "api",
      },
      lifecycle,
      owner,
    );
    await store.appendComment(
      old.id,
      "Private fixture journal",
      owner,
      () => {},
    );
    const unscoped = await store.create(
      {
        title: "Legacy unscoped fixture",
        why: "Retain existing semantics",
        needsJp: false,
      },
      lifecycle,
      owner,
    );
    const before = await store.show(old.id),
      comments = await store.comments(old.id),
      originalUnscoped = await store.show(unscoped.id);
    const assignmentsPath = join(root, "assignments.json"),
      planPath = join(root, "plan.json");
    await writeFile(
      assignmentsPath,
      JSON.stringify({
        version: 1,
        areas: [
          {
            name: "Product",
            description: "Reviewed fixture area.",
            publication: { mode: "local" },
          },
        ],
        projects: [
          {
            name: "api",
            area: "Product",
            description: "Reviewed fixture project.",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const repository = fileURLToPath(new URL("../", import.meta.url));
    const cli = (args: string[]) =>
      exec("npm", ["run", "catalog", "--", ...args], {
        cwd: repository,
        env,
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      });
    await cli([
      "preview",
      "--store",
      storePath,
      "--assignments",
      assignmentsPath,
      "--output",
      planPath,
    ]);
    assert.equal((await stat(planPath)).mode & 0o777, 0o600);
    const planText = await readFile(planPath, "utf8");
    assert.doesNotMatch(
      planText,
      /Private fixture journal|Sensitive fixture title/,
    );
    const plan = decodeCatalogMigrationPlan(await readMigrationJson(planPath));
    assert.equal(plan.diagnostics.unscopedTasks, 1);
    assert.equal(await catalog.read(), null);
    await cli(["prepare", "--store", storePath, "--plan", planPath]);
    assert.deepEqual(await catalog.read(), plan.catalog);
    const io = createMigrationIO(client, storePath);
    const deps = { ...io, verifyRuntime: async () => {} };
    await io.writeConfig(plan.config);
    assert.equal(loadWorkManagementConfig(storePath)!.version, 2);
    assert.equal((await catalog.read())!.state, "prepared");
    await assert.rejects(
      store.create(
        {
          title: "Cannot create",
          why: "Partial cutover",
          needsJp: false,
          workstream: "api",
        },
        lifecycle,
        owner,
      ),
      /catalog/i,
    );
    await activateCatalogMigration(plan, deps);
    assert.equal((await catalog.read())!.state, "active");
    assert.deepEqual((await store.show(old.id)).metadata, before.metadata);
    assert.deepEqual(await store.comments(old.id), comments);
    assert.deepEqual(
      (await store.show(unscoped.id)).metadata,
      originalUnscoped.metadata,
    );
    const projectId = Object.keys(plan.catalog.projects)[0];
    const fresh = await store.create(
      {
        title: "New local task",
        why: "Future routing only",
        needsJp: false,
        projectId,
      },
      lifecycle,
      owner,
    );
    assert.deepEqual(fresh.metadata.piProject, { version: 1, projectId });
    assert.equal(fresh.metadata.piWorkManagement, undefined);
    await activateCatalogMigration(plan, deps);
    assert.deepEqual((await store.show(old.id)).metadata, before.metadata);

    const service = createCatalogService({ client, store: catalog, storePath });
    const apply = async (command: CatalogCommand) =>
      service.apply(command, (await service.read()).revision, owner);
    const localArea = Object.keys(plan.catalog.areas)[0];
    const remoteTarget = {
      ...target,
      projectId: "99999999-9999-4999-8999-999999999999",
    };
    const remoteArea = await apply({
      kind: "create_area",
      name: "Operations",
      description: "Service operations fixture.",
      publication: { mode: "datadog", target: remoteTarget },
    });
    const localProject = await apply({
      kind: "create_project",
      name: "Local Work",
      description: "Local fixture work.",
      areaId: localArea,
    });
    const remoteProject = await apply({
      kind: "create_project",
      name: "Published Work",
      description: "Published fixture work.",
      areaId: remoteArea.entityId,
    });
    const issues = async () => {
      const result = await client.listIssues();
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const empty = buildWorkView(await service.read(), await issues(), {
      kind: "global",
    });
    for (const id of [localProject.entityId, remoteProject.entityId]) {
      const row = empty.projects.find((row) => row.project.id === id)!;
      assert.equal(row.hidden, false);
      assert.equal(row.unfinished, 0);
    }
    const localTask = await store.create(
      {
        title: "Local scoped fixture",
        why: "Local area route",
        needsJp: false,
        projectId: localProject.entityId,
      },
      lifecycle,
      owner,
    );
    const remoteTask = await store.create(
      {
        title: "Published scoped fixture",
        why: "Explicit area route",
        needsJp: false,
        projectId: remoteProject.entityId,
      },
      lifecycle,
      owner,
    );
    assert.equal(localTask.metadata.piWorkManagement, undefined);
    const savedRemote = structuredClone(remoteTask.metadata);
    assert.deepEqual(
      (remoteTask.metadata.piWorkManagement as { target: unknown }).target,
      remoteTarget,
    );
    await apply({
      kind: "describe",
      entity: "project",
      id: remoteProject.entityId,
      description: "Revised fixture description; same identity.",
    });
    await apply({
      kind: "rename",
      entity: "project",
      id: remoteProject.entityId,
      name: "Renamed Published Work",
    });
    await apply({
      kind: "move_project",
      projectId: remoteProject.entityId,
      areaId: localArea,
    });
    const final = await service.read();
    assert.equal(
      final.projects[remoteProject.entityId].description,
      "Revised fixture description; same identity.",
    );
    assert.deepEqual((await store.show(remoteTask.id)).metadata, savedRemote);
    assert.deepEqual((await store.show(old.id)).metadata, before.metadata);
    assert.deepEqual(await store.comments(old.id), comments);
    const rows = await issues();
    const view = buildWorkView(final, rows, {
      kind: "area",
      areaId: localArea,
    });
    assert.ok(view.issues.some((row) => row.id === localTask.id));
    assert.ok(view.issues.some((row) => row.id === remoteTask.id));
    assert.equal(
      view.projects.find((row) => row.project.id === remoteProject.entityId)!
        .destinationMismatches,
      1,
    );
    await verifyTaskDrivenSessions({
      root,
      storePath,
      run,
      client,
      catalog,
      store,
      projectId: remoteProject.entityId,
      taskId: remoteTask.id,
      otherProjectId: localProject.entityId,
      moveAreaId: remoteArea.entityId,
      apply,
    });
    assert.deepEqual((await store.show(old.id)).metadata, before.metadata);
    assert.deepEqual(await store.comments(old.id), comments);
  },
);

async function verifyTaskDrivenSessions(input: {
  root: string;
  storePath: string;
  run: BeadsExec;
  client: ReturnType<typeof createBeadsClient>;
  catalog: ReturnType<typeof createCatalogStore>;
  store: ReturnType<typeof createLifecycleStore>;
  projectId: string;
  taskId: string;
  otherProjectId: string;
  moveAreaId: string;
  apply(command: CatalogCommand): Promise<unknown>;
}) {
  const {
    root,
    storePath,
    run,
    client,
    catalog,
    store,
    projectId,
    taskId,
    otherProjectId,
  } = input;
  const previousBeads = process.env.BEADS_DIR;
  process.env.BEADS_DIR = storePath;
  try {
    const current = SessionManager.create(root, join(root, "sessions"));
    current.appendMessage({
      role: "user",
      content: "Synthetic task identity session",
      timestamp: 1,
    });
    const leaf = current.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Synthetic answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const service = new TaskLifecycleService({
      store,
      now: Date.now,
      uuid: () => "fixture-identity-operation",
      executionTimeoutMs: 60000,
    });
    type Handler = (event: any, ctx: any) => unknown;
    const handlers = new Map<string, Handler[]>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const messages: any[] = [];
    const notifications: string[] = [];
    let reads = 0;
    let nameWrites = 0;
    const pi = {
      events: new EventEmitter(),
      on: (name: string, handler: Handler) =>
        handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) =>
        commands.set(name, command),
      registerShortcut() {},
      registerEntryRenderer() {},
      appendEntry: (type: string, data: unknown) =>
        current.appendCustomEntry(type, data),
      setSessionName: (name: string) => {
        nameWrites++;
        current.appendSessionInfo(name);
      },
      getSessionName: () => current.getSessionName(),
      sendMessage: (message: unknown) => messages.push(message),
      exec: async (command: string, argv: readonly string[]) => {
        const args = command === "env" ? argv.slice(2) : argv;
        const binary = command === "env" ? argv[1] : command;
        assert.equal(binary, "bd");
        assert.equal(args[args.indexOf("--db") + 1], storePath);
        return run(binary, args, { env: { BD_BACKUP_ENABLED: "false" } });
      },
    };
    const context = () => ({
      cwd: root,
      mode: "tui",
      sessionManager: current,
      ui: {
        notify: (message: string) => notifications.push(message),
        select: async (_title: string, items: string[]) => {
          const selected = items.find((item) =>
            item.includes("/ Local Work —"),
          );
          assert.ok(selected, "fixture project picker must offer Local Work");
          return selected;
        },
      },
    });
    createTaskLifecycleExtension({
      service,
      readCatalog: () => catalog.read(),
      readSessionFacts: async () => {
        reads++;
        return readSessionFacts(client, () => catalog.read());
      },
      workStateHealth: async () => ({
        state: "unavailable",
        reason: "No live daemon in fixture",
      }),
      now: Date.now,
      pid: process.pid,
      hostname: hostname(),
      activityWriteIntervalMs: 300000,
      sessionReconcileLimit: 10,
      sessionPrCheckLimit: 5,
    })(pi as any);
    // Run the browser after lifecycle recovery to catch an accidental override.
    tasksOverlay(pi as unknown as ExtensionAPI, { catalog });
    const emit = async (name: string, event: unknown = {}) => {
      const results: any[] = [];
      for (const handler of handlers.get(name) ?? [])
        results.push(await handler(event, context()));
      return results;
    };
    let operation = 0;
    const call = async (name: string, params: unknown) => {
      const result = await tools
        .get(name)
        .execute(
          `fixture-${++operation}`,
          params,
          undefined,
          undefined,
          context(),
        );
      assert.equal(result.isError, undefined);
      return result;
    };
    const view = async (manager = current) => {
      const selection = resolveSessionSelection(
        manager,
        (await catalog.read())!,
      );
      assert.equal(selection.kind, "catalog");
      if (selection.kind !== "catalog")
        throw new Error("Fixture catalog selection missing");
      return selection.scope;
    };
    const bindings = (row: Awaited<ReturnType<typeof store.show>>) => ({
      project: row.metadata.piProject,
      publication: row.metadata.piWorkManagement,
    });
    const original = await store.show(taskId);
    const originalBinding = structuredClone(bindings(original));
    await emit("session_start", { reason: "startup" });
    assert.equal(current.getSessionName(), undefined);
    const beforeClaimReads = reads;
    await call("task_claim", { taskId });
    assert.equal(
      reads - beforeClaimReads,
      1,
      "claim identity and mission share one snapshot",
    );
    assert.equal(current.getSessionName(), undefined);
    assert.deepEqual(await view(), { kind: "project", projectId });
    await commands.get("project").handler("", context());
    assert.deepEqual(await view(), {
      kind: "project",
      projectId: otherProjectId,
    });
    assert.equal(current.getSessionName(), undefined);
    const recorded = await call("task_create", {
      title: "Independent recorded work",
      why: "Record independent work",
      needs_jp: false,
      projectId: otherProjectId,
    });
    const recordedId = recorded.details.id as string;
    assert.equal(recorded.details.lifecycle.execution, null);
    assert.deepEqual(recorded.details.metadata.piProject, {
      version: 1,
      projectId: otherProjectId,
    });
    assert.equal(current.getSessionName(), undefined);
    assert.deepEqual(await view(), {
      kind: "project",
      projectId: otherProjectId,
    });
    await assert.rejects(
      call("task_create", {
        title: "Missing placement",
        why: "Must not inherit",
        needs_jp: false,
      }),
      /explicit project/i,
    );
    assert.deepEqual(bindings(await store.show(taskId)), originalBinding);

    await input.apply({
      kind: "rename",
      entity: "project",
      id: projectId,
      name: "Session-owned project",
    });
    await input.apply({
      kind: "move_project",
      projectId,
      areaId: input.moveAreaId,
    });
    await input.apply({
      kind: "rename",
      entity: "area",
      id: input.moveAreaId,
      name: "Runtime Operations",
    });
    const refreshed = await emit("before_agent_start");
    assert.equal(current.getSessionName(), undefined);
    assert.deepEqual(await view(), {
      kind: "project",
      projectId: otherProjectId,
    });
    assert.match(
      JSON.stringify(refreshed),
      /Session-owned project • Runtime Operations/,
    );
    assert.deepEqual(bindings(await store.show(taskId)), originalBinding);
    await call("task_defer", { taskId, reason: "Yield the fixture task" });
    assert.equal(current.getSessionName(), undefined);
    assert.deepEqual(await view(), { kind: "global" });
    await call("task_claim", { taskId: recordedId });
    assert.equal(current.getSessionName(), undefined);
    assert.deepEqual(await view(), {
      kind: "project",
      projectId: otherProjectId,
    });
    const recordedBinding = structuredClone(
      bindings(await store.show(recordedId)),
    );
    current.appendSessionInfo("Manual name is not authority");
    persistSessionWorkScope(current, { kind: "project", projectId });
    await emit("session_start", { reason: "resume" });
    assert.equal(current.getSessionName(), "Manual name is not authority");
    assert.deepEqual(await view(), {
      kind: "project",
      projectId: otherProjectId,
    });

    const parentId = current.getSessionId();
    const parentFile = current.getSessionFile()!;
    await emit("session_before_fork");
    current.createBranchedSession(leaf);
    assert.notEqual(current.getSessionId(), parentId);
    await emit("session_start", { reason: "fork" });
    assert.equal(current.getSessionName(), undefined);
    assert.deepEqual(await view(), { kind: "global" });
    assert.equal(
      legacyLifecycle((await store.show(recordedId)).lifecycle!).execution!
        .sessionId,
      parentId,
    );
    assert.deepEqual(bindings(await store.show(recordedId)), recordedBinding);
    assert.deepEqual(bindings(await store.show(taskId)), originalBinding);
    assert.equal((await store.show(taskId)).title, original.title);
    assert.equal(
      messages.filter((message) => message.customType === "jp-task-claimed")
        .length,
      2,
    );
    assert.ok(
      !notifications.some((message) =>
        /Startup tasks unavailable|identity could not/.test(message),
      ),
    );

    const parent = SessionManager.open(
      parentFile,
      current.getSessionDir(),
      root,
    );
    const parentBeforeClone = await readFile(parentFile, "utf8");
    const savedEnv = {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    };
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: join(root, "fake-herdr.sock"),
    });
    try {
      let cloneCommand:
        | Parameters<ExtensionAPI["registerCommand"]>[1]
        | undefined;
      const calls: { command: string; args: string[] }[] = [];
      herdrClone({
        registerCommand: (_name, command) => {
          cloneCommand = command;
        },
        getThinkingLevel: () => "low",
        exec: async (command, args) => {
          calls.push({ command, args });
          return {
            code: 0,
            killed: false,
            stderr: "",
            stdout: JSON.stringify({
              result:
                args[0] === "pane"
                  ? { pane: { pane_id: "w1:p2" } }
                  : { agent: { pane_id: "w1:p2" } },
            }),
          };
        },
      } as ExtensionAPI);
      await cloneCommand!.handler("", {
        ...context(),
        sessionManager: parent,
        model: { provider: "openai", id: "fixture" },
        isIdle: () => true,
        hasPendingMessages: () => false,
      } as unknown as ExtensionCommandContext);
      assert.deepEqual(
        calls.map((call) => call.command),
        ["herdr", "herdr"],
      );
      const launch = calls[1].args;
      const clone = SessionManager.open(
        launch[launch.indexOf("--session") + 1],
        parent.getSessionDir(),
        root,
      );
      assert.notEqual(clone.getSessionId(), parentId);
      assert.equal(clone.getSessionName(), "Manual name is not authority");
      assert.equal(
        nameWrites,
        0,
        "task/project integration must never write a session name",
      );
      assert.deepEqual(await view(clone), { kind: "global" });
      assert.equal(await readFile(parentFile, "utf8"), parentBeforeClone);
      assert.equal(
        legacyLifecycle((await store.show(recordedId)).lifecycle!).execution!
          .sessionId,
        parentId,
      );
    } finally {
      for (const [key, value] of Object.entries(savedEnv))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  } finally {
    if (previousBeads === undefined) delete process.env.BEADS_DIR;
    else process.env.BEADS_DIR = previousBeads;
  }
}
