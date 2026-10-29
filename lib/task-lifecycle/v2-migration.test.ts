import assert from "node:assert/strict";
import test from "node:test";
import { createActionableLifecycle, claimLifecycle } from "./model.js";
import { planLifecycleV2Migration } from "./v2-migration.js";
import { validateLifecycleV2 } from "./v2-model.js";
import { state, withCheck, NOW, OWNER } from "./v2-test-fixtures.js";
import type { LifecycleIssue, LifecycleMetadataV1 } from "./types.js";

function legacy(
  phase: "active" | "actionable" = "active",
): LifecycleMetadataV1 {
  const base = createActionableLifecycle(NOW);
  return phase === "actionable"
    ? base
    : claimLifecycle(base, {
        operationId: "claim",
        sessionId: OWNER.sessionId,
        now: NOW,
        expiresAt: NOW,
        resourceSnapshot: { observedAt: NOW, resourceIds: [] },
      });
}
function issue(
  id = "jp-one",
  lifecycle: LifecycleIssue["lifecycle"] = legacy(),
): LifecycleIssue {
  const phase = lifecycle?.phase;
  return {
    id,
    title: id,
    status:
      phase === "active"
        ? "in_progress"
        : phase === "done"
          ? "closed"
          : phase === "deferred"
            ? "deferred"
            : phase === "waiting" && lifecycle?.activeCheck
              ? "blocked"
              : "open",
    metadata: lifecycle
      ? {
          piLifecycle: lifecycle,
          piProject: { version: 1, projectId: "captured-project" },
          next_step: "Continue",
        }
      : {},
    lifecycle,
    dependencies: [],
  };
}
function checked(phase: "active" | "waiting" = "waiting", satisfied = false) {
  const current = legacy();
  const check = withCheck().activeCheck!;
  return issue("jp-one", {
    ...current,
    phase,
    execution: phase === "active" ? current.execution : null,
    waiting: { kind: "check" },
    activeCheck: {
      ...check,
      ...(satisfied
        ? {
            state: "satisfied" as const,
            lastObservation: "Confirmed",
            lastCheckedAt: NOW,
          }
        : {}),
    },
  });
}
const completion = {
  "jp-one": {
    purpose: "completion" as const,
    reason: "Keep the existing finish requirement",
  },
};

test("conversion preserves active owner and all task evidence without inventing a pause", () => {
  const source = checked("active");
  const before = structuredClone(source);
  const plan = planLifecycleV2Migration([source], completion);
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.proposals.length, 1);
  const converted = plan.proposals[0].lifecycle;
  assert.equal(converted.version, 2);
  assert.deepEqual(converted.owner, OWNER);
  assert.equal(converted.phase, "active");
  assert.equal(converted.pause, null);
  assert.equal(converted.condition?.purpose, "completion");
  for (const field of [
    "artifacts",
    "activeCheck",
    "checkHistory",
    "transitionHistory",
    "resources",
    "stateEnteredAt",
    "lastProgressAt",
    "disposition",
  ] as const)
    assert.deepEqual(converted[field], source.lifecycle![field]);
  validateLifecycleV2(converted, { ...source, lifecycle: converted });
  assert.deepEqual(plan.source, [before]);
  assert.deepEqual(source, before);
});

test("unowned blocked work stays unowned with a condition-bound pause", () => {
  const source = checked();
  const plan = planLifecycleV2Migration([source], completion);
  assert.deepEqual(plan.diagnostics, []);
  const converted = plan.proposals[0].lifecycle;
  assert.equal(converted.owner, null);
  assert.equal(converted.phase, "waiting");
  assert.equal(converted.pause?.blockedAt, NOW);
  assert.ok(converted.pause?.id);
  validateLifecycleV2(converted, { ...source, lifecycle: converted });
});

for (const phase of ["actionable", "deferred", "done"] as const) {
  test(`conversion never reconstructs ${phase} ownership from old claim history`, () => {
    const source = issue("jp-one", {
      ...legacy(),
      execution: null,
      phase,
      disposition:
        phase === "done"
          ? {
              kind: "completed",
              reason: "Done",
              at: NOW,
              evidenceArtifactIds: [],
            }
          : null,
    });
    const plan = planLifecycleV2Migration([source], {});
    assert.deepEqual(plan.diagnostics, []);
    assert.equal(plan.proposals[0].lifecycle.owner, null);
    assert.equal(plan.proposals[0].lifecycle.phase, phase);
    assert.deepEqual(
      plan.proposals[0].lifecycle.disposition,
      source.lifecycle!.disposition,
    );
  });
}

