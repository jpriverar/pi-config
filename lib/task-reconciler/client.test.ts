import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { hostFixture, waitUntil } from "./host-fixtures.js";
import {
  requestReconciliation,
  ReconciliationUnknownResultError,
} from "./client.js";
import { TaskLifecycleService } from "../task-lifecycle/service.js";
import { fingerprintCheck } from "../task-lifecycle/reconciliation.js";
import { createCheckAdapterRegistry } from "../task-lifecycle/checks.js";
import { createReconciler } from "./queue.js";
import {
  fixturePolicy,
  MemoryLifecycleStore,
  waitingTask,
} from "./test-fixtures.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}
function engine(f: Awaited<ReturnType<typeof hostFixture>>) {
  const issue = waitingTask("manual", "manual");
  issue.lifecycle!.activeCheck!.nextCheckAt = "2099-01-01T00:00:00Z";
  const store = new MemoryLifecycleStore([issue]);
  const service = new TaskLifecycleService({
    store,
    now: Date.now,
    uuid: randomUUID,
    executionTimeoutMs: fixturePolicy.executionTimeoutMs,
  });
  const adapters = createCheckAdapterRegistry({
    now: Date.now,
    prPollIntervalMs: fixturePolicy.prPollIntervalMs,
    execGh: async () => {
      throw new Error("unexpected GitHub call");
    },
  });
  const runner = createReconciler({
    store,
    service,
    adapters,
    owner: f.owner,
    config: f.config,
    now: Date.now,
    abortLocalCommands() {},
  });
  const request = {
    requestId: "manual-intent",
    taskId: issue.id,
    manualOutcome: "satisfied" as const,
    expectedCheckFingerprint: fingerprintCheck(issue)!,
  };
  return { store, runner, request };
}

test("unavailable transport does not claim to have cancelled or executed a request", async (t) => {
  const f = await hostFixture(t);
  await assert.rejects(
    requestReconciliation(f.config, { requestId: "r", taskId: "jp-a" }),
    /unavailable|not installed/,
  );
  assert.equal(f.calls.start, 0);
});

test("client timeout preserves the original request binding and does not cancel work", async (t) => {
  const f = await hostFixture(t);
  f.config.limits.requestTimeoutMs = 200;
  const blocked = gate();
  let accepted = false;
  const host = await f.start({
    ...f.runner,
    async reconcile(request) {
      accepted = true;
      await blocked.promise;
      return f.runner.reconcile(request);
    },
  });
  const request = {
    requestId: "timeout",
    taskId: "jp-a",
    manualOutcome: "satisfied" as const,
    expectedCheckFingerprint: "a".repeat(64),
  };
  try {
    await assert.rejects(
      requestReconciliation(f.config, request),
      (error: unknown) =>
        error instanceof ReconciliationUnknownResultError &&
        error.request.requestId === request.requestId &&
        error.request.expectedCheckFingerprint ===
          request.expectedCheckFingerprint,
    );
    assert.equal(accepted, true);
    blocked.release();
    await waitUntil(() => f.calls.requests.length === 1);
  } finally {
    blocked.release();
    await host.stop();
  }
});

test("a lost committed response replays its binding without applying to replacement work", async (t) => {
  const f = await hostFixture(t);
  const e = engine(f);
  const blocked = gate();
  const mutate = e.store.mutate.bind(e.store);
  e.store.mutate = async (...args) => {
    const result = await mutate(...args);
    await blocked.promise;
    return result;
  };
  const host = await f.start(e.runner);
  const cancellation = new AbortController();
  const pending = requestReconciliation(
    f.config,
    e.request,
    cancellation.signal,
  );
  const unknown = assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof ReconciliationUnknownResultError &&
      error.request.expectedCheckFingerprint ===
        e.request.expectedCheckFingerprint,
  );
  try {
    await waitUntil(() => e.store.writes === 1);
    cancellation.abort();
    await unknown;
    blocked.release();
    await waitUntil(() => e.runner.snapshot().localRunning === 0);
    const current = e.store.issues.get("manual")!;
    const replacement = waitingTask("manual", "manual");
    replacement.lifecycle!.activeCheck!.id = "replacement";
    replacement.lifecycle!.activeCheck!.nextCheckAt = "2099-01-01T00:00:00Z";
    replacement.lifecycle!.transitionHistory = structuredClone(
      current.lifecycle!.transitionHistory,
    );
    e.store.issues.set("manual", replacement);
    const reply = await requestReconciliation(f.config, e.request);
    assert.equal(reply.outcome, "already_applied");
    assert.equal(
      e.store.issues.get("manual")?.lifecycle?.activeCheck?.id,
      "replacement",
    );
    assert.equal(e.store.writes, 1);
    await assert.rejects(
      requestReconciliation(f.config, {
        ...e.request,
        manualOutcome: "action_required",
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "request_conflict",
    );
  } finally {
    blocked.release();
    await host.stop();
  }
});

test("timed-out uncommitted manual intent cannot target a replacement check", async (t) => {
  const f = await hostFixture(t);
  const e = engine(f);
  const blocked = gate();
  const show = e.store.show.bind(e.store);
  let entered = false;
  e.store.show = async (id) => {
    entered = true;
    await blocked.promise;
    return show(id);
  };
  const host = await f.start(e.runner);
  const cancellation = new AbortController();
  const pending = requestReconciliation(
    f.config,
    e.request,
    cancellation.signal,
  );
  const unknown = assert.rejects(
    pending,
    (error: unknown) => error instanceof ReconciliationUnknownResultError,
  );
  try {
    await waitUntil(() => entered);
    cancellation.abort();
    await unknown;
    e.store.issues.get("manual")!.lifecycle!.activeCheck!.id = "replacement";
    blocked.release();
    await waitUntil(() => e.runner.snapshot().localRunning === 0);
    await assert.rejects(
      requestReconciliation(f.config, e.request),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "check_changed",
    );
    assert.equal(e.store.writes, 0);
    assert.equal(
      e.store.issues.get("manual")?.lifecycle?.activeCheck?.state,
      "pending",
    );
  } finally {
    blocked.release();
    await host.stop();
  }
});

for (const outcome of ["unchanged", "stale"] as const)
  test(`client accepts ${outcome} deferred task replies`, async (t) => {
    const f = await hostFixture(t);
    await f.start({
      ...f.runner,
      async reconcile(request) {
        const result = await f.runner.reconcile(request);
        result.outcome = outcome;
        result.issue.status = "deferred";
        result.issue.lifecycle = null;
        return result;
      },
    });
    const reply = await requestReconciliation(f.config, {
      requestId: outcome,
      taskId: "jp-deferred",
    });
    assert.equal(reply.outcome, outcome);
    assert.equal(reply.task.status, "deferred");
  });
