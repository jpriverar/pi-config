import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BeadsExec, BeadsExecResult } from "../beads.js";
import type { LifecycleMetadataV1, LockOwner, Mutation } from "./types.js";
import { createLifecycleStore } from "./beads-store.js";

const NOW = "2026-09-17T10:00:00.000Z";
const STORE = "/tmp/task-lifecycle-test/.beads";
const OWNER: LockOwner = {
  pid: process.pid,
  sessionId: "test-session",
  host: "test-host",
  started: Date.now(),
};

function lifecycle(
  overrides: Partial<LifecycleMetadataV1> = {},
): LifecycleMetadataV1 {
  return {
    version: 1,
    phase: "actionable",
    waiting: null,
    stateEnteredAt: NOW,
    lastProgressAt: NOW,
    execution: null,
    artifacts: [],
    activeCheck: null,
    checkHistory: [],
    transitionHistory: [],
    resources: [],
    disposition: null,
    ...overrides,
  };
}

function rawIssue(
  state: LifecycleMetadataV1 | null = lifecycle(),
): Record<string, unknown> {
  return {
    id: "jp-1",
    title: "Lifecycle task",
    status: "open",
    labels: ["workstream:pi-setup"],
    metadata:
      state === null
        ? { unrelated: { keep: true } }
        : {
            unrelated: { keep: true },
            "piLifecycle.phase": "stale dotted data",
            piLifecycle: state,
          },
    dependencies: [
      {
        id: "jp-blocker",
        title: "Blocker",
        status: "open",
        dependency_type: "blocks",
      },
    ],
  };
}

function result(value: unknown): BeadsExecResult {
  return { code: 0, stdout: JSON.stringify([value]), stderr: "" };
}

function options(store = STORE) {
  return {
    store,
    lockDependencies: {
      now: Date.now,
      sleep: (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      isPidAlive: () => "live" as const,
      hostname: "test-host",
      timeoutMs: 1_000,
    },
  };
}

function claimedMutation(operationId = "op-1"): Mutation {
  return {
    operationId,
    status: "in_progress",
    lifecycle: lifecycle({
      phase: "active",
      execution: {
        sessionId: "session-1",
        claimedAt: NOW,
        lastActivityAt: NOW,
        expiresAt: "2026-09-17T16:00:00.000Z",
        resourceSnapshot: { observedAt: NOW, resourceIds: [] },
      },
      transitionHistory: [
        {
          operationId,
          type: "claim",
          at: NOW,
          from: "actionable",
          to: "active",
          sessionId: "session-1",
        },
      ],
    }),
  };
}

test("reads lifecycle metadata and native dependency edges", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const exec: BeadsExec = async (command, args) => {
    calls.push([command, args]);
    return result(rawIssue());
  };
  const store = createLifecycleStore(exec, options());

  const read = await store.show("jp-1");

  assert.deepEqual(calls, [
    ["bd", ["show", "jp-1", "--long", "--json", "--db", STORE]],
  ]);
  assert.equal(read.lifecycle?.phase, "actionable");
  assert.deepEqual(read.dependencies, [
    { id: "jp-blocker", status: "open", dependencyType: "blocks" },
  ]);
  assert.deepEqual(read.metadata.unrelated, { keep: true });
});

test("serializes a full metadata merge, removes dotted lifecycle keys, and verifies", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  let current = rawIssue();
  const exec: BeadsExec = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "update") {
      current = {
        ...current,
        status: args[3],
        metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
      };
      return result(current);
    }
    return result(current);
  };
  const store = createLifecycleStore(exec, options());
  const mutation = claimedMutation();

  const saved = await store.mutate("jp-1", OWNER, () => mutation);

  assert.equal(saved.lifecycle?.phase, "active");
  assert.equal(saved.status, "in_progress");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], [
    "bd",
    ["show", "jp-1", "--long", "--json", "--db", STORE],
  ]);
  const updateArgs = calls[1][1];
  assert.deepEqual(updateArgs.slice(0, 6), [
    "update",
    "jp-1",
    "-s",
    "in_progress",
    "--metadata",
    updateArgs[5],
  ]);
  assert.deepEqual(updateArgs.slice(6), ["--json", "--db", STORE]);
  const merged = JSON.parse(updateArgs[5]);
  assert.deepEqual(merged.unrelated, { keep: true });
  assert.equal(Object.hasOwn(merged, "piLifecycle.phase"), false);
  assert.deepEqual(merged.piLifecycle, mutation.lifecycle);
  assert.deepEqual(calls[2], calls[0]);
});

