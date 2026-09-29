import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { performance } from "node:perf_hooks";
import { createCheckAdapterRegistry } from "../task-lifecycle/checks.js";
import { TaskLifecycleService } from "../task-lifecycle/service.js";
import { fingerprintCheck } from "../task-lifecycle/reconciliation.js";
import type { LifecycleIssue } from "../task-lifecycle/types.js";
import { createReconciler } from "./queue.js";
import { loadDaemonConfig, type DaemonConfig } from "./config.js";
import {
  configFixture,
  fixturePolicy,
  MemoryLifecycleStore,
  waitingTask,
} from "./test-fixtures.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(
      performance.now() < deadline,
      "queue did not reach expected state",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitSignal(promise: Promise<void>, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("fixture aborted");
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("fixture aborted"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([promise, cancelled]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
async function harness(
  t: TestContext,
  issues: LifecycleIssue[],
  options: {
    remote?: Promise<void>;
    limits?: Partial<DaemonConfig["limits"]>;
  } = {},
) {
  const files = await configFixture(t);
  const config = await loadDaemonConfig(files.configPath);
  Object.assign(config.limits, options.limits);
  const clock = { now: Date.parse("2026-01-02T00:00:00Z") };
  const store = new MemoryLifecycleStore(issues);
  const owner = {
    pid: process.pid,
    host: "fixture",
    sessionId: "daemon-fixture",
    started: clock.now,
  };
  let external = 0;
  let maxExternal = 0;
  let aborts = 0;
  const observed = new Map<string, number>();
  const base = createCheckAdapterRegistry({
    now: () => clock.now,
    prPollIntervalMs: fixturePolicy.prPollIntervalMs,
    execGh: async (_args, input) => {
      external += 1;
      maxExternal = Math.max(maxExternal, external);
      try {
        if (options.remote) await waitSignal(options.remote, input?.signal);
        return {
          code: 0,
          stdout: JSON.stringify({
            state: "MERGED",
            reviewDecision: "APPROVED",
            mergeStateStatus: "CLEAN",
            mergedAt: "2026-01-01T12:00:00Z",
          }),
          stderr: "",
        };
      } finally {
        external -= 1;
      }
    },
  });
  const adapters = {
    observe: async (...args: Parameters<typeof base.observe>) => {
      const id = args[0].id;
      observed.set(id, (observed.get(id) ?? 0) + 1);
      return base.observe(...args);
    },
  };
  const service = new TaskLifecycleService({
    store,
    now: () => clock.now,
    uuid: () => "fixture-uuid",
    executionTimeoutMs: fixturePolicy.executionTimeoutMs,
  });
  const sut = createReconciler({
    store,
    service,
    adapters,
    owner,
    config,
    now: () => clock.now,
    abortLocalCommands: () => {
      aborts += 1;
    },
  });
  t.after(() => sut.stop());
  return {
    sut,
    store,
    clock,
    config,
    observed,
    get external() {
      return external;
    },
    get maxExternal() {
      return maxExternal;
    },
    get aborts() {
      return aborts;
    },
  };
}

test("deduplicates scheduled scans and explicit retries without overlapping store work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const blocked = gate();
  const h = await harness(t, [waitingTask("a", "github_pull_request")], {
    remote: blocked.promise,
    limits: { scanIntervalMs: 1000 },
  });
  try {
    h.sut.start();
    h.sut.start();
    await until(() => h.external === 1);
    const request = { requestId: "explicit", taskId: "a" };
    const first = h.sut.reconcile(request);
    const retry = h.sut.reconcile(request);
    h.clock.now += 3000;
    t.mock.timers.tick(3000);
    await until(() => h.store.reads >= 2);
    assert.equal(h.observed.get("check-a"), 1);
    blocked.release();
    assert.equal((await first).issue.lifecycle?.phase, "actionable");
    assert.equal((await retry).issue.lifecycle?.phase, "actionable");
    assert.equal(h.observed.get("check-a"), 1);
    assert.equal(h.store.maxConcurrent, 1);
  } finally {
    blocked.release();
    await h.sut.stop();
  }
});

test("bounds external work while unrelated local tasks finish", async (t) => {
  const blocked = gate();
  const h = await harness(
    t,
    [
      waitingTask("a", "github_pull_request"),
      waitingTask("b", "github_pull_request"),
      waitingTask("c", "github_pull_request"),
      waitingTask("z-local"),
    ],
    { remote: blocked.promise },
  );
  try {
    h.sut.start();
    await until(
      () => h.store.issues.get("z-local")?.lifecycle?.phase === "actionable",
    );
    assert.equal(h.external, 2);
    assert.equal(h.maxExternal, 2);
    assert.equal(h.store.maxConcurrent, 1);
    blocked.release();
    await until(
      () => h.store.issues.get("c")?.lifecycle?.phase === "actionable",
    );
    assert.equal(h.maxExternal, 2);
  } finally {
    blocked.release();
    await h.sut.stop();
  }
});

test("admits all 101 tasks fairly even when earlier-deadline work keeps arriving", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await harness(
    t,
    Array.from({ length: 101 }, (_, i) =>
      waitingTask(`original-${i.toString().padStart(3, "0")}`),
    ),
    { limits: { scanIntervalMs: 1000 } },
  );
  let added = 0;
  let maxAdmitted = 0;
  h.store.onWrite = () => {
    const s = h.sut.snapshot();
    maxAdmitted = Math.max(
      maxAdmitted,
      s.queued + s.localRunning + s.externalRunning,
    );
    if (added < 12) {
      const fresh = waitingTask(`incoming-${++added}`);
      fresh.lifecycle!.activeCheck!.nextCheckAt = "2025-01-01T00:00:00Z";
      h.store.issues.set(fresh.id, fresh);
      h.clock.now += 1000;
      t.mock.timers.tick(1000);
    }
  };
  try {
    h.sut.start();
    await until(
      () =>
        h.store.issues.get("original-100")?.lifecycle?.phase === "actionable",
    );
    assert.ok(maxAdmitted <= 100);
    assert.equal(
      [...h.store.issues.values()].filter(
        (issue) =>
          issue.id.startsWith("original") &&
          issue.lifecycle?.phase === "actionable",
      ).length,
      101,
    );
    assert.equal(h.store.maxConcurrent, 1);
  } finally {
    await h.sut.stop();
  }
});

test("conflicting explicit outcomes fail rather than coalescing", async (t) => {
  const h = await harness(t, [waitingTask("manual", "manual")]);
  try {
    h.sut.start();
    await until(() => h.store.writes === 1);
    const fingerprint = fingerprintCheck(h.store.issues.get("manual")!)!;
    const first = h.sut.reconcile({
      requestId: "one",
      taskId: "manual",
      manualOutcome: "satisfied",
      expectedCheckFingerprint: fingerprint,
    });
    await assert.rejects(
      h.sut.reconcile({
        requestId: "two",
        taskId: "manual",
        manualOutcome: "action_required",
        expectedCheckFingerprint: fingerprint,
      }),
      /conflict/,
    );
    assert.equal((await first).issue.lifecycle?.phase, "actionable");
  } finally {
    await h.sut.stop();
  }
});

test("rejects excess explicit requests instead of growing waiter lists", async (t) => {
  const blocked = gate();
  const h = await harness(t, [waitingTask("a", "github_pull_request")], {
    remote: blocked.promise,
    limits: { maxQueuedTasks: 1 },
  });
  try {
    h.sut.start();
    await until(() => h.external === 1);
    await assert.rejects(
      h.sut.reconcile({ requestId: "extra", taskId: "a" }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string; outcomeUnknown?: boolean }).code ===
          "queue_full" &&
        (error as Error & { outcomeUnknown?: boolean }).outcomeUnknown ===
          false,
    );
    assert.ok(h.sut.snapshot().externalRunning <= 1);
  } finally {
    blocked.release();
    await h.sut.stop();
  }
});

