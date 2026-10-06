import assert from "node:assert/strict";
import { test } from "node:test";

import { createLifecycleStore } from "./beads-store.js";
import { scanReconciliation, selectDueCandidates } from "./reconciliation.js";
import type {
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecycleStatus,
} from "./types.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const BEFORE = "2026-09-28T11:00:00.000Z";
const AT = "2026-09-28T12:00:00.000Z";
const AFTER = "2026-09-28T13:00:00.000Z";

function task(
  id: string,
  overrides: Partial<LifecycleMetadataV1> = {},
): LifecycleIssue {
  const lifecycle: LifecycleMetadataV1 = {
    version: 1,
    phase: "actionable",
    waiting: null,
    stateEnteredAt: BEFORE,
    lastProgressAt: BEFORE,
    execution: null,
    artifacts: [],
    activeCheck: null,
    checkHistory: [],
    transitionHistory: [],
    resources: [],
    disposition: null,
    ...overrides,
  };
  return {
    id,
    title: "Reconciliation fixture",
    status: lifecycle.phase === "active" ? "in_progress" : "open",
    metadata: { piLifecycle: lifecycle },
    lifecycle,
    dependencies: [],
  };
}

function checkTask(
  id: string,
  nextCheckAt: string | null = AT,
): LifecycleIssue {
  const issue = task(id, {
    phase: "waiting",
    waiting: { kind: "check" },
    activeCheck: {
      id: "review",
      kind: "manual",
      targetArtifactIds: [],
      predicate: { reviewAt: BEFORE },
      onSatisfied: "actionable",
      wakeOn: [],
      state: "pending",
      createdAt: BEFORE,
      lastCheckedAt: null,
      nextCheckAt,
      lastObservation: null,
      errorCount: 0,
    },
  });
  issue.status = "blocked";
  return issue;
}

function dependencyTask(id: string, blockerIds: string[]): LifecycleIssue {
  const issue = task(id, { phase: "waiting", waiting: { kind: "dependency" } });
  issue.dependencies = blockerIds.map((blockerId) => ({
    id: blockerId,
    dependencyType: "blocks",
    status: "unknown",
  }));
  return issue;
}

function scannerStore(
  issues: LifecycleIssue[],
  targets: Record<string, LifecycleStatus>,
  failFirstBatch = false,
) {
  const calls: string[][] = [];
  let showCalls = 0;
  const store = createLifecycleStore(
    async (command, args) => {
      assert.equal(command, "bd");
      calls.push([...args]);
      let records: unknown[];
      if (args[0] === "list") {
        assert.deepEqual(args.slice(0, 6), [
          "list",
          "-s",
          "open,in_progress,blocked",
          "-n",
          "0",
          "--json",
        ]);
        records = issues.map((issue) => ({
          ...issue,
          dependencies: issue.dependencies.map((dep) => ({
            issue_id: issue.id,
            depends_on_id: dep.id,
            type: dep.dependencyType,
          })),
        }));
      } else {
        assert.equal(args[0], "show");
        const end = args.indexOf("--long");
        assert.ok(end > 0);
        showCalls += 1;
        if (failFirstBatch && showCalls === 1)
          return { code: 7, stdout: "", stderr: "private fixture output" };
        records = args
          .slice(1, end)
          .filter((id) => targets[id] !== undefined)
          .map((id) => ({
            id,
            title: "Blocker fixture",
            status: targets[id],
            metadata: {},
            dependencies: [],
          }));
      }
      return { code: 0, stdout: JSON.stringify(records), stderr: "" };
    },
    { store: "/tmp/reconciliation-readonly-fixture/.beads" },
  );
  return { store, calls };
}

test("selects due checks after ten unrelated tasks without counting future checks", () => {
  const issues = [
    ...Array.from({ length: 10 }, (_, i) => task(`plain-${i}`)),
    checkTask("future", AFTER),
    checkTask("due-after-ten"),
  ];
  assert.deepEqual(selectDueCandidates(issues, new Map(), NOW), [
    { taskId: "due-after-ten", eligibleAtMs: NOW, reasons: ["check"] },
  ]);
});

test("selects absent check deadlines but not deferred, closed, or unmanaged tasks", () => {
  const deferred = task("deferred", { phase: "deferred" });
  deferred.status = "deferred";
  const closed = checkTask("closed");
  closed.status = "closed";
  const unmanaged = { ...task("legacy"), lifecycle: null, metadata: {} };
  assert.deepEqual(
    selectDueCandidates(
      [deferred, closed, unmanaged, checkTask("unscheduled", null)],
      new Map(),
      NOW,
    ),
    [
      {
        taskId: "unscheduled",
        eligibleAtMs: Date.parse(BEFORE),
        reasons: ["check"],
      },
    ],
  );
});