test("keeps unsupported lifecycle metadata uncoerced and unmanaged", async () => {
  const raw = rawIssue(null);
  raw.metadata = { unrelated: true, piLifecycle: { version: 2 } };
  const store = createLifecycleStore(async () => result(raw), options());

  const read = await store.show("jp-1");

  assert.equal(read.lifecycle, null);
  assert.deepEqual(read.metadata.piLifecycle, { version: 2 });
});

test("lists statuses and reads native ready IDs through the explicit store", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const exec: BeadsExec = async (command, args) => {
    calls.push([command, args]);
    return result(rawIssue());
  };
  const store = createLifecycleStore(exec, options());

  const listed = await store.list(["open", "blocked"]);
  const ready = await store.readyIds();

  assert.equal(listed[0].id, "jp-1");
  assert.deepEqual([...ready], ["jp-1"]);
  assert.deepEqual(calls, [
    ["bd", ["list", "-s", "open,blocked", "-n", "0", "--json", "--db", STORE]],
    ["bd", ["ready", "--json", "--db", STORE]],
  ]);
});

test("rejects malformed JSON without exposing raw task content", async () => {
  const store = createLifecycleStore(
    async () => ({
      code: 0,
      stdout: "secret task contents {",
      stderr: "private stderr",
    }),
    options(),
  );

  await assert.rejects(
    store.show("jp-1"),
    (error: Error) =>
      /read issue jp-1/.test(error.message) &&
      /malformed JSON/.test(error.message) &&
      !/secret|private/.test(error.message),
  );
});

test("reports command failures with operation, issue, store, and exit code only", async () => {
  const store = createLifecycleStore(
    async () => ({ code: 42, stdout: "secret", stderr: "private" }),
    options(),
  );

  await assert.rejects(
    store.show("jp-1"),
    (error: Error) =>
      error.message.includes("read issue jp-1") &&
      error.message.includes(STORE) &&
      error.message.includes("exit code 42") &&
      !error.message.includes("secret") &&
      !error.message.includes("private"),
  );
});

test("rejects a read-back verification mismatch", async () => {
  let reads = 0;
  const exec: BeadsExec = async (_command, args) => {
    if (args[0] === "show") reads += 1;
    const raw = rawIssue(
      reads > 1 ? lifecycle({ phase: "actionable" }) : lifecycle(),
    );
    if (reads > 1) raw.status = "in_progress";
    return result(raw);
  };
  const store = createLifecycleStore(exec, options());

  await assert.rejects(
    store.mutate("jp-1", OWNER, () => claimedMutation()),
    /verify mutation jp-1.*phase/i,
  );
});

test("adds native block edges with the dependent first", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const exec: BeadsExec = async (command, args) => {
    calls.push([command, args]);
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const store = createLifecycleStore(exec, options());

  await store.addBlocker("jp-dependent", "jp-blocker");

  assert.deepEqual(calls, [
    [
      "bd",
      [
        "dep",
        "add",
        "jp-dependent",
        "jp-blocker",
        "--type",
        "blocks",
        "--db",
        STORE,
      ],
    ],
  ]);
});

test("serializes concurrent lifecycle mutations under one store lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-store-"));
  let activeExecutions = 0;
  let maxActiveExecutions = 0;
  let current = rawIssue();
  const exec: BeadsExec = async (_command, args) => {
    activeExecutions += 1;
    maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    if (args[0] === "update") {
      current = {
        ...current,
        status: args[3],
        metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
      };
    }
    activeExecutions -= 1;
    return result(current);
  };
  try {
    const store = createLifecycleStore(exec, options(join(root, ".beads")));
    const mutation = (operationId: string): Mutation => ({
      operationId,
      status: "open",
      lifecycle: lifecycle({
        transitionHistory: [
          {
            operationId,
            type: "observe",
            at: NOW,
            from: "actionable",
            to: "actionable",
          },
        ],
      }),
    });

    await Promise.all([
      store.mutate("jp-1", OWNER, () => mutation("op-a")),
      store.mutate("jp-1", OWNER, () => mutation("op-b")),
    ]);

    assert.equal(maxActiveExecutions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid native dependency payloads", async () => {
  const raw = rawIssue();
  raw.dependencies = [{ id: "jp-blocker", status: "mystery" }];
  const store = createLifecycleStore(async () => result(raw), options());

  await assert.rejects(store.show("jp-1"), /invalid native dependency/);
});

test("ready IDs ignore Beads edge-shaped dependency summaries", async () => {
  const ready = rawIssue();
  ready.dependencies = [
    {
      issue_id: "jp-1",
      depends_on_id: "jp-closed",
      type: "blocks",
      metadata: "{}",
    },
  ];
  const store = createLifecycleStore(async () => result(ready), options());

  assert.deepEqual([...(await store.readyIds())], ["jp-1"]);
});
