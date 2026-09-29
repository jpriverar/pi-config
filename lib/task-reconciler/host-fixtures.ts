import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { configFixture, waitingTask } from "./test-fixtures.js";
import { loadDaemonConfig } from "./config.js";
import { serveReconciler } from "./server.js";
import { readDaemonHealth } from "./health.js";
import { resolveRuntimePaths } from "./files.js";
import type { Reconciler } from "./queue.js";
import type { ReconcileRequest } from "../task-lifecycle/reconciliation.js";

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "host did not reach expected state");
    await delay(5);
  }
}

export async function hostFixture(t: TestContext) {
  const f = await configFixture(t);
  const shortRoot = await mkdtemp("/tmp/pi-reconciler-");
  f.raw.runtimeRoot = join(shortRoot, "run");
  await f.save();
  const config = await loadDaemonConfig(f.configPath);
  const owner = {
    pid: process.pid,
    host: hostname(),
    sessionId: `daemon-${randomUUID()}`,
    started: Date.now(),
  };
  const calls = { start: 0, stop: 0, requests: [] as ReconcileRequest[] };
  const runner: Reconciler = {
    start() {
      calls.start += 1;
    },
    async stop() {
      calls.stop += 1;
    },
    snapshot: () => ({
      lastScanAttemptAt: null,
      lastScanSuccessAt: null,
      queued: 0,
      localRunning: 0,
      externalRunning: 0,
      diagnostics: [],
    }),
    async reconcile(request) {
      calls.requests.push(request);
      const issue = waitingTask(request.taskId, "manual");
      issue.metadata.private = "not-for-the-client";
      return { outcome: "unchanged", issue };
    },
  };
  const hosts: { controller: AbortController; done: Promise<void> }[] = [];
  t.after(async () => {
    for (const host of hosts) host.controller.abort();
    await Promise.allSettled(hosts.map((host) => host.done));
    await rm(shortRoot, { recursive: true, force: true });
  });
  return {
    ...f,
    config,
    owner,
    calls,
    runner,
    paths: () => resolveRuntimePaths(config, false),
    async start(selected = runner) {
      const controller = new AbortController();
      const done = serveReconciler(config, selected, owner, controller.signal);
      let failure: unknown;
      void done.catch((error) => {
        failure = error;
      });
      hosts.push({ controller, done });
      await waitUntil(async () => {
        if (failure) throw failure;
        return (await readDaemonHealth(config)).state === "available";
      });
      return {
        controller,
        done,
        async stop() {
          controller.abort();
          await done;
        },
      };
    },
  };
}