test("selects pending resource repair using its transition timestamp", () => {
  const issue = task("resource", {
    phase: "active",
    execution: {
      sessionId: "live",
      claimedAt: BEFORE,
      lastActivityAt: AT,
      expiresAt: AFTER,
      resourceSnapshot: { observedAt: BEFORE, resourceIds: ["r"] },
    },
    resources: [
      {
        id: "r",
        kind: "worktree",
        repository: "repo",
        claimId: "claim",
        pathId: "path",
        operationId: "release-one",
        path: "/tmp/test-only",
        branch: "jpriverar/example",
        branchArtifactId: null,
        acquiredAt: BEFORE,
        releasedAt: null,
        cleanupState: "release_pending",
      },
    ],
    transitionHistory: [
      {
        operationId: "release-one:release-pending",
        type: "resource_release_pending",
        at: AT,
        from: "active",
        to: "active",
      },
    ],
  });
  assert.deepEqual(selectDueCandidates([issue], new Map(), NOW), [
    { taskId: "resource", eligibleAtMs: NOW, reasons: ["resource"] },
  ]);
  issue.lifecycle!.resources[0].cleanupState = "active";
  assert.deepEqual(selectDueCandidates([issue], new Map(), NOW), []);
});

test("only authoritative closed blockers satisfy dependency selection", () => {
  const waiting = dependencyTask("waiting", ["blocker"]);
  for (const status of [
    "open",
    "in_progress",
    "blocked",
    "deferred",
  ] as const) {
    assert.deepEqual(
      selectDueCandidates([waiting], new Map([["blocker", status]]), NOW),
      [],
    );
  }
  assert.deepEqual(selectDueCandidates([waiting], new Map(), NOW), []);
  assert.deepEqual(
    selectDueCandidates([waiting], new Map([["blocker", "closed"]]), NOW),
    [
      {
        taskId: "waiting",
        eligibleAtMs: Date.parse(BEFORE),
        reasons: ["dependency"],
      },
    ],
  );
});

test("clears an empty dependency condition and ignores nonblocking relations", () => {
  const waiting = dependencyTask("waiting", []);
  waiting.dependencies = [
    { id: "related", status: "open", dependencyType: "relates-to" },
  ];
  assert.deepEqual(
    selectDueCandidates([waiting], new Map(), NOW).map((c) => c.taskId),
    ["waiting"],
  );
});

test("requires every blocker and orders candidates by deadline then ID", () => {
  const waiting = dependencyTask("unresolved", ["done", "missing"]);
  assert.deepEqual(
    selectDueCandidates([waiting], new Map([["done", "closed"]]), NOW),
    [],
  );
  const candidates = selectDueCandidates(
    [checkTask("z", AT), checkTask("b", BEFORE), checkTask("a", BEFORE)],
    new Map(),
    NOW,
  );
  assert.deepEqual(
    candidates.map((c) => c.taskId),
    ["a", "b", "z"],
  );
});

test("scan deduplicates list-edge targets into one bulk show and never runs dep list", async () => {
  const { store, calls } = scannerStore(
    [
      dependencyTask("a", ["closed", "closed"]),
      dependencyTask("b", ["closed"]),
    ],
    { closed: "closed" },
  );
  const scan = await scanReconciliation(store, NOW);
  assert.deepEqual(
    scan.candidates.map((c) => c.taskId),
    ["a", "b"],
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["list", "show"],
  );
  assert.deepEqual(calls[1], [
    "show",
    "closed",
    "--long",
    "--json",
    "--db",
    "/tmp/reconciliation-readonly-fixture/.beads",
  ]);
});

test("scan skips unnecessary target queries for ordinary actionable tasks", async () => {
  const unrelated = task("ordinary");
  unrelated.dependencies = [
    { id: "not-needed", status: "open", dependencyType: "blocks" },
  ];
  const { store, calls } = scannerStore(
    [unrelated, checkTask("due"), checkTask("future", AFTER)],
    {},
  );
  const scan = await scanReconciliation(store, NOW);
  assert.deepEqual(
    scan.candidates.map((c) => c.taskId),
    ["due"],
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["list"],
  );
});

test("scan leaves absent targets unresolved without losing independent due work", async () => {
  const { store } = scannerStore(
    [dependencyTask("waiting", ["missing"]), checkTask("due")],
    {},
  );
  const scan = await scanReconciliation(store, NOW);
  assert.deepEqual(
    scan.candidates.map((c) => c.taskId),
    ["due"],
  );
  assert.ok(scan.diagnostics.some((d) => d.code === "blocker_unavailable"));
});

