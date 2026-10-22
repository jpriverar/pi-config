import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { createBeadsClient, type BeadsIssue } from "../beads.js";
import { createCatalogService } from "./service.js";
import { A, B, P, Q, NEW, catalogFixture } from "./test-fixtures.js";
import type { WorkCatalog } from "./model.js";

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  issues: BeadsIssue[] = [],
) {
  const storePath = await mkdtemp(join(tmpdir(), "pi-catalog-service-"));
  t.after(() => rm(storePath, { recursive: true, force: true }));
  let catalog: WorkCatalog | null = catalogFixture();
  let writes = 0;
  const store = {
    read: async () => structuredClone(catalog),
    write: async (value: WorkCatalog) => {
      writes++;
      catalog = structuredClone(value);
    },
  };
  const client = createBeadsClient(
    async (_command, args) => {
      assert.equal(args[0], "list");
      return { code: 0, stdout: JSON.stringify(issues), stderr: "" };
    },
    { env: { BEADS_DIR: storePath } },
  );
  const service = createCatalogService({
    client,
    store,
    storePath,
    uuid: () => NEW,
  });
  const owner = {
    pid: process.pid,
    sessionId: "catalog-test",
    host: hostname(),
    started: Date.now(),
  };
  return { service, store, owner, writes: () => writes };
}
test("create described empty project in an existing area", async (t) => {
  const f = await fixture(t);
  const result = await f.service.apply(
    {
      kind: "create_project",
      name: "New effort",
      description: "A separate effort.",
      areaId: A,
    },
    0,
    f.owner,
  );
  assert.equal(result.entityId, NEW);
  assert.equal(result.revision, 1);
  assert.equal((await f.store.read())!.projects[NEW].areaId, A);
  assert.equal(
    (await f.store.read())!.projects[NEW].description,
    "A separate effort.",
  );
  await assert.rejects(
    f.service.apply(
      {
        kind: "create_project",
        name: "Another",
        description: "Another effort.",
        areaId: A,
      },
      1,
      f.owner,
    ),
    /ID/,
  );
  assert.equal(f.writes(), 1);
});
test("new project requires a description and available area", async (t) => {
  const f = await fixture(t);
  for (const [description, areaId] of [
    ["", A],
    ["A goal", NEW],
  ]) {
    await assert.rejects(
      f.service.apply(
        { kind: "create_project", name: "New", description, areaId },
        0,
        f.owner,
      ),
    );
  }
  assert.equal(f.writes(), 0);
});
test("description and rename preserve identity and compatibility keys", async (t) => {
  const f = await fixture(t);
  const before = await f.store.read();
  await f.service.apply(
    {
      kind: "describe",
      entity: "project",
      id: P,
      description: "New description.",
    },
    0,
    f.owner,
  );
  await f.service.apply(
    { kind: "rename", entity: "project", id: P, name: "New API" },
    1,
    f.owner,
  );
  const current = (await f.store.read())!;
  assert.equal(current.projects[P].workstreamKey, "api");
  assert.ok(current.projects[P].aliases.includes("API"));
  assert.deepEqual(current.areas, before!.areas);
  await assert.rejects(
    f.service.apply(
      { kind: "rename", entity: "project", id: Q, name: "API" },
      2,
      f.owner,
    ),
    /reserved|already/,
  );
  assert.equal(f.writes(), 2);
});
test("concurrent edits reject the stale revision instead of losing a write", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.service.apply(
      { kind: "describe", entity: "project", id: P, description: "First." },
      0,
      f.owner,
    ),
    f.service.apply(
      { kind: "describe", entity: "project", id: Q, description: "Second." },
      0,
      { ...f.owner, sessionId: "second" },
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.writes(), 1);
});
test("archival counts deferred and secondary legacy memberships", async (t) => {
  const f = await fixture(t, [
    {
      id: "zz-1",
      title: "unfinished",
      status: "deferred",
      labels: ["workstream:maintenance", "workstream:API"],
    },
  ]);
  await assert.rejects(
    f.service.apply({ kind: "archive", entity: "project", id: P }, 0, f.owner),
    /unfinished/,
  );
  await assert.rejects(
    f.service.apply({ kind: "archive", entity: "area", id: A }, 0, f.owner),
    /project|unfinished/,
  );
  assert.equal(f.writes(), 0);
});
test("empty project can archive and restore without touching tasks", async (t) => {
  const f = await fixture(t);
  await f.service.apply(
    { kind: "archive", entity: "project", id: P },
    0,
    f.owner,
  );
  assert.equal((await f.store.read())!.projects[P].archived, true);
  await f.service.apply(
    { kind: "restore", entity: "project", id: P },
    1,
    f.owner,
  );
  assert.equal((await f.store.read())!.projects[P].archived, false);
});
test("move project changes only its parent without changing area publication", async (t) => {
  const f = await fixture(t);
  const before = await f.store.read();
  await f.service.apply(
    { kind: "move_project", projectId: P, areaId: B },
    0,
    f.owner,
  );
  assert.equal((await f.store.read())!.projects[P].areaId, B);
  assert.deepEqual((await f.store.read())!.areas, before!.areas);
});
test("creation cannot use an archived area or omit an area description", async (t) => {
  const f = await fixture(t);
  const c = (await f.store.read())!;
  c.areas[A].archived = true;
  await f.store.write(c);
  await assert.rejects(
    f.service.apply(
      {
        kind: "create_project",
        name: "No",
        description: "Cannot enter archive",
        areaId: A,
      },
      0,
      f.owner,
    ),
  );
  await assert.rejects(
    f.service.apply(
      {
        kind: "create_area",
        name: "No",
        description: "",
        publication: { mode: "local" },
      },
      0,
      f.owner,
    ),
  );
});
