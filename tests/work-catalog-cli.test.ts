import assert from "node:assert/strict";
import test from "node:test";
import { parseCatalogArguments } from "../scripts/work-catalog.js";

test("migration CLI requires explicit store and exact action-specific inputs", () => {
  const parsed = parseCatalogArguments([
    "preview",
    "--store",
    "/tmp/store with spaces",
    "--assignments",
    "/tmp/input.json",
    "--output",
    "/tmp/plan.json",
  ]);
  assert.equal(parsed.action, "preview");
  assert.equal(parsed.values.get("store"), "/tmp/store with spaces");
  assert.throws(() =>
    parseCatalogArguments([
      "preview",
      "--assignments",
      "/tmp/input.json",
      "--output",
      "/tmp/plan.json",
    ]),
  );
  assert.throws(() =>
    parseCatalogArguments([
      "activate",
      "--store",
      "/tmp/store",
      "--plan",
      "/tmp/plan.json",
    ]),
  );
  assert.equal(
    parseCatalogArguments([
      "activate",
      "--store",
      "/tmp/store",
      "--plan",
      "/tmp/plan.json",
      "--runtime",
      "/tmp/runtime",
    ]).action,
    "activate",
  );
});
test("migration CLI has no force or inferred-default escape hatch", () => {
  for (const args of [
    ["prepare", "--store", "/tmp/store", "--store", "/tmp/other"],
    [
      "prepare",
      "--store",
      "/tmp/store",
      "--plan",
      "/tmp/plan",
      "--force",
      "true",
    ],
    ["prepare", "--store", "/tmp/store\u0000", "--plan", "/tmp/plan"],
    [
      "activate",
      "--store",
      "/tmp/store",
      "--plan",
      "/tmp/plan",
      "--approved",
      "true",
    ],
    ["rollback", "--store", "/tmp/store", "--plan", "/tmp/plan"],
  ])
    assert.throws(() => parseCatalogArguments(args));
});
