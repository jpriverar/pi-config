import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { target } from "../work-management/test-fixtures.js";
import { createActionableLifecycle } from "../task-lifecycle/model.js";
import { createLifecycleStore } from "../task-lifecycle/beads-store.js";
import { resolveTaskMembership } from "./membership.js";
import { workRoutingMode } from "./routing.js";
import {
  buildCatalogMigration,
  verifyMigrationSource,
  prepareCatalogMigration,
  activateCatalogMigration,
  decodeCatalogMigrationPlan,
  type CatalogMigrationDependencies,
  type MigrationSnapshot,
} from "./migration.js";

const assignments = () => ({
  version: 1,
  areas: [
    {
      name: "Product",
      description: "Product responsibility.",
      publication: { mode: "datadog", target },
    },
  ],
  projects: [
    { name: "API", area: "Product", description: null },
    { name: "Maintenance", area: null, description: "Legacy maintenance." },
  ],
});
function fixture(store = "/tmp/migration-fixture"): MigrationSnapshot {
  return {
    store,
    catalog: null,
    renames: { version: 1, aliases: { "old-api": "API" } },
    archives: { version: 1, archived: ["maintenance"] },
    config: {
      version: 1,
      ddAuthPath: "/bin/true",
      curlPath: "/usr/bin/curl",
      defaultTarget: target,
      workstreams: {},
    },
    issues: [
      { id: "zz-api", status: "open", labels: ["workstream:old-api"] },
      { id: "zz-maint", status: "closed", labels: ["workstream:Maintenance"] },
      { id: "zz-inbox", status: "open", labels: [] },
    ],
  };
}
function ids() {
  let next = 1;
  return () => `11111111-1111-4111-8111-${String(next++).padStart(12, "0")}`;
}
async function harness(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "migration-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = fixture(root);
  const plan = buildCatalogMigration(state, assignments(), ids());
  let crash = "";
  let backup: unknown;
  const writes: string[] = [];
  const deps: CatalogMigrationDependencies = {
    storePath: root,
    readSnapshot: async () => structuredClone(state),
    catalog: {
      read: async () => structuredClone(state.catalog),
      write: async (catalog) => {
        const stage = catalog.state;
        if (crash === `before-${stage}`) throw new Error(crash);
        state.catalog = structuredClone(catalog);
        writes.push(stage);
        if (crash === `after-${stage}`) throw new Error(crash);
      },
    },
    backup: async (value) => {
      backup = structuredClone(value);
    },
    verifyBackup: async (value) => {
      assert.equal(JSON.stringify(backup), JSON.stringify(value));
    },
    writeConfig: async (config) => {
      if (crash === "before-config") throw new Error(crash);
      state.config = structuredClone(config);
      writes.push("config");
      if (crash === "after-config") throw new Error(crash);
    },
    verifyRuntime: async () => {
      if (crash === "runtime") throw new Error("incompatible runtime");
    },
  };
  return {
    state,
    plan,
    deps,
    writes,
    crash: (value: string) => {
      crash = value;
    },
  };
}