test("native edges remain authoritative and are never duplicated into metadata", () => {
  const source = issue("jp-one", {
    ...legacy("actionable"),
    phase: "waiting",
    waiting: { kind: "dependency" },
  });
  source.dependencies = [
    { id: "jp-blocker", status: "unknown", dependencyType: "blocks" },
  ];
  const blocker = issue("jp-blocker", null);
  const plan = planLifecycleV2Migration([source, blocker], completion);
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.proposals[0].lifecycle.condition?.kind, "dependency");
  assert.deepEqual(plan.source[0].dependencies, source.dependencies);
  assert.equal(plan.unchanged.includes("jp-blocker"), true);
});

for (const purpose of ["completion", "continuation"] as const) {
  test(`satisfied checks keep the explicit ${purpose} classification, not onSatisfied`, () => {
    const source = checked("waiting", true);
    source.lifecycle!.activeCheck!.onSatisfied =
      purpose === "completion" ? "actionable" : "close";
    const plan = planLifecycleV2Migration([source], {
      "jp-one": { purpose, reason: "Reviewed semantics" },
    });
    assert.deepEqual(plan.diagnostics, []);
    assert.equal(plan.proposals[0].lifecycle.condition?.purpose, purpose);
  });
}

for (const [name, source, classifications, diagnostic] of [
  ["missing classification", checked(), {}, /classification/],
  [
    "unmet requirement downgrade",
    checked(),
    { "jp-one": { purpose: "continuation", reason: "Only resume" } },
    /unmet.*completion/,
  ],
  [
    "unexplained classification",
    checked(),
    { "jp-one": { purpose: "completion", reason: " " } },
    /reason/,
  ],
  ["stale classification", issue(), completion, /condition/],
  ["native conflict", { ...issue(), status: "closed" }, {}, /status/],
  [
    "unsupported version",
    { ...issue(), metadata: { piLifecycle: { version: 99 } }, lifecycle: null },
    {},
    /unsupported/,
  ],
  [
    "contradictory decoded record",
    { ...issue(), lifecycle: null },
    {},
    /metadata/,
  ],
  [
    "unsupported automated criterion",
    (() => {
      const s = checked();
      s.lifecycle!.activeCheck = {
        ...s.lifecycle!.activeCheck!,
        kind: "time",
        predicate: { at: NOW, requireCI: true },
      };
      return s;
    })(),
    completion,
    /unsupported.*predicate/,
  ],
] as const) {
  test(`migration blocks ${name}`, () => {
    const plan = planLifecycleV2Migration(
      [source as LifecycleIssue],
      classifications,
    );
    assert.match(plan.diagnostics.join("\n"), diagnostic);
  });
}

test("ownership uniqueness includes existing v2 Done records", () => {
  const done = issue(
    "jp-done",
    state({
      phase: "done",
      owner: OWNER,
      disposition: {
        kind: "completed",
        reason: "Done",
        at: NOW,
        evidenceArtifactIds: [],
      },
    }),
  );
  const plan = planLifecycleV2Migration([issue(), done], {});
  assert.match(plan.diagnostics.join("\n"), /owns multiple tasks/);
});

test("resource ambiguity blocks the plan instead of transferring evidence", () => {
  const source = issue();
  source.lifecycle!.resources = [
    {
      id: "resource",
      kind: "worktree",
      repository: "repo",
      claimId: "claim",
      pathId: "path",
      operationId: "acquire",
      path: null,
      branch: "jpriverar/test",
      branchArtifactId: null,
      acquiredAt: null,
      releasedAt: null,
      cleanupState: "acquiring",
    },
  ];
  const plan = planLifecycleV2Migration([source], {});
  assert.match(plan.diagnostics.join("\n"), /resource.*acquiring/);
});

