import { encodeWorkCatalog } from "./model.js";
import { classifyReadiness } from "../beads.js";
import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkView } from "./membership.js";
import {
  listCatalogEntities,
  getCatalogEntity,
  presentWorkIssues,
} from "./presentation.js";
import { A, B, P, Q, catalogFixture } from "./test-fixtures.js";
const issues = [
  { id: "zz-1", status: "open", labels: ["workstream:api"] },
  { id: "zz-2", status: "closed", labels: ["workstream:maintenance"] },
  { id: "zz-3", status: "open", labels: [] },
  { id: "zz-4", status: "open", labels: ["workstream:unknown"] },
];
test("shared view scopes membership and retains diagnostics only globally", () => {
  const catalog = catalogFixture();
  assert.deepEqual(
    buildWorkView(catalog, issues, { kind: "area", areaId: A }).issues.map(
      (i) => i.id,
    ),
    ["zz-1", "zz-2"],
  );
  assert.deepEqual(
    buildWorkView(catalog, issues, {
      kind: "project",
      projectId: P,
    }).issues.map((i) => i.id),
    ["zz-1"],
  );
  const global = buildWorkView(catalog, issues, { kind: "global" });
  assert.equal(global.issues.length, 4);
  assert.deepEqual(
    global.diagnostics.map((d) => d.taskId),
    ["zz-4"],
  );
  assert.equal(global.projects.find((p) => p.project.id === P)!.unfinished, 1);
});
test("empty projects stay visible and reopened work reveals archived parents", () => {
  const c = catalogFixture();
  assert.equal(buildWorkView(c, [], { kind: "global" }).projects.length, 2);
  c.areas[A].archived = true;
  c.projects[P].archived = true;
  c.projects[Q].archived = true;
  const closed = buildWorkView(c, [], { kind: "global" });
  assert.equal(closed.areas.find((a) => a.area.id === A)!.hidden, true);
  const reopened = buildWorkView(c, issues, { kind: "global" });
  assert.equal(
    reopened.projects.find((p) => p.project.id === P)!.hidden,
    false,
  );
  assert.equal(reopened.areas.find((a) => a.area.id === A)!.hidden, false);
});
test("safe entity listings include descriptions without exposing target configuration", () => {
  const c = catalogFixture();
  c.projects[P].description = "x".repeat(1024);
  const page = listCatalogEntities(c, issues, "project", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.items[0].description.length, 256);
  assert.equal(page.items[0].areaId, A);
  assert.equal(page.items[0].areaName, "Product");
  assert.equal("target" in page.items[0], false);
  assert.equal(
    getCatalogEntity(c, issues, "project", P).description.length,
    1024,
  );
  assert.equal(
    listCatalogEntities(c, issues, "area", { query: "personal" }).items[0].id,
    B,
  );
  assert.throws(() => listCatalogEntities(c, issues, "project", { limit: 21 }));
});
test("destination mismatch is visible without rewriting any task", () => {
  const c = catalogFixture();
  const area = c.areas[A];
  if (area.publication.mode !== "datadog") throw new Error("fixture");
  const { site, orgUuid, projectId, typeId } = area.publication.target;
  const row = {
    ...issues[0],
    capturedDestination: { site, orgUuid, projectId, typeId },
  };
  c.projects[P].areaId = B;
  assert.equal(
    getCatalogEntity(c, [row], "project", P).destinationMismatches,
    1,
  );
  assert.equal(row.capturedDestination.projectId, projectId);
});

test("area unfinished counts include ambiguous legacy memberships only once", () => {
  const c = catalogFixture();
  const rows = [
    {
      id: "zz-multi",
      status: "open",
      labels: ["workstream:api", "workstream:maintenance"],
    },
  ];
  assert.equal(getCatalogEntity(c, rows, "area", A).unfinished, 1);
});

