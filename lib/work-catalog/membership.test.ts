import assert from "node:assert/strict";
import test from "node:test";
import { createBeadsClient } from "../beads.js";
import { newWorkManagementState } from "../work-management/model.js";
import { target } from "../work-management/test-fixtures.js";
import {
  decodeProjectReference,
  resolveTaskMembership,
  matchesWorkScope,
  scopeKey,
} from "./membership.js";
import { A, B, P, Q, NEW, catalogFixture } from "./test-fixtures.js";
import type { CatalogIssue } from "./model.js";
const issue = (labels: string[] = []): CatalogIssue => ({
  id: "zz-1",
  status: "open",
  labels,
});

test("task references distinguish absence from corrupt metadata", () => {
  assert.deepEqual(decodeProjectReference({}), { kind: "absent" });
  assert.deepEqual(
    decodeProjectReference({ piProject: { version: 1, projectId: P } }),
    { kind: "valid", projectId: P },
  );
  for (const value of [
    null,
    {},
    { version: 2, projectId: P },
    { version: 1, projectId: "bad" },
    { version: 1, projectId: P, areaId: A },
  ]) {
    assert.equal(decodeProjectReference({ piProject: value }).kind, "invalid");
  }
});
test("legacy membership resolves aliases once and preserves unscoped work", () => {
  const catalog = catalogFixture();
  catalog.projects[P].aliases = ["old-api"];
  for (const labels of [
    ["workstream:API"],
    ["workstream:old-api"],
    ["workstream:api", "workstream:OLD-API"],
  ]) {
    assert.deepEqual(resolveTaskMembership(catalog, issue(labels)), {
      kind: "project",
      projectId: P,
    });
  }
  assert.deepEqual(resolveTaskMembership(catalog, issue(["needs:jp"])), {
    kind: "unscoped",
  });
  for (const labels of [
    ["workstream:unknown"],
    ["workstream:api", "workstream:maintenance"],
    ["workstream:api", "workstream:unknown"],
  ]) {
    assert.equal(resolveTaskMembership(catalog, issue(labels)).kind, "invalid");
  }
});
test("authoritative references never silently fall back on conflicting labels", () => {
  const catalog = catalogFixture();
  const managed = {
    ...issue(["workstream:api"]),
    projectReference: { kind: "valid" as const, projectId: P },
  };
  assert.deepEqual(resolveTaskMembership(catalog, managed), {
    kind: "project",
    projectId: P,
  });
  assert.deepEqual(resolveTaskMembership(catalog, { ...managed, labels: [] }), {
    kind: "project",
    projectId: P,
  });
  for (const changed of [
    {
      ...managed,
      projectReference: { kind: "invalid" as const, reason: "bad metadata" },
    },
    {
      ...managed,
      projectReference: { kind: "valid" as const, projectId: NEW },
    },
    { ...managed, labels: ["workstream:maintenance"] },
  ])
    assert.equal(resolveTaskMembership(catalog, changed).kind, "invalid");
});
test("area and project filters exclude unscoped or invalid work without broadening scope", () => {
  const catalog = catalogFixture();
  assert.equal(
    matchesWorkScope(
      catalog,
      { kind: "project", projectId: P },
      { kind: "area", areaId: A },
    ),
    true,
  );
  assert.equal(
    matchesWorkScope(
      catalog,
      { kind: "project", projectId: P },
      { kind: "area", areaId: B },
    ),
    false,
  );
  assert.equal(
    matchesWorkScope(
      catalog,
      { kind: "project", projectId: P },
      { kind: "project", projectId: Q },
    ),
    false,
  );
  for (const membership of [
    { kind: "unscoped" as const },
    { kind: "invalid" as const, reason: "ambiguous" },
  ]) {
    assert.equal(
      matchesWorkScope(catalog, membership, { kind: "global" }),
      true,
    );
    assert.equal(
      matchesWorkScope(catalog, membership, { kind: "area", areaId: A }),
      false,
    );
  }
  assert.throws(() =>
    matchesWorkScope(
      catalog,
      { kind: "unscoped" },
      { kind: "area", areaId: NEW },
    ),
  );
  assert.notEqual(
    scopeKey({ kind: "area", areaId: A }),
    scopeKey({ kind: "project", projectId: A }),
  );
});
test("Beads decodes only bounded project identity and captured destination projections", async () => {
  const wm = newWorkManagementState(target, "title", "description", "api");
  const raw = {
    id: "zz-1",
    title: "title",
    status: "open",
    labels: ["workstream:api"],
    metadata: {
      piProject: { version: 1, projectId: P },
      piWorkManagement: wm,
      private: "not for presentation",
    },
  };
  const client = createBeadsClient(async () => ({
    code: 0,
    stdout: JSON.stringify([raw]),
    stderr: "",
  }));
  const result = await client.showIssues(["zz-1"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value[0].projectReference, {
    kind: "valid",
    projectId: P,
  });
  assert.deepEqual(result.value[0].capturedDestination, {
    site: target.site,
    orgUuid: target.orgUuid,
    projectId: target.projectId,
    typeId: target.typeId,
  });
  assert.equal("metadata" in result.value[0], false);
  raw.metadata.piProject.version = 99;
  const bad = await client.showIssues(["zz-1"]);
  assert.equal(bad.ok && bad.value[0].projectReference?.kind, "invalid");
});