test("review fingerprint binds all input records and classification rationale", () => {
  const sources = [checked(), issue("jp-unmanaged", null)];
  const first = planLifecycleV2Migration(sources, completion);
  assert.equal(
    first.fingerprint,
    planLifecycleV2Migration([...sources].reverse(), completion).fingerprint,
  );
  const changed = structuredClone(sources);
  changed[1].metadata.next_step = "Changed during review";
  assert.notEqual(
    first.fingerprint,
    planLifecycleV2Migration(changed, completion).fingerprint,
  );
  assert.notEqual(
    first.fingerprint,
    planLifecycleV2Migration(sources, {
      "jp-one": {
        ...completion["jp-one"],
        reason: "A different reviewed decision",
      },
    }).fingerprint,
  );
});

const allStatuses = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
] as const;
async function storeFixture(
  t: import("node:test").TestContext,
  rows: LifecycleIssue[],
  storeVersion: 1 | 2 = 2,
  afterUpdate?: (id: string) => void | Promise<void>,
) {
  const { fixture, session } = await import("./v2-service-test-fixtures.js");
  const h = await fixture(t, [], {
    storeVersion,
    serviceVersion: storeVersion,
    afterUpdate,
  });
  for (const row of rows)
    h.records.set(row.id, {
      ...structuredClone(row),
      labels: [],
      dependencies: row.dependencies.map((dep) => ({
        id: dep.id,
        status: dep.status,
        dependency_type: dep.dependencyType,
      })),
    });
  return { ...h, actor: session("migration-operator") };
}

test("reviewed conversion preserves unrelated metadata and cannot replay a stale plan", async (t) => {
  const source = checked("active");
  const h = await storeFixture(t, [source]);
  const plan = planLifecycleV2Migration(
    await h.store.list(allStatuses),
    completion,
  );
  const saved = await h.store.applyLifecycleV2Migration(
    { ...plan, storePath: h.storePath },
    h.actor,
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].lifecycle?.version, 2);
  assert.deepEqual(saved[0].metadata.piProject, source.metadata.piProject);
  assert.equal(saved[0].metadata.next_step, "Continue");
  assert.equal(saved[0].status, "in_progress");
  assert.deepEqual(
    saved[0].lifecycle?.transitionHistory,
    source.lifecycle?.transitionHistory,
  );
  await assert.rejects(
    h.store.applyLifecycleV2Migration(
      { ...plan, storePath: h.storePath },
      h.actor,
    ),
    /fingerprint.*changed/,
  );
  assert.deepEqual(h.writes, ["update:jp-one"]);
});

for (const changed of [
  "input",
  "new-owner",
  "classification",
  "resource",
  "writer",
] as const) {
  test(`apply refuses ${changed} changes before any conversion writes`, async (t) => {
    const h = await storeFixture(
      t,
      [checked("active")],
      changed === "writer" ? 1 : 2,
    );
    const plan = planLifecycleV2Migration(
      await h.store.list(allStatuses),
      completion,
    );
    if (changed === "input")
      h.records.get("jp-one")!.metadata.next_step = "Changed";
    if (changed === "new-owner") {
      const duplicate = issue(
        "jp-other",
        state({
          phase: "done",
          owner: OWNER,
          disposition: {
            kind: "completed",
            reason: "Done",
            at: NOW,
            evidenceArtifactIds: [],
          },
        }),
      );
      h.records.set(duplicate.id, {
        ...duplicate,
        labels: [],
        dependencies: [],
      });
    }
    if (changed === "classification")
      plan.classifications = {
        "jp-one": { purpose: "completion", reason: "Changed review" },
      };
    if (changed === "resource")
      h.records.get("jp-one")!.metadata.piLifecycle.resources = [
        { id: "unknown", kind: "worktree" },
      ];
    await assert.rejects(
      h.store.applyLifecycleV2Migration(
        { ...plan, storePath: h.storePath },
        h.actor,
      ),
      /fingerprint.*changed|write version 1|migration refused/,
    );
    assert.deepEqual(h.writes, []);
    assert.equal(h.records.get("jp-one")!.metadata.piLifecycle.version, 1);
  });
}