test("reopened work reports archived project and area warnings", () => {
  const c = catalogFixture();
  c.areas[A].archived = true;
  c.projects[P].archived = true;
  const rows = classifyReadiness(
    [{ ...issues[0], status: "open", title: "Reopened" }],
    new Set(["zz-1"]),
  );
  const shown = presentWorkIssues(
    {
      kind: "catalog",
      catalog: c,
      scope: { kind: "area", areaId: A },
      key: `area:${A}`,
    },
    rows,
  );
  assert.match(shown[0].warnings.join(" "), /Project is archived/);
  assert.match(shown[0].warnings.join(" "), /Area is archived/);
  assert.equal(getCatalogEntity(c, rows, "project", P).areaArchived, true);
  assert.deepEqual(rows[0].warnings, []);
});
test("tasks warn about previous destinations even without a renderable remote link", () => {
  const c = catalogFixture();
  const publication = c.areas[A].publication;
  if (publication.mode !== "datadog") throw new Error("fixture");
  const { site, orgUuid, projectId, typeId } = publication.target;
  c.projects[P].areaId = B;
  const rows = classifyReadiness(
    [
      {
        ...issues[0],
        status: "open",
        title: "Old binding",
        capturedDestination: { site, orgUuid, projectId, typeId },
      },
    ],
    new Set(["zz-1"]),
  );
  const shown = presentWorkIssues(
    {
      kind: "catalog",
      catalog: c,
      scope: { kind: "area", areaId: B },
      key: `area:${B}`,
    },
    rows,
  );
  assert.match(shown[0].warnings.join(" "), /previous destination/);
  assert.equal(shown[0].capturedDestination!.projectId, projectId);
  assert.deepEqual(rows[0].warnings, []);
});
test("area destination counts deduplicate ambiguous legacy references", () => {
  const c = catalogFixture();
  const old = c.areas[A].publication;
  if (old.mode !== "datadog") throw new Error("fixture");
  const { site, orgUuid, projectId, typeId } = old.target;
  c.areas[A].publication = { mode: "local" };
  const rows = [
    {
      id: "zz-multi",
      status: "open",
      labels: ["workstream:api", "workstream:maintenance"],
      capturedDestination: { site, orgUuid, projectId, typeId },
    },
  ];
  assert.equal(getCatalogEntity(c, rows, "area", A).destinationMismatches, 1);
});
test("unscoped task IDs cannot inherit object prototype project names", () => {
  const c = catalogFixture();
  const rows = classifyReadiness(
    [{ id: "constructor", status: "open", title: "Legacy", labels: [] }],
    new Set(["constructor"]),
  );
  const shown = presentWorkIssues(
    { kind: "catalog", catalog: c, scope: { kind: "global" }, key: "global" },
    rows,
  );
  assert.deepEqual(shown[0].workstreams, []);
});
test("get validates entity IDs without echoing unbounded input", () => {
  assert.throws(
    () => getCatalogEntity(catalogFixture(), [], "project", "x".repeat(10000)),
    (error: Error) => error.message.length < 256,
  );
});

test("UTF-8 catalog pages have a byte budget and resumable offsets", () => {
  const c = catalogFixture();
  c.areas[A].name = "🧭".repeat(110);
  c.projects = {};
  for (let i = 1; i <= 20; i++) {
    const id = `33333333-3333-4333-8333-${i.toString(16).padStart(12, "0")}`;
    c.projects[id] = {
      id,
      name: "🧪".repeat(110) + i,
      description: "🧪".repeat(256),
      archived: false,
      areaId: A,
      workstreamKey: `project-${i}`,
      aliases: [],
    };
  }
  assert.ok(Buffer.byteLength(encodeWorkCatalog(c)) <= 63 * 1024);
  const seen = new Set<string>();
  let offset: number | null = 0;
  for (let iteration = 0; iteration < 20 && offset !== null; iteration++) {
    const page = listCatalogEntities(c, [], "project", { offset, limit: 20 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16 * 1024);
    page.items.forEach((row) => seen.add(row.id));
    offset = page.nextOffset;
  }
  assert.equal(offset, null);
  assert.equal(seen.size, 20);
});

test("publication summaries identify the configured destination rather than only the area", () => {
  const c = catalogFixture();
  const policy = c.areas[A].publication;
  if (policy.mode !== "datadog") throw new Error("fixture");
  const before = getCatalogEntity(c, [], "area", A).publication;
  policy.target.projectId = "66666666-6666-4666-8666-666666666666";
  const after = getCatalogEntity(c, [], "area", A).publication;
  assert.notEqual(before, after);
  assert.ok(after.includes(policy.target.projectId));
  assert.ok(after.includes(policy.target.site));
  assert.equal(after.includes("statusMapping"), false);
});
