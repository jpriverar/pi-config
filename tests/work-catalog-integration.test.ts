import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import tasksOverlay from "../extensions/tasks-overlay/index.js";
import herdrClone from "../extensions/herdr-clone/index.js";
import {
  createCatalogService,
  type CatalogCommand,
} from "../lib/work-catalog/service.js";
import {
  buildWorkView,
  selectWorkIssues,
  workSelectionLabel,
} from "../lib/work-catalog/membership.js";
import {
  persistSessionWorkScope,
  resolveSessionSelection,
} from "../lib/session-project.js";
import type { CatalogIssue, WorkCatalog } from "../lib/work-catalog/model.js";
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
  readdir,
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
        scope: { kind: "global" },
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
        scope: { kind: "global" },
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
        scope: { kind: "area", areaId: remoteArea.entityId },
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
    await verifySessionViews(
      root,
      catalog,
      final,
      rows,
      remoteProject.entityId,
      remoteTask.id,
    );
  },
);

async function verifySessionViews(
  root: string,
  catalog: ReturnType<typeof createCatalogStore>,
  currentCatalog: WorkCatalog,
  issues: CatalogIssue[],
  projectId: string,
  taskId: string,
) {
  const source = SessionManager.create(root, join(root, "sessions"));
  source.appendMessage({
    role: "user",
    content: "Synthetic catalog session",
    timestamp: 1,
  });
  const leaf = source.appendMessage({
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
  persistSessionWorkScope(source, { kind: "project", projectId });
  source.branch(leaf);
  const sourceFile = source.getSessionFile()!;
  let current = SessionManager.open(sourceFile, source.getSessionDir(), root);
  const verify = (manager: SessionManager) => {
    const selected = resolveSessionSelection(manager, currentCatalog);
    assert.equal(selected.kind, "catalog");
    assert.equal(workSelectionLabel(selected), "Renamed Published Work");
    assert.deepEqual(
      selectWorkIssues(selected, issues).map((issue) => issue.id),
      [taskId],
    );
  };
  verify(current);
  type Handler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
    registerShortcut: () => {},
    appendEntry: (type: string, data: unknown) =>
      current.appendCustomEntry(type, data),
    setSessionName: (name: string) => current.appendSessionInfo(name),
    exec: async () => {
      throw new Error("Unexpected external command in scoped session fixture");
    },
  } as unknown as ExtensionAPI;
  const context = () =>
    ({
      cwd: root,
      sessionManager: current,
      ui: {
        notify: (message: string, level?: string) => {
          if (level !== "info") assert.fail(message);
        },
      },
    }) as unknown as ExtensionContext;
  tasksOverlay(pi, { catalog });
  await handlers.get("session_start")!({ reason: "resume" }, context());
  await handlers.get("session_before_fork")!({}, context());
  current.createBranchedSession(leaf);
  await handlers.get("session_start")!({ reason: "fork" }, context());
  verify(current);
  verify(
    SessionManager.open(
      current.getSessionFile()!,
      source.getSessionDir(),
      root,
    ),
  );

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
    const beforeFiles = new Set(await readdir(source.getSessionDir()));
    const calls: string[] = [];
    herdrClone({
      registerCommand: (_name, command) => {
        cloneCommand = command;
      },
      getThinkingLevel: () => "low",
      exec: async (command, args) => {
        calls.push(command);
        return {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({
            result:
              args[0] === "pane"
                ? { pane: { pane_id: "w1:p2" } }
                : {
                    agent: {
                      pane_id: "w1:p2",
                      terminal_id: "fixture",
                      name: args[2],
                      kind: "pi",
                      state: "idle",
                    },
                  },
          }),
        };
      },
    } as ExtensionAPI);
    await cloneCommand!.handler("", {
      ...context(),
      sessionManager: source,
      mode: "tui",
      model: { provider: "openai", id: "fixture" },
      isIdle: () => true,
      hasPendingMessages: () => false,
    } as unknown as ExtensionCommandContext);
    assert.deepEqual(calls, ["herdr", "herdr"]);
    const clonedFiles = (await readdir(source.getSessionDir())).filter(
      (file) => !beforeFiles.has(file),
    );
    assert.equal(clonedFiles.length, 1);
    verify(
      SessionManager.open(
        join(source.getSessionDir(), clonedFiles[0]),
        source.getSessionDir(),
        root,
      ),
    );
    verify(source);
  } finally {
    for (const [key, value] of Object.entries(savedEnv))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}
