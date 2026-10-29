import assert from "node:assert/strict";
import test from "node:test";
import { fixture, session } from "./v2-service-test-fixtures.js";
import { state, OWNER } from "./v2-test-fixtures.js";
import { validateLifecycleV2 } from "./v2-model.js";

const unmanaged = (row: Record<string, any>) => {
  delete row.metadata.piLifecycle;
};

test("explicit claim initializes safe unmanaged work without changing unrelated task data", async (t) => {
  const h = await fixture(t, [{ id: "jp-old", lifecycle: state() }]);
  const row = h.records.get("jp-old")!;
  unmanaged(row);
  row.metadata.custom = { retain: true };
  row.labels = ["workstream:legacy", "existing-label"];
  const before = structuredClone(row);
  const result = await h.sut.claim("jp-old", session(), "claim-old");
  assert.equal(result.lifecycle?.version, 2);
  if (result.lifecycle?.version !== 2) throw new Error("missing v2");
  assert.equal(result.lifecycle.phase, "active");
  assert.equal(result.lifecycle.owner?.sessionId, OWNER.sessionId);
  assert.equal(result.lifecycle.condition, null);
  validateLifecycleV2(result.lifecycle, {
    ...result,
    lifecycle: result.lifecycle,
  });
  const stored = h.records.get("jp-old")!;
  assert.deepEqual(stored.metadata.custom, before.metadata.custom);
  assert.deepEqual(stored.labels, before.labels);
  assert.equal(stored.description, before.description);
  await h.sut.claim("jp-old", session(), "claim-old");
  assert.equal(h.writes.length, 1);
});

test("claiming unmanaged dependency-blocked work acquires responsibility without starting it or dropping its gate", async (t) => {
  const h = await fixture(t, [
    {
      id: "jp-old",
      lifecycle: state(),
      dependencies: [
        { id: "jp-blocker", dependencyType: "blocks", status: "open" },
      ],
    },
  ]);
  unmanaged(h.records.get("jp-old")!);
  const result = await h.sut.claim("jp-old", session(), "claim-old");
  if (result.lifecycle?.version !== 2) throw new Error("missing v2");
  assert.equal(result.lifecycle.phase, "waiting");
  assert.equal(result.lifecycle.owner?.sessionId, OWNER.sessionId);
  assert.equal(result.lifecycle.condition?.kind, "dependency");
  assert.equal(result.lifecycle.condition?.purpose, "completion");
  assert.ok(result.lifecycle.pause);
  assert.equal(result.status, "open");
  assert.equal(result.dependencies[0].id, "jp-blocker");
  validateLifecycleV2(result.lifecycle, {
    ...result,
    lifecycle: result.lifecycle,
  });
  await assert.rejects(
    h.sut.close(
      "jp-old",
      { kind: "completed", reason: "Try completion", evidenceArtifactIds: [] },
      session(),
      "premature-close",
    ),
    /unmet|unresolved|requirement/,
  );
});

for (const status of [
  "blocked",
  "in_progress",
  "closed",
  "deferred",
] as const) {
  test(`unmanaged ${status} is refused rather than guessing ownership or a condition`, async (t) => {
    const h = await fixture(t, [{ id: "jp-old", lifecycle: state(), status }]);
    unmanaged(h.records.get("jp-old")!);
    await assert.rejects(
      h.sut.claim("jp-old", session(), "claim-old"),
      /cannot initialize.*tracking.*native.*review/i,
    );
    assert.deepEqual(h.writes, []);
  });
}

test("initialization cannot bypass native readiness", async (t) => {
  const h = await fixture(t, [{ id: "jp-old", lifecycle: state() }]);
  unmanaged(h.records.get("jp-old")!);
  h.store.readyIds = async () => new Set();
  await assert.rejects(
    h.sut.claim("jp-old", session(), "claim-old"),
    /not natively ready/,
  );
  assert.deepEqual(h.writes, []);
  assert.equal(
    Object.hasOwn(h.records.get("jp-old")!.metadata, "piLifecycle"),
    false,
  );
});

test("concurrent unmanaged claims still enforce one task per owning session", async (t) => {
  const h = await fixture(
    t,
    ["jp-a", "jp-b"].map((id) => ({ id, lifecycle: state() })),
  );
  for (const row of h.records.values()) unmanaged(row);
  const results = await Promise.allSettled([
    h.sut.claim("jp-a", session(), "claim-a"),
    h.sut.claim("jp-b", session(), "claim-b"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = results.find((result) => result.status === "rejected");
  assert.ok(failure?.status === "rejected");
  assert.match(failure.reason.message, /already owns/);
  assert.equal(h.writes.length, 1);
});

for (const malformed of [null, { version: 99 }, { version: 2 }]) {
  test(`present invalid metadata is never treated as unmanaged (${JSON.stringify(malformed)})`, async (t) => {
    const h = await fixture(t, [{ id: "jp-old", lifecycle: state() }]);
    h.records.get("jp-old")!.metadata.piLifecycle = malformed;
    await assert.rejects(
      h.sut.claim("jp-old", session(), "claim-old"),
      /invalid or unsupported/,
    );
    assert.deepEqual(h.writes, []);
  });
}