test("saved migration plans preserve IDs, aliases, archives, and explicit missing classification", () => {
  const source = fixture();
  const original = structuredClone(source);
  const plan = buildCatalogMigration(source, assignments(), ids());
  const restored = decodeCatalogMigrationPlan(JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(restored, plan);
  assert.deepEqual(source, original);
  const projects = Object.values(plan.catalog.projects);
  const api = projects.find((p) => p.name === "API")!;
  assert.equal(api.description, null);
  assert.ok(api.aliases.includes("old-api"));
  assert.deepEqual(resolveTaskMembership(plan.catalog, source.issues[0]), {
    kind: "project",
    projectId: api.id,
  });
  const maintenance = projects.find((p) => p.name === "Maintenance")!;
  assert.equal(maintenance.archived, true);
  assert.equal(maintenance.areaId, null);
  assert.equal(plan.diagnostics.unscopedTasks, 1);
  assert.deepEqual(plan.diagnostics.unclassifiedProjects, [maintenance.id]);
});
test("migration refuses missing assignments, alias cycles, ambiguity, and existing project references", () => {
  const incomplete = assignments();
  incomplete.projects.pop();
  assert.throws(
    () => buildCatalogMigration(fixture(), incomplete, ids()),
    /assignment/i,
  );
  const cyclic = fixture();
  cyclic.renames.aliases = { a: "b", b: "a" };
  assert.throws(
    () => buildCatalogMigration(cyclic, assignments(), ids()),
    /alias/i,
  );
  const ambiguous = fixture();
  ambiguous.issues[0].labels.push("workstream:Maintenance");
  assert.throws(
    () => buildCatalogMigration(ambiguous, assignments(), ids()),
    /membership/i,
  );
  const referenced = fixture();
  referenced.issues[0].projectReference = {
    kind: "valid",
    projectId: "11111111-1111-4111-8111-000000000001",
  };
  assert.throws(
    () => buildCatalogMigration(referenced, assignments(), ids()),
    /reference/i,
  );
});
test("source fingerprint ignores incidental labels but detects relevant changes", () => {
  const source = fixture();
  const plan = buildCatalogMigration(source, assignments(), ids());
  source.issues.reverse();
  source.issues[0].labels.push("needs:jp");
  assert.doesNotThrow(() => verifyMigrationSource(plan, source));
  source.issues.push({ id: "zz-new", status: "open", labels: [] });
  assert.throws(() => verifyMigrationSource(plan, source), /source.*changed/i);
  const changed = fixture();
  changed.config!.ddAuthPath = "/bin/false";
  assert.throws(
    () => verifyMigrationSource(plan, changed),
    /configuration.*changed/i,
  );
  const tampered = structuredClone(plan);
  Object.values(tampered.catalog.projects)[0].description = "Unreviewed";
  assert.throws(() => decodeCatalogMigrationPlan(tampered), /checksum/i);
});
test("prepare and activate apply a saved plan without touching task data", async (t) => {
  const h = await harness(t);
  const oldTasks = structuredClone(h.state.issues);
  await prepareCatalogMigration(h.plan, h.deps);
  await prepareCatalogMigration(h.plan, h.deps);
  assert.equal(h.state.catalog!.state, "prepared");
  assert.equal(h.state.config!.version, 1);
  assert.equal(workRoutingMode(h.state.config, h.state.catalog), "legacy");
  await activateCatalogMigration(h.plan, h.deps);
  await activateCatalogMigration(h.plan, h.deps);
  assert.equal(h.state.catalog!.state, "active");
  assert.equal(h.state.catalog!.revision, 1);
  assert.equal(h.state.config!.version, 2);
  assert.deepEqual(h.writes, ["prepared", "config", "active"]);
  assert.deepEqual(h.state.issues, oldTasks);
});
for (const crash of [
  "before-prepared",
  "after-prepared",
  "before-config",
  "after-config",
  "before-active",
  "after-active",
]) {
  test(`interrupted migration ${crash} resumes only the exact saved plan`, async (t) => {
    const h = await harness(t);
    const oldTasks = structuredClone(h.state.issues);
    if (crash.includes("prepared")) {
      h.crash(crash);
      await assert.rejects(
        prepareCatalogMigration(h.plan, h.deps),
        new RegExp(crash),
      );
    } else {
      await prepareCatalogMigration(h.plan, h.deps);
      h.crash(crash);
      await assert.rejects(
        activateCatalogMigration(h.plan, h.deps),
        new RegExp(crash),
      );
    }
    if (crash === "after-config" || crash === "before-active") {
      assert.equal(h.state.catalog!.state, "prepared");
      assert.equal(h.state.config!.version, 2);
      let taskWrites = 0;
      const store = createLifecycleStore(
        async () => {
          taskWrites++;
          throw new Error("unexpected task write");
        },
        {
          store: h.state.store,
          readCatalog: async () => h.state.catalog,
          readWorkManagementConfig: () => h.state.config,
        },
      );
      await assert.rejects(
        store.create(
          {
            title: "Blocked",
            why: "Partial activation",
            workstream: "api",
            needsJp: false,
          },
          createActionableLifecycle("2026-01-01T00:00:00Z"),
          {
            pid: process.pid,
            host: hostname(),
            sessionId: "fixture",
            started: Date.now(),
          },
        ),
        /catalog/i,
      );
      assert.equal(taskWrites, 0);
    }
    assert.deepEqual(h.state.issues, oldTasks);
    h.crash("");
    if (h.state.config?.version !== 2)
      await prepareCatalogMigration(h.plan, h.deps);
    await activateCatalogMigration(h.plan, h.deps);
    assert.equal(h.state.catalog!.state, "active");
    assert.deepEqual(h.state.issues, oldTasks);
  });
}
test("activation refuses changed task snapshots, prepared catalogs, and incompatible runtime", async (t) => {
  const h = await harness(t);
  await prepareCatalogMigration(h.plan, h.deps);
  h.state.issues.push({ id: "zz-new", status: "open", labels: [] });
  await assert.rejects(
    activateCatalogMigration(h.plan, h.deps),
    /source.*changed/i,
  );
  h.state.issues.pop();
  h.state.catalog!.revision++;
  await assert.rejects(
    activateCatalogMigration(h.plan, h.deps),
    /prepared catalog/i,
  );
  h.state.catalog!.revision--;
  h.crash("runtime");
  await assert.rejects(
    activateCatalogMigration(h.plan, h.deps),
    /incompatible runtime/,
  );
  assert.equal(h.state.config!.version, 1);
  assert.deepEqual(h.writes, ["prepared"]);
});

for (const interrupted of [false, true]) {
  test(`status changes do not strand ${interrupted ? "partial v2 activation" : "prepared v1 migration"}`, async (t) => {
    const h = await harness(t);
    await prepareCatalogMigration(h.plan, h.deps);
    if (interrupted) {
      h.crash("after-config");
      await assert.rejects(
        activateCatalogMigration(h.plan, h.deps),
        /after-config/,
      );
      assert.throws(
        () => workRoutingMode(h.state.config, h.state.catalog),
        /catalog/i,
      );
      h.crash("");
    }
    h.state.issues[0].status = "closed";
    h.state.issues[1].status = "open";
    h.state.issues[2].status = "deferred";
    const currentTasks = structuredClone(h.state.issues);
    if (!interrupted) await prepareCatalogMigration(h.plan, h.deps);
    await activateCatalogMigration(h.plan, h.deps);
    assert.equal(h.state.catalog!.state, "active");
    assert.deepEqual(h.state.catalog!.projects, h.plan.catalog.projects);
    assert.deepEqual(h.state.issues, currentTasks);
  });
}

test("partial activation still refuses classification and destination changes", async (t) => {
  const h = await harness(t);
  await prepareCatalogMigration(h.plan, h.deps);
  h.crash("after-config");
  await assert.rejects(
    activateCatalogMigration(h.plan, h.deps),
    /after-config/,
  );
  h.crash("");
  const original = structuredClone(h.state.issues[0]);
  for (const changed of [
    { ...original, labels: ["workstream:Maintenance"] },
    {
      ...original,
      capturedDestination: { ...target, projectId: "different-project" },
    },
  ]) {
    h.state.issues[0] = changed;
    await assert.rejects(
      activateCatalogMigration(h.plan, h.deps),
      /source.*changed/i,
    );
    assert.equal(h.state.catalog!.state, "prepared");
  }
});