test("scan identifies malformed metadata without adopting unmanaged tasks", async () => {
  const malformed = {
    ...task("bad"),
    lifecycle: null,
    metadata: { piLifecycle: { version: 9 } },
  };
  const legacy = { ...task("legacy"), lifecycle: null, metadata: {} };
  const { store } = scannerStore([malformed, legacy, checkTask("due")], {});
  const scan = await scanReconciliation(store, NOW);
  assert.deepEqual(
    scan.candidates.map((c) => c.taskId),
    ["due"],
  );
  assert.deepEqual(scan.diagnostics, [
    { taskId: "bad", code: "malformed_lifecycle" },
  ]);
});

test("scan chunks 101 targets and continues after a failed batch", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `blocker-${i}`);
  const issues = ids.map((id, i) => dependencyTask(`task-${i}`, [id]));
  const targets = Object.fromEntries(ids.map((id) => [id, "closed" as const]));
  const healthy = scannerStore(issues, targets);
  assert.equal(
    (await scanReconciliation(healthy.store, NOW)).candidates.length,
    101,
  );
  assert.deepEqual(
    healthy.calls
      .filter((c) => c[0] === "show")
      .map((c) => c.indexOf("--long") - 1),
    [100, 1],
  );
  const failed = scannerStore(
    [...issues, checkTask("independent")],
    targets,
    true,
  );
  const scan = await scanReconciliation(failed.store, NOW);
  assert.deepEqual(
    scan.candidates.map((c) => c.taskId),
    ["task-100", "independent"],
  );
  assert.ok(scan.diagnostics.some((d) => d.code === "blocker_lookup_failed"));
  assert.ok(!JSON.stringify(scan).includes("private fixture output"));
});

test("scan chunks valid ID argument bytes before reaching the count limit", async () => {
  const ids = Array.from(
    { length: 100 },
    (_, i) => `id-${i}-` + "x".repeat(200),
  );
  const { store, calls } = scannerStore(
    ids.map((id, i) => dependencyTask(`task-${i}`, [id])),
    Object.fromEntries(ids.map((id) => [id, "closed" as const])),
  );
  const scan = await scanReconciliation(store, NOW);
  assert.equal(scan.candidates.length, 100);
  const batches = calls.filter((c) => c[0] === "show");
  assert.equal(batches.length, 2);
  assert.ok(
    batches.every(
      (c) =>
        Buffer.byteLength(c.slice(1, c.indexOf("--long")).join("\0")) <
        16 * 1024,
    ),
  );
});

test("showMany validates identifiers and does not invoke Beads for an empty set", async () => {
  const { store, calls } = scannerStore([], {});
  assert.deepEqual(await store.showMany([]), []);
  await assert.rejects(store.showMany(["--all"]), /issue id/);
  await assert.rejects(store.showMany(["x".repeat(17_000)]), /issue id/);
  assert.equal(calls.length, 0);
});

test("showMany rejects records for unrequested targets", async () => {
  const store = createLifecycleStore(
    async () => ({
      code: 0,
      stdout: JSON.stringify([
        { id: "wrong", title: "Unexpected", status: "closed" },
      ]),
      stderr: "",
    }),
    { store: "/tmp/reconciliation-readonly-fixture/.beads" },
  );
  await assert.rejects(store.showMany(["expected"]), /unexpected issue/);
});

test("check fingerprints are stable across process locales", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const issue = checkTask("locale");
  issue.lifecycle!.activeCheck!.predicate = {
    reviewAt: BEFORE,
    ä: 1,
    z: 2,
    a: 3,
  };
  const hashes: string[] = [];
  for (const locale of ["en_US.UTF-8", "sv_SE.UTF-8"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {fingerprintCheck} from './lib/task-lifecycle/reconciliation.ts'; console.log(fingerprintCheck(${JSON.stringify(issue)}));`,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, LANG: locale, LC_ALL: locale },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    hashes.push(result.stdout.trim());
  }
  assert.match(hashes[0], /^[a-f0-9]{64}$/);
  assert.equal(hashes[0], hashes[1]);
});

test("idle ownership is not reconciliation work, but due checks still are", () => {
  const issue = checkTask("idle", AFTER);
  issue.status = "in_progress";
  issue.lifecycle!.phase = "active";
  issue.lifecycle!.execution = {
    sessionId: "owner",
    claimedAt: BEFORE,
    lastActivityAt: BEFORE,
    expiresAt: BEFORE,
    resourceSnapshot: { observedAt: BEFORE, resourceIds: [] },
  };
  assert.deepEqual(selectDueCandidates([issue], new Map(), NOW), []);
  issue.lifecycle!.activeCheck!.nextCheckAt = AT;
  assert.deepEqual(selectDueCandidates([issue], new Map(), NOW), [
    { taskId: "idle", eligibleAtMs: NOW, reasons: ["check"] },
  ]);
});