test("isolates local failures and backs off without exposing raw errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await harness(t, [waitingTask("bad"), waitingTask("good")], {
    limits: { scanIntervalMs: 1000 },
  });
  h.store.failTask = "bad";
  try {
    h.sut.start();
    await until(
      () => h.store.issues.get("good")?.lifecycle?.phase === "actionable",
    );
    assert.ok(
      h.sut
        .snapshot()
        .diagnostics.some((d) => d.code === "local_reconciliation_failed"),
    );
    assert.ok(!JSON.stringify(h.sut.snapshot()).includes("private fixture"));
    h.store.failTask = null;
    h.clock.now += 1000;
    t.mock.timers.tick(1000);
    await until(() => h.store.reads >= 2);
    assert.equal(h.store.issues.get("bad")?.lifecycle?.phase, "waiting");
    h.clock.now += 60_000;
    t.mock.timers.tick(60_000);
    await until(
      () => h.store.issues.get("bad")?.lifecycle?.phase === "actionable",
    );
  } finally {
    await h.sut.stop();
  }
});

test("external deadline aborts observation and records persisted check backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const blocked = gate();
  const h = await harness(t, [waitingTask("a", "github_pull_request")], {
    remote: blocked.promise,
  });
  try {
    h.sut.start();
    await until(() => h.external === 1);
    h.clock.now += 120_000;
    t.mock.timers.tick(120_000);
    await until(
      () => h.store.issues.get("a")?.lifecycle?.activeCheck?.state === "error",
    );
    assert.equal(
      h.store.issues.get("a")?.lifecycle?.activeCheck?.errorCount,
      1,
    );
    assert.equal(
      Date.parse(
        h.store.issues.get("a")!.lifecycle!.activeCheck!.nextCheckAt!,
      ) - h.clock.now,
      900_000,
    );
    assert.equal(h.external, 0);
  } finally {
    blocked.release();
    await h.sut.stop();
  }
});

