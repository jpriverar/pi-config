import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createLifecycleStore } from "./beads-store.js";
import { TaskLifecycleService, type TaskLifecyclePoolPort } from "./service.js";
import type { CheckAdapterRegistry } from "./checks.js";
import type {
  LifecycleMetadataV2,
  LifecycleStatus,
  LockOwner,
  NativeDependency,
} from "./types.js";
import { NOW, OWNER } from "./v2-test-fixtures.js";

export const session = (sessionId = OWNER.sessionId): LockOwner => ({
  pid: process.pid,
  sessionId,
  host: "test-host",
  started: Date.now(),
});

export interface Seed {
  id: string;
  lifecycle: LifecycleMetadataV2;
  status?: LifecycleStatus;
  dependencies?: NativeDependency[];
}

export async function fixture(
  t: TestContext,
  seeds: Seed[],
  options: {
    serviceVersion?: 1 | 2;
    storeVersion?: 1 | 2;
    pool?: TaskLifecyclePoolPort;
    checkAdapters?: CheckAdapterRegistry;
    now?: () => number;
  } = {
    serviceVersion: 2,
    storeVersion: 2,
  },
) {
  const root = await mkdtemp(join(tmpdir(), "v2-lifecycle-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = new Map<string, Record<string, any>>();
  const writes: string[] = [];
  const comments: Array<{ taskId: string; message: string }> = [];
  for (const seed of seeds) {
    const statuses = {
      actionable: "open",
      active: "in_progress",
      deferred: "deferred",
      done: "closed",
      waiting: seed.lifecycle.condition?.kind === "check" ? "blocked" : "open",
    };
    records.set(seed.id, {
      id: seed.id,
      title: seed.id,
      status: seed.status ?? statuses[seed.lifecycle.phase],
      description: "Deliver the approved work",
      labels: [],
      metadata: {
        piLifecycle: structuredClone(seed.lifecycle),
        next_step: "Continue",
      },
      dependencies: (seed.dependencies ?? []).map((dep) => ({
        id: dep.id,
        status: dep.status,
        dependency_type: dep.dependencyType,
      })),
    });
  }
  const store = createLifecycleStore(
    async (command, args) => {
      assert.equal(command, "bd");
      let result: unknown;
      if (args[0] === "show") {
        result = args
          .slice(1, args.indexOf("--long"))
          .map((id) => records.get(id));
      } else if (args[0] === "list") {
        const statuses = args[args.indexOf("-s") + 1].split(",");
        assert.equal(args[args.indexOf("-n") + 1], "0");
        result = [...records.values()].filter((record) =>
          statuses.includes(record.status),
        );
      } else if (args[0] === "ready") {
        result = [...records.values()].filter(
          (record) =>
            record.status === "open" &&
            record.dependencies.every((dep: any) => dep.status === "closed"),
        );
      } else if (args[0] === "update") {
        writes.push("update:" + args[1]);
        const current = records.get(args[1])!;
        if (args.includes("--metadata"))
          current.metadata = JSON.parse(args[args.indexOf("--metadata") + 1]);
        if (args.includes("-s")) current.status = args[args.indexOf("-s") + 1];
        if (args.includes("-d"))
          current.description = args[args.indexOf("-d") + 1];
        result = [current];
      } else if (args[0] === "comments" && args[1] === "add") {
        writes.push("comment:" + args[2]);
        comments.push({ taskId: args[2], message: args[3] });
        result = {};
      } else if (args[0] === "dep" && args[1] === "add") {
        writes.push("dep:" + args[2] + ":" + args[3]);
        records.get(args[2])!.dependencies.push({
          id: args[3],
          status: records.get(args[3])?.status ?? "open",
          dependency_type: "blocks",
        });
        result = {};
      } else if (args[0] === "create") {
        writes.push("create");
        const created = {
          id: "jp-created",
          title: args[1],
          status: "open",
          labels: [],
          dependencies: [],
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
        };
        records.set(created.id, created);
        result = created;
      } else throw new Error("unexpected test command " + args[0]);
      return { code: 0, stdout: JSON.stringify(result), stderr: "" };
    },
    {
      store: root,
      ...(options.storeVersion === undefined
        ? {}
        : { lifecycleWriteVersion: options.storeVersion }),
      lockDependencies: {
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        isPidAlive: () => "live",
        hostname: "test-host",
        timeoutMs: 2_000,
      },
    },
  );
  let sequence = 0;
  const sut = new TaskLifecycleService({
    store,
    now: options.now ?? (() => Date.parse(NOW)),
    uuid: () => "op-" + ++sequence,
    executionTimeoutMs: 60_000,
    pool: options.pool,
    checkAdapters: options.checkAdapters,
    ...(options.serviceVersion === undefined
      ? {}
      : { lifecycleWriteVersion: options.serviceVersion }),
  });
  return {
    store,
    sut,
    writes,
    comments,
    records,
    snapshot: (id: string) => structuredClone(records.get(id)),
  };
}