test("a matching fingerprint does not bypass a blocking diagnosis in another record", async (t) => {
  const h = await storeFixture(t, [
    issue(),
    {
      ...issue("jp-bad"),
      metadata: { piLifecycle: { version: 99 } },
      lifecycle: null,
    },
  ]);
  const plan = planLifecycleV2Migration(await h.store.list(allStatuses), {});
  await assert.rejects(
    h.store.applyLifecycleV2Migration(
      { ...plan, storePath: h.storePath },
      h.actor,
    ),
    /migration refused.*jp-bad/,
  );
  assert.deepEqual(h.writes, []);
});

test("old guarded writers refuse converted records instead of adopting them", async (t) => {
  const h = await storeFixture(t, [issue()]);
  const plan = planLifecycleV2Migration(await h.store.list(allStatuses), {});
  await h.store.applyLifecycleV2Migration(
    { ...plan, storePath: h.storePath },
    h.actor,
  );
  const old = await storeFixture(t, [await h.store.show("jp-one")], 1);
  await assert.rejects(
    old.sut.claim("jp-one", old.actor, "old-claim"),
    /write version 1/,
  );
  assert.deepEqual(old.writes, []);
});

test("a report for another store cannot redirect conversion of identical records", async (t) => {
  const h = await storeFixture(t, [issue()]);
  const plan = planLifecycleV2Migration(await h.store.list(allStatuses), {});
  await assert.rejects(
    h.store.applyLifecycleV2Migration(
      { ...plan, storePath: "/different-store" },
      h.actor,
    ),
    /reviewed store/,
  );
  assert.deepEqual(h.writes, []);
});

test("conversion keeps nonempty artifacts, resource records and historical observations", async () => {
  const { resource, check } = await import("./v2-test-fixtures.js");
  const source = checked("active");
  source.lifecycle!.artifacts = [
    {
      id: "doc",
      kind: "document",
      uri: "https://github.com/example/repo/blob/main/design.md",
      title: "Approved design",
      role: "evidence",
      sourceArtifactIds: [],
      producedAt: NOW,
      supersededAt: null,
    },
  ];
  source.lifecycle!.resources = [resource()];
  source.lifecycle!.checkHistory = [
    check({
      id: "previous",
      state: "satisfied",
      lastCheckedAt: NOW,
      lastObservation: "Verified",
    }),
  ];
  const plan = planLifecycleV2Migration([source], completion);
  assert.deepEqual(plan.diagnostics, []);
  for (const key of ["artifacts", "resources", "checkHistory"] as const)
    assert.deepEqual(plan.proposals[0].lifecycle[key], source.lifecycle![key]);
});

test("duplicate native resource identities block the entire migration", async () => {
  const { resource } = await import("./v2-test-fixtures.js");
  const one = issue(),
    two = issue("jp-two");
  (two.lifecycle as LifecycleMetadataV1).execution!.sessionId = "other-owner";
  one.lifecycle!.resources = [resource()];
  two.lifecycle!.resources = [resource({ id: "other-resource" })];
  const plan = planLifecycleV2Migration([one, two], {});
  assert.match(plan.diagnostics.join("\n"), /resource identity.*shared/);
});

test("an uncertain native write reports verified conversions and never retries or rolls back", async (t) => {
  const { LifecycleV2MigrationApplyError } = await import("./v2-migration.js");
  const h = await storeFixture(
    t,
    [
      issue("jp-one", legacy("actionable")),
      issue("jp-two", legacy("actionable")),
    ],
    2,
    (id) => {
      if (id === "jp-two") throw new Error("lost acknowledgement");
    },
  );
  const plan = planLifecycleV2Migration(await h.store.list(allStatuses), {});
  await assert.rejects(
    h.store.applyLifecycleV2Migration(
      { ...plan, storePath: h.storePath },
      h.actor,
    ),
    (error) => {
      assert.ok(error instanceof LifecycleV2MigrationApplyError);
      assert.deepEqual(error.verifiedTaskIds, ["jp-one"]);
      assert.equal(error.uncertainTaskId, "jp-two");
      assert.match(error.message, /write may have applied/);
      return true;
    },
  );
  assert.deepEqual(h.writes, ["update:jp-one", "update:jp-two"]);
  assert.equal(h.records.get("jp-two")!.metadata.piLifecycle.version, 2);
});