test("shutdown cancels remote work without applying invented outcomes", async (t) => {
  const blocked = gate();
  const h = await harness(t, [waitingTask("a", "github_pull_request")], {
    remote: blocked.promise,
  });
  h.sut.start();
  await until(() => h.external === 1);
  await h.sut.stop();
  assert.equal(h.external, 0);
  assert.equal(h.aborts, 1);
  assert.equal(h.store.writes, 0);
  await assert.rejects(
    h.sut.reconcile({ requestId: "late", taskId: "a" }),
    /stopp|running/,
  );
});

test("expired ownership remains eligible when its retained check is in the future", async (t) => {
  const issue = waitingTask("expired", "manual");
  issue.status = "in_progress";
  issue.lifecycle!.phase = "active";
  issue.lifecycle!.execution = {
    sessionId: "old-owner",
    claimedAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-01T12:00:00Z",
    resourceSnapshot: { observedAt: "2026-01-01T00:00:00Z", resourceIds: [] },
  };
  issue.lifecycle!.activeCheck!.nextCheckAt = "2026-01-03T00:00:00Z";
  const h = await harness(t, [issue]);
  try {
    h.sut.start();
    await until(
      () => h.store.issues.get("expired")?.lifecycle?.execution === null,
    );
    assert.equal(h.store.issues.get("expired")?.lifecycle?.phase, "waiting");
    assert.equal(h.observed.size, 0);
  } finally {
    await h.sut.stop();
  }
});

test("fresh runtime state reconstructs due jobs from the store", async (t) => {
  const first = await harness(t, [waitingTask("a")]);
  await first.sut.stop();
  const next = await harness(t, [...first.store.issues.values()]);
  try {
    next.sut.start();
    await until(
      () => next.store.issues.get("a")?.lifecycle?.phase === "actionable",
    );
  } finally {
    await next.sut.stop();
  }
});

test("ticks missed during a slow scan are not replayed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const blocked = gate();
  const h = await harness(t, [], { limits: { scanIntervalMs: 1000 } });
  const list = h.store.list.bind(h.store);
  let scans = 0;
  h.store.list = async (statuses) => {
    scans += 1;
    await blocked.promise;
    return list(statuses);
  };
  try {
    h.sut.start();
    await until(() => scans === 1);
    h.clock.now += 3000;
    t.mock.timers.tick(3000);
    blocked.release();
    await until(() => h.sut.snapshot().lastScanSuccessAt !== null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scans, 1);
  } finally {
    blocked.release();
    await h.sut.stop();
  }
});

