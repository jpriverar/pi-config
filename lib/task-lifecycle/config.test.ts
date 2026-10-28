import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadLifecycleConfig } from "./config.js";
import {
  configFixture,
  fixturePolicy,
} from "../task-reconciler/test-fixtures.js";

test("shared policy loader retains existing lifecycle values", async (t) => {
  const f = await configFixture(t);
  assert.deepEqual(loadLifecycleConfig(join(f.root, "lifecycle.json")), {
    ...fixturePolicy,
    lifecycleWriteVersion: 1,
  });
});

for (const version of [1, 2] as const) {
  test(`accepts explicit lifecycle write version ${version}`, async (t) => {
    const f = await configFixture(t);
    const path = join(f.root, "lifecycle.json");
    await writeFile(
      path,
      JSON.stringify({ ...fixturePolicy, lifecycleWriteVersion: version }),
    );

    assert.equal(loadLifecycleConfig(path).lifecycleWriteVersion, version);
  });
}

test("rejects unsupported lifecycle write versions", async (t) => {
  const f = await configFixture(t);
  const path = join(f.root, "lifecycle.json");
  for (const lifecycleWriteVersion of [0, 3, "2", null]) {
    await writeFile(
      path,
      JSON.stringify({ ...fixturePolicy, lifecycleWriteVersion }),
    );
    assert.throws(() => loadLifecycleConfig(path), /lifecycleWriteVersion/);
  }
});

test("shared policy loader rejects unknown versions, fields, and nonpositive values", async (t) => {
  const f = await configFixture(t);
  const path = join(f.root, "lifecycle.json");
  for (const invalid of [
    { ...fixturePolicy, version: 2 },
    { ...fixturePolicy, prPollIntervalMs: 0 },
    { ...fixturePolicy, unexpected: true },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    assert.throws(() => loadLifecycleConfig(path), /task lifecycle config/);
  }
  await writeFile(path, "private-policy-value");
  assert.throws(
    () => loadLifecycleConfig(path),
    (e: any) =>
      /task lifecycle config/.test(e.message) &&
      !e.message.includes("private-policy-value"),
  );
});
