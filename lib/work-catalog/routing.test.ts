import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCreateProject,
  resolveNewTaskTarget,
  workRoutingMode,
} from "./routing.js";
import { A, B, P, Q, NEW, catalogFixture } from "./test-fixtures.js";
const v1 = {
  version: 1 as const,
  ddAuthPath: "/bin/dd-auth",
  curlPath: "/bin/curl",
  workstreams: {},
};
const v2 = {
  version: 2 as const,
  routingMode: "catalog" as const,
  ddAuthPath: "/bin/dd-auth",
  curlPath: "/bin/curl",
};

test("catalog mode requires a compatible active catalog/config pair", () => {
  const catalog = catalogFixture();
  assert.equal(workRoutingMode(v1, null), "legacy");
  assert.equal(workRoutingMode(null, null), "legacy");
  assert.equal(
    workRoutingMode(v1, { ...catalog, state: "prepared" }),
    "legacy",
  );
  assert.equal(workRoutingMode(v2, catalog), "catalog");
  for (const [config, current] of [
    [v2, null],
    [v2, { ...catalog, state: "prepared" }],
    [v1, catalog],
    [null, catalog],
  ] as const) {
    assert.throws(
      () => workRoutingMode(config, current),
      /catalog|configuration/i,
    );
  }
});
test("project scope inherits only its own project; broader scopes require explicit placement", () => {
  const c = catalogFixture();
  assert.equal(
    resolveCreateProject(c, { kind: "project", projectId: P }, {}).id,
    P,
  );
  assert.equal(
    resolveCreateProject(c, { kind: "area", areaId: A }, { workstream: "API" })
      .id,
    P,
  );
  assert.equal(
    resolveCreateProject(c, { kind: "global" }, { projectId: Q }).id,
    Q,
  );
  assert.throws(() => resolveCreateProject(c, { kind: "area", areaId: A }, {}));
  assert.throws(() => resolveCreateProject(c, { kind: "global" }, {}));
  assert.throws(() =>
    resolveCreateProject(
      c,
      { kind: "project", projectId: P },
      { projectId: Q },
    ),
  );
  assert.throws(() =>
    resolveCreateProject(c, { kind: "area", areaId: B }, { projectId: P }),
  );
  assert.throws(() =>
    resolveCreateProject(
      c,
      { kind: "global" },
      { projectId: P, workstream: "Maintenance" },
    ),
  );
});
test("unclassified, archived and unknown destinations never produce a task target", () => {
  for (const change of [
    (c: any) => (c.projects[P].areaId = null),
    (c: any) => (c.projects[P].archived = true),
    (c: any) => (c.areas[A].archived = true),
  ]) {
    const c = catalogFixture();
    change(c);
    assert.throws(() =>
      resolveCreateProject(c, { kind: "global" }, { projectId: P }),
    );
    assert.throws(() => resolveNewTaskTarget(c, c.projects[P]));
  }
  assert.throws(() =>
    resolveCreateProject(
      catalogFixture(),
      { kind: "global" },
      { projectId: NEW },
    ),
  );
});
test("all projects inherit area publication, not their names", () => {
  const c = catalogFixture();
  assert.deepEqual(
    resolveNewTaskTarget(c, c.projects[P]),
    resolveNewTaskTarget(c, c.projects[Q]),
  );
  c.projects[P].name = "unrelated words";
  assert.deepEqual(
    resolveNewTaskTarget(c, c.projects[P]),
    resolveNewTaskTarget(c, c.projects[Q]),
  );
  c.projects[P].areaId = B;
  assert.equal(resolveNewTaskTarget(c, c.projects[P]), null);
});