test("explicit and scheduled local work alternate when observations are ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const remote = gate();
  const scan = gate();
  const manuals = [waitingTask("m1", "manual"), waitingTask("m2", "manual")];
  manuals.forEach((issue) => {
    issue.lifecycle!.activeCheck!.nextCheckAt = "2026-01-03T00:00:00Z";
  });
  const h = await harness(
    t,
    [
      waitingTask("a", "github_pull_request"),
      waitingTask("b", "github_pull_request"),
      ...manuals,
    ],
    { remote: remote.promise, limits: { scanIntervalMs: 1000 } },
  );
  const writes: string[] = [];
  h.store.onWrite = (id) => writes.push(id);
  try {
    h.sut.start();
    await until(() => h.external === 2);
    const list = h.store.list.bind(h.store);
    let scanEntered = false;
    h.store.list = async (statuses) => {
      scanEntered = true;
      await scan.promise;
      return list(statuses);
    };
    h.clock.now += 1000;
    t.mock.timers.tick(1000);
    await until(() => scanEntered);
    const explicit = manuals.map((issue) =>
      h.sut.reconcile({
        requestId: `r-${issue.id}`,
        taskId: issue.id,
        manualOutcome: "satisfied",
        expectedCheckFingerprint: fingerprintCheck(
          h.store.issues.get(issue.id)!,
        )!,
      }),
    );
    remote.release();
    await until(() => h.sut.snapshot().externalRunning === 0);
    scan.release();
    await Promise.all(explicit);
    await until(() => writes.length === 4);
    assert.deepEqual(writes, ["m1", "a", "m2", "b"]);
  } finally {
    remote.release();
    scan.release();
    await h.sut.stop();
  }
});

test("a stale manual request is a check_changed rejection, not an operational failure", async (t) => {
  const h = await harness(t, [waitingTask("manual", "manual")]);
  try {
    h.sut.start();
    await until(() => h.store.writes === 1);
    await assert.rejects(
      h.sut.reconcile({
        requestId: "stale",
        taskId: "manual",
        manualOutcome: "satisfied",
        expectedCheckFingerprint: "0".repeat(64),
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "check_changed",
    );
    assert.equal(h.store.writes, 1);
    assert.ok(
      !h.sut
        .snapshot()
        .diagnostics.some((d) => d.code === "local_reconciliation_failed"),
    );
  } finally {
    await h.sut.stop();
  }
});

test("counts recurring scan diagnostics and clears repaired faults", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const broken = waitingTask("broken");
  broken.lifecycle = null;
  broken.metadata = { piLifecycle: { version: 999 } };
  const h = await harness(t, [broken], { limits: { scanIntervalMs: 1000 } });
  try {
    h.sut.start();
    await until(() => h.sut.snapshot().lastScanSuccessAt !== null);
    h.clock.now += 1000;
    t.mock.timers.tick(1000);
    await until(
      () =>
        h.sut.snapshot().lastScanSuccessAt ===
        new Date(h.clock.now).toISOString(),
    );
    assert.equal(h.sut.snapshot().diagnostics[0].count, 2);
    h.store.issues.clear();
    h.clock.now += 1000;
    t.mock.timers.tick(1000);
    await until(
      () =>
        h.sut.snapshot().lastScanSuccessAt ===
        new Date(h.clock.now).toISOString(),
    );
    assert.deepEqual(h.sut.snapshot().diagnostics, []);
  } finally {
    await h.sut.stop();
  }
});

test("a failed scan does not prevent explicit work and recovery clears its diagnostic", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await harness(t, [waitingTask("a")], {
    limits: { scanIntervalMs: 1000 },
  });
  h.store.failList = true;
  try {
    h.sut.start();
    await until(() =>
      h.sut.snapshot().diagnostics.some((d) => d.code === "scan_failed"),
    );
    assert.equal(h.sut.snapshot().lastScanSuccessAt, null);
    assert.equal(
      (await h.sut.reconcile({ requestId: "explicit", taskId: "a" })).issue
        .lifecycle?.phase,
      "actionable",
    );
    h.store.failList = false;
    h.clock.now += 1000;
    t.mock.timers.tick(1000);
    await until(() => h.sut.snapshot().lastScanSuccessAt !== null);
    assert.ok(
      !h.sut.snapshot().diagnostics.some((d) => d.code === "scan_failed"),
    );
    assert.ok(!JSON.stringify(h.sut.snapshot()).includes("private fixture"));
  } finally {
    await h.sut.stop();
  }
});