test("the shared mutation lock fences the complete cutover from other lifecycle writes", async (t) => {
  let arrived!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await storeFixture(
    t,
    [
      issue("jp-one", legacy("actionable")),
      issue("jp-two", legacy("actionable")),
    ],
    2,
    async (id) => {
      if (id === "jp-one") {
        arrived();
        await gate;
      }
    },
  );
  const plan = planLifecycleV2Migration(await h.store.list(allStatuses), {});
  const applying = h.store.applyLifecycleV2Migration(
    { ...plan, storePath: h.storePath },
    h.actor,
  );
  await started;
  const creating = h.store.create(
    {
      title: "Later task",
      why: "After cutover",
      workstream: "test",
      needsJp: false,
    },
    state(),
    h.actor,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const whileLocked = [...h.writes];
  release();
  await Promise.all([applying, creating]);
  assert.deepEqual(whileLocked, ["update:jp-one"]);
  assert.deepEqual(h.writes, ["update:jp-one", "update:jp-two", "create"]);
});

for (const missing of ["lastObservation", "lastCheckedAt"] as const) {
  test(`migration refuses cached success without ${missing} evidence`, () => {
    const source = checked("waiting", true);
    source.lifecycle!.activeCheck![missing] = null;
    const plan = planLifecycleV2Migration([source], completion);
    assert.match(
      plan.diagnostics.join("\n"),
      /satisfied.*persisted.*observation/,
    );
  });
}

for (const changed of ["proposal", "source"] as const) {
  test(`apply rejects an edited reviewed ${changed}, not only a stale live store`, async (t) => {
    const h = await storeFixture(t, [issue()]);
    const plan = planLifecycleV2Migration(await h.store.list(allStatuses), {});
    if (changed === "proposal") plan.proposals[0].lifecycle.owner = null;
    else plan.source[0].metadata.next_step = "Edited after report generation";
    await assert.rejects(
      h.store.applyLifecycleV2Migration(
        { ...plan, storePath: h.storePath },
        h.actor,
      ),
      /reviewed migration plan/,
    );
    assert.deepEqual(h.writes, []);
  });
}

test("a deferred native dependency group converts with an explicit completion classification", async () => {
  const { deferLifecycle, validateLifecycle } = await import("./model.js");
  const deferred = deferLifecycle(
    { ...legacy(), waiting: { kind: "dependency" } },
    { operationId: "defer", now: NOW, reason: "Park dependent work" },
  );
  const source = issue("jp-one", deferred);
  source.dependencies = [
    { id: "jp-blocker", status: "open", dependencyType: "blocks" },
  ];
  validateLifecycle(deferred, source);
  const before = structuredClone(source);
  const plan = planLifecycleV2Migration(
    [source, issue("jp-blocker", null)],
    completion,
  );
  assert.deepEqual(plan.diagnostics, []);
  const converted = plan.proposals[0].lifecycle;
  assert.equal(converted.phase, "deferred");
  assert.equal(converted.owner, null);
  assert.equal(converted.condition?.kind, "dependency");
  assert.equal(converted.condition?.purpose, "completion");
  assert.equal(converted.pause, null);
  validateLifecycleV2(converted, { ...source, lifecycle: converted });
  assert.deepEqual(source, before);
});

test("deferred native blockers require explicit classification rather than silently waiving them", () => {
  const source = issue("jp-one", {
    ...legacy("actionable"),
    phase: "deferred",
  });
  source.dependencies = [
    { id: "jp-blocker", status: "open", dependencyType: "blocks" },
  ];
  const plan = planLifecycleV2Migration(
    [source, issue("jp-blocker", null)],
    {},
  );
  assert.match(plan.diagnostics.join("\n"), /explicit purpose classification/);
});

test("cancelled Done tasks retain native edges without inventing a new completion gate", () => {
  const source = issue("jp-one", {
    ...legacy("actionable"),
    phase: "done",
    disposition: {
      kind: "cancelled",
      at: NOW,
      reason: "Explicit cancellation",
      evidenceArtifactIds: [],
    },
  });
  source.dependencies = [
    { id: "jp-blocker", status: "open", dependencyType: "blocks" },
  ];
  const plan = planLifecycleV2Migration(
    [source, issue("jp-blocker", null)],
    {},
  );
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.proposals[0].lifecycle.condition, null);
  assert.equal(plan.proposals[0].lifecycle.phase, "done");
});
