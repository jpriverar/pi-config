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
  "real-store CLI preview and prepare preserve bindings, lifecycle, and journal through exact-plan recovery",
  { timeout: 90000 },
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
  },
);
