import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { registerProjectCommands } from "./projects.js";
import { createCatalogService } from "../../lib/work-catalog/service.js";
import {
  A,
  P,
  NEW,
  catalogFixture,
} from "../../lib/work-catalog/test-fixtures.js";
import type { WorkCatalog, WorkScope } from "../../lib/work-catalog/model.js";

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const path = await mkdtemp(join(tmpdir(), "catalog-ui-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  let value: WorkCatalog | null = catalogFixture();
  const store = {
    read: async () => structuredClone(value),
    write: async (c: WorkCatalog) => {
      value = structuredClone(c);
    },
  };
  const service = createCatalogService({
    client: { listIssues: async () => ({ ok: true as const, value: [] }) },
    store,
    storePath: path,
    uuid: () => NEW,
  });
  const commands = new Map<string, any>();
  const choices: Array<string | undefined> = [];
  const texts: Array<string | undefined> = [];
  const shown: string[][] = [];
  const notices: string[] = [];
  const confirmations: string[] = [];
  const selections: WorkScope[] = [];
  let legacyCalls = 0;
  const context: any = {
    cwd: path,
    sessionManager: {
      getSessionId: () => "ui",
      getEntries: () => [],
      getSessionName: () => undefined,
    },
    ui: {
      select: async (_title: string, items: string[]) => {
        shown.push(items);
        const next = choices.shift();
        return next === undefined
          ? undefined
          : items.find((item) => item === next || item.includes(next));
      },
      input: async () => texts.shift(),
      editor: async () => texts.shift(),
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        return true;
      },
      notify: (message: string) => notices.push(message),
    },
  };
  registerProjectCommands(
    { registerCommand: (name, command) => commands.set(name, command) },
    {
      catalog: store,
      service,
      issues: async () => [],
      owner: () => ({
        pid: process.pid,
        sessionId: "ui",
        host: hostname(),
        started: Date.now(),
      }),
      select: (scope) => {
        selections.push(scope);
      },
      legacy: async () => {
        legacyCalls++;
      },
    },
  );
  return {
    choices,
    texts,
    shown,
    notices,
    confirmations,
    selections,
    store,
    legacyCalls: () => legacyCalls,
    setCatalog: (c: WorkCatalog | null) => {
      value = c;
    },
    run: (name: string, args = "") => commands.get(name).handler(args, context),
  };
}
test("project picker includes described empty projects grouped by area", async (t) => {
  const h = await harness(t);
  h.choices.push("API");
  await h.run("project");
  assert.ok(
    h.shown[0].some(
      (label) =>
        label.includes("Product") &&
        label.includes("API") &&
        label.includes("API consistency"),
    ),
  );
  assert.deepEqual(h.selections, [{ kind: "project", projectId: P }]);
});
test("area picker selects a rollup without creating a project", async (t) => {
  const h = await harness(t);
  h.choices.push("Product");
  await h.run("area");
  assert.deepEqual(h.selections, [{ kind: "area", areaId: A }]);
  assert.equal(Object.keys((await h.store.read())!.projects).length, 2);
});
test("project creation collects description and area before creating and selecting", async (t) => {
  const h = await harness(t);
  h.texts.push("New project", "A distinct effort.");
  h.choices.push("Product");
  await h.run("project", "create");
  assert.equal(
    (await h.store.read())!.projects[NEW].description,
    "A distinct effort.",
  );
  assert.equal((await h.store.read())!.projects[NEW].areaId, A);
  assert.deepEqual(h.selections, [{ kind: "project", projectId: NEW }]);
});
test("project management renames by ID and supports archive then restore", async (t) => {
  const h = await harness(t);
  h.choices.push("API");
  h.texts.push("Renamed");
  await h.run("project", "rename");
  assert.equal((await h.store.read())!.projects[P].name, "Renamed");
  assert.equal((await h.store.read())!.projects[P].workstreamKey, "api");
  h.choices.push("Renamed", "Archive");
  await h.run("project", "manage");
  assert.equal((await h.store.read())!.projects[P].archived, true);
  h.choices.push("Renamed", "Restore");
  await h.run("project", "archived");
  assert.equal((await h.store.read())!.projects[P].archived, false);
});
test("legacy mode stays available and cancelled creation leaves no records", async (t) => {
  const h = await harness(t);
  await h.run("project", "create");
  assert.equal((await h.store.read())!.revision, 0);
  h.setCatalog(null);
  await h.run("project");
  await h.run("area");
  assert.equal(h.legacyCalls(), 1);
  assert.ok(h.notices.some((n) => /catalog/i.test(n)));
  assert.equal(h.selections.length, 0);
});

test("invalid creation reports an actionable warning without escaping the command", async (t) => {
  const h = await harness(t);
  h.texts.push("", "A description.");
  h.choices.push("Product");
  await h.run("project", "create");
  assert.ok(h.notices.some((message) => /name/i.test(message)));
  assert.equal((await h.store.read())!.revision, 0);
});
test("new areas require an explicit publication selection", async (t) => {
  const h = await harness(t);
  h.texts.push("Local ops", "Local maintenance.");
  h.choices.push("Local-only");
  await h.run("area", "create");
  assert.deepEqual((await h.store.read())!.areas[NEW].publication, {
    mode: "local",
  });
  assert.deepEqual(h.selections, [{ kind: "area", areaId: NEW }]);
});

test("terminal control text never reaches a catalog confirmation dialog", async (t) => {
  const h = await harness(t);
  h.texts.push("New", "Bad\u001b[2Jdescription");
  h.choices.push("Product");
  await h.run("project", "create");
  assert.equal(h.confirmations.length, 0);
  assert.equal((await h.store.read())!.revision, 0);
  assert.ok(h.notices.some((message) => /description/i.test(message)));
});
