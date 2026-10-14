import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BeadsExec, BeadsExecResult } from "../beads.js";
import type { LifecycleMetadataV1, LockOwner, Mutation } from "./types.js";
import { createLifecycleStore } from "./beads-store.js";
import type { WorkManagementState } from "../work-management/model.js";

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

test("creates a managed task and verifies it through the explicit store", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const environments: Array<Record<string, string> | undefined> = [];
  let current: Record<string, unknown> = {
    ...rawIssue(),
    id: "jp-created",
    title: "Ship it",
  };
  const state = lifecycle();
  const exec: BeadsExec = async (command, args, execution) => {
    calls.push([command, args]);
    environments.push(execution?.env);
    if (args[0] === "create") {
      current = {
        ...current,
        metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
      };
      return { code: 0, stdout: JSON.stringify(current), stderr: "" };
    }
    return result(current);
  };
  const store = createLifecycleStore(exec, options());

  const created = await store.create(
    {
      title: "Ship it",
      why: "Required",
      workstream: "pi-setup",
      needsJp: false,
    },
    state,
    OWNER,
  );

  assert.equal(created.id, "jp-created");
  assert.equal(created.lifecycle?.phase, "actionable");
  assert.deepEqual(environments, [undefined, { BD_BACKUP_ENABLED: "false" }]);
  assert.deepEqual(calls[0]?.[1], [
    "create",
    "Ship it",
    "-d",
    "Required",
    "-l",
    "workstream:pi-setup",
    "--metadata",
    JSON.stringify({ piLifecycle: state }),
    "--json",
    "--db",
    STORE,
  ]);
  assert.deepEqual(calls[1]?.[1], [
    "show",
    "jp-created",
    "--long",
    "--json",
    "--db",
    STORE,
  ]);
});

test("updates labels in one command and rejects no-op or overlap", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const exec: BeadsExec = async (command, args) => {
    calls.push([command, args]);
    return result(rawIssue(null));
  };
  const store = createLifecycleStore(exec, options());

  const saved = await store.updateLabels(
    "jp-1",
    { addLabels: ["priority:high"], removeLabels: ["priority:low"] },
    OWNER,
  );

  assert.equal(saved.lifecycle, null);
  assert.deepEqual(calls[0]?.[1], [
    "update",
    "jp-1",
    "--add-label",
    "priority:high",
    "--remove-label",
    "priority:low",
    "--json",
    "--db",
    STORE,
  ]);
  assert.deepEqual(calls[1]?.[1], [
    "show",
    "jp-1",
    "--long",
    "--json",
    "--db",
    STORE,
  ]);
});

test("revalidates ownership under lock before appending a comment", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const current = rawIssue(
    lifecycle({
      phase: "active",
      execution: {
        sessionId: OWNER.sessionId,
        claimedAt: NOW,
        lastActivityAt: NOW,
        expiresAt: "2026-09-17T16:00:00.000Z",
        resourceSnapshot: { observedAt: NOW, resourceIds: [] },
      },
    }),
  );
  current.status = "in_progress";
  const exec: BeadsExec = async (command, args) => {
    calls.push([command, args]);
    return result(current);
  };
  const store = createLifecycleStore(exec, options());

  const saved = await store.appendComment(
    "jp-1",
    "progress",
    OWNER,
    (issue) => {
      assert.equal(issue.lifecycle?.execution?.sessionId, OWNER.sessionId);
    },
  );

  assert.equal(saved.lifecycle?.phase, "active");
  assert.deepEqual(
    calls.map((call) => call[1]),
    [
      ["show", "jp-1", "--long", "--json", "--db", STORE],
      ["comments", "add", "jp-1", "progress", "--json", "--db", STORE],
      ["show", "jp-1", "--long", "--json", "--db", STORE],
    ],
  );
});

test("list preserves Beads edge summaries with unknown target status", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const raw = rawIssue();
  raw.dependencies = [
    {
      issue_id: "jp-1",
      depends_on_id: "jp-blocker",
      type: "blocks",
      metadata: "{}",
    },
  ];
  const exec: BeadsExec = async (command, args) => {
    calls.push([command, args]);
    return result(raw);
  };
  const store = createLifecycleStore(exec, options());

  const [listed] = await store.list(["open"]);

  assert.deepEqual(listed.dependencies, [
    { id: "jp-blocker", status: "unknown", dependencyType: "blocks" },
  ]);
  assert.deepEqual(calls, [
    ["bd", ["list", "-s", "open", "-n", "0", "--json", "--db", STORE]],
  ]);
});

test("serializes a full metadata merge, removes dotted lifecycle keys, and verifies", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const environments: Array<Record<string, string> | undefined> = [];
  let current = rawIssue();
  const exec: BeadsExec = async (command, args, execution) => {
    calls.push([command, args]);
    environments.push(execution?.env);
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
  assert.deepEqual(environments, [
    { BD_BACKUP_ENABLED: "false" },
    undefined,
    { BD_BACKUP_ENABLED: "false" },
  ]);
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

  await store.addBlocker("jp-dependent", "jp-blocker", OWNER);

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

test("serializes blocker insertion with lifecycle mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-blocker-"));
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

    await Promise.all([
      store.mutate("jp-1", OWNER, () => claimedMutation("op-lock")),
      store.addBlocker("jp-1", "jp-blocker-2", OWNER),
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

test("locked reconciliation can abstain without writing or inventing an operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-abstain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const raw = rawIssue();
  const store = createLifecycleStore(async (_command, args) => {
    calls.push(args[0]);
    return result(raw);
  }, options(root));
  const current = await store.mutate("jp-1", OWNER, () => null);
  assert.equal(current.status, "open");
  assert.deepEqual(calls, ["show"]);
  assert.deepEqual(current.metadata, raw.metadata);
});

test(
  "async repair validation retains the store lock until persistence completes",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-repair-lock-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let raw = rawIssue();
    let enter!: () => void;
    let release!: () => void;
    let waiting!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contended = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const events: string[] = [];
    const config = options(root);
    config.lockDependencies.sleep = async () => {
      waiting();
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const store = createLifecycleStore(async (_command, args) => {
      if (args[0] === "update") {
        events.push("persist");
        raw = {
          ...raw,
          status: args[args.indexOf("-s") + 1],
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
        };
      }
      return result(raw);
    }, config);
    const first = store.mutate("jp-1", OWNER, async () => {
      events.push("validate");
      enter();
      await gate;
      return claimedMutation("locked-repair");
    });
    await entered;
    const second = store.mutate(
      "jp-1",
      { ...OWNER, sessionId: "another-session" },
      (current) => {
        events.push("second");
        assert.equal(current.status, "in_progress");
        return null;
      },
    );
    await contended;
    assert.deepEqual(events, ["validate"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["validate", "persist", "second"]);
  },
);

test("mutation waits for async repair validation before persisting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-async-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let raw = rawIssue();
  let validated = false;
  const store = createLifecycleStore(async (_command, args) => {
    if (args[0] === "update") {
      assert.equal(validated, true);
      raw = {
        ...raw,
        status: args[args.indexOf("-s") + 1],
        metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
      };
    }
    return result(raw);
  }, options(root));
  const saved = await store.mutate("jp-1", OWNER, async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    validated = true;
    return claimedMutation("async-repair");
  });
  assert.equal(saved.status, "in_progress");
  assert.equal(
    saved.lifecycle!.transitionHistory[0].operationId,
    "async-repair",
  );
});

test("replayed identical metadata does not issue another Beads update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-unchanged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const mutation = claimedMutation();
  const raw = rawIssue(mutation.lifecycle);
  raw.status = mutation.status;
  raw.metadata = { unrelated: { keep: true }, piLifecycle: mutation.lifecycle };
  const store = createLifecycleStore(async (_command, args) => {
    calls.push(args[0]);
    return result(raw);
  }, options(root));
  await store.mutate("jp-1", OWNER, () => mutation);
  assert.deepEqual(calls, ["show"]);
});

const WM_TARGET = {
  site: "datadoghq.com",
  orgUuid: "8dee7c38-00cb-11ea-a77b-8b5a08d3b091",
  projectId: "e555e290-ed65-49bd-ae18-8acbfcf18db7",
  typeId: "00000000-0000-0000-0000-000000000001",
  statuses: {
    actionable: "Open",
    active: "In Progress",
    waiting: "Open",
    deferred: "Open",
    completed: "Done",
    cancelled: "Done",
    superseded: "Done",
  },
};

test("enrollment shares the native create command and snapshots its target", async () => {
  const calls: string[][] = [];
  let raw = rawIssue();
  const config = {
    version: 1 as const,
    ddAuthPath: "/bin/dd-auth",
    curlPath: "/usr/bin/curl",
    workstreams: { "pi-setup": WM_TARGET },
  };
  const store = createLifecycleStore(
    async (_, args) => {
      calls.push([...args]);
      if (args[0] === "create")
        raw = {
          ...raw,
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
        };
      if (args[0] === "update")
        raw = {
          ...raw,
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
        };
      return result(raw);
    },
    { ...options(), readWorkManagementConfig: () => config },
  );
  const issue = await store.create(
    { title: "Ship", why: "Why", workstream: "PI-SETUP", needsJp: false },
    lifecycle(),
    OWNER,
  );
  const state = issue.metadata.piWorkManagement as WorkManagementState;
  assert.deepEqual(state?.target, WM_TARGET);
  assert.equal(state.remote, null);
  assert.equal(calls.filter((args) => args[0] === "create").length, 1);
  assert.equal(
    calls.some((args) => args[0] === "update"),
    false,
  );
  config.workstreams["pi-setup"] = {
    ...WM_TARGET,
    projectId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
  };
  assert.equal(state.target.projectId, "e555e290-ed65-49bd-ae18-8acbfcf18db7");
  const before = structuredClone(issue.metadata);
  const after = await store.mutateWorkManagement(issue.id, OWNER, () => ({
    ...state,
    lastSentStatus: "Open",
  }));
  assert.deepEqual(after.metadata.piLifecycle, before.piLifecycle);
  assert.equal(after.status, issue.status);
  assert.equal(
    calls
      .filter((args) => args[0] === "update")
      .some((args) => args.includes("-s")),
    false,
  );
});

test("new tasks use the default unless their workstream overrides or opts out", async (t) => {
  const defaultTarget = {
    ...WM_TARGET,
    projectId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
  };
  for (const [workstream, expected] of [
    ["new-workstream", defaultTarget],
    [undefined, defaultTarget],
    ["PI-SETUP  ", WM_TARGET],
    ["LOCAL  ", null],
    ["constructor", defaultTarget],
    ["__proto__", defaultTarget],
  ] as const) {
    await t.test(workstream ?? "unscoped", async () => {
      const calls: string[][] = [];
      let raw = rawIssue();
      const store = createLifecycleStore(
        async (_, args) => {
          calls.push([...args]);
          if (args[0] === "create")
            raw = {
              ...raw,
              metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
            };
          return result(raw);
        },
        {
          ...options(),
          readWorkManagementConfig: () => ({
            version: 1,
            ddAuthPath: "/bin/dd-auth",
            curlPath: "/usr/bin/curl",
            defaultTarget,
            workstreams: { "pi-setup": WM_TARGET, local: null },
          }),
        },
      );
      const issue = await store.create(
        { title: "Task", why: "Why", workstream, needsJp: false },
        lifecycle(),
        OWNER,
      );
      const state = issue.metadata.piWorkManagement as
        | WorkManagementState
        | undefined;
      if (expected === null) assert.equal(state, undefined);
      else assert.deepEqual(state?.target, expected);
      assert.deepEqual(
        calls.map((args) => args[0]),
        ["create", "show"],
      );
    });
  }
});

test("legacy configuration leaves unmapped and unscoped tasks local", async () => {
  for (const workstream of ["new-workstream", undefined]) {
    let raw = rawIssue();
    const store = createLifecycleStore(
      async (_, args) => {
        if (args[0] === "create")
          raw = {
            ...raw,
            metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
          };
        return result(raw);
      },
      {
        ...options(),
        readWorkManagementConfig: () => ({
          version: 1,
          ddAuthPath: "/bin/dd-auth",
          curlPath: "/usr/bin/curl",
          workstreams: { "pi-setup": WM_TARGET },
        }),
      },
    );
    const issue = await store.create(
      { title: "Task", why: "Why", workstream, needsJp: false },
      lifecycle(),
      OWNER,
    );
    assert.equal(issue.metadata.piWorkManagement, undefined);
  }
});

test("default changes neither relocate captured tasks nor enroll existing tasks", async () => {
  const config = {
    version: 1 as const,
    ddAuthPath: "/bin/dd-auth",
    curlPath: "/usr/bin/curl",
    defaultTarget: structuredClone(WM_TARGET),
    workstreams: {},
  };
  let raw = rawIssue();
  const store = createLifecycleStore(
    async (_, args) => {
      if (args[0] === "create" || args[0] === "update") {
        raw = {
          ...raw,
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
          ...(args.includes("-s")
            ? { status: args[args.indexOf("-s") + 1] }
            : {}),
        };
      }
      return result(raw);
    },
    { ...options(), readWorkManagementConfig: () => config },
  );
  await store.create(
    { title: "Task", why: "Why", needsJp: false },
    lifecycle(),
    OWNER,
  );
  config.defaultTarget.projectId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  config.defaultTarget.statuses.active = "Different";
  const changed = await store.mutate("jp-1", OWNER, () => claimedMutation());
  assert.deepEqual(
    (changed.metadata.piWorkManagement as WorkManagementState)?.target,
    WM_TARGET,
  );
  raw = rawIssue();
  const existing = await store.mutate("jp-1", OWNER, () => claimedMutation());
  assert.equal(existing.metadata.piWorkManagement, undefined);
});

test("tagged native journal entry survives a lost append response", async () => {
  let raw = rawIssue();
  const comments: unknown[] = [];
  const store = createLifecycleStore(
    async (_, args) => {
      if (args[0] === "create")
        raw = {
          ...raw,
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
        };
      if (args[0] === "comments" && args[1] === "add") {
        comments.push({
          id: "comment-1",
          issue_id: "jp-1",
          text: args[3],
          created_at: NOW,
          author: "test",
        });
        return { code: 1, stdout: "", stderr: "lost response" };
      }
      if (args[0] === "comments")
        return { code: 0, stdout: JSON.stringify(comments), stderr: "" };
      return result(raw);
    },
    {
      ...options(),
      readWorkManagementConfig: () => ({
        version: 1,
        ddAuthPath: "/bin/dd-auth",
        curlPath: "/usr/bin/curl",
        workstreams: { "pi-setup": WM_TARGET },
      }),
    },
  );
  await store.create(
    { title: "Ship", why: "Why", workstream: "pi-setup", needsJp: false },
    lifecycle(),
    OWNER,
  );
  await assert.rejects(
    store.appendComment("jp-1", "progress", OWNER, () => {}),
    /exit code 1/,
  );
  assert.deepEqual(await store.comments("jp-1"), [
    {
      id: "comment-1",
      issueId: "jp-1",
      text: "progress\n\n[pi-task-log:v1]",
      createdAt: NOW,
    },
  ]);
});

test("invalid integration configuration creates no task", async () => {
  let calls = 0;
  const store = createLifecycleStore(
    async () => {
      calls++;
      return result(rawIssue());
    },
    {
      ...options(),
      readWorkManagementConfig: () => {
        throw new Error("invalid integration config");
      },
    },
  );
  await assert.rejects(
    store.create(
      { title: "Ship", why: "Why", needsJp: false },
      lifecycle(),
      OWNER,
    ),
    /invalid integration config/,
  );
  assert.equal(calls, 0);
});

test("malformed sync state cannot block an owned native progress log", async () => {
  const state = lifecycle({
    phase: "active",
    execution: {
      sessionId: OWNER.sessionId,
      claimedAt: NOW,
      lastActivityAt: NOW,
      expiresAt: "2026-09-17T16:00:00.000Z",
      resourceSnapshot: { observedAt: NOW, resourceIds: [] },
    },
  });
  for (const invalid of [
    null,
    {},
    { deliveredCommentIds: ["duplicate", "duplicate"] },
  ]) {
    const current = {
      ...rawIssue(state),
      status: "in_progress",
      metadata: { piLifecycle: state, piWorkManagement: invalid },
    };
    const appended: string[] = [];
    const store = createLifecycleStore(async (_, args) => {
      if (args[0] === "comments") appended.push(args[3]);
      return result(current);
    }, options());
    const validate = (issue: import("./types.js").LifecycleIssue) => {
      if (issue.lifecycle?.execution?.sessionId !== OWNER.sessionId)
        throw new Error("foreign owner");
    };
    await store.appendComment("jp-1", "progress", OWNER, validate);
    assert.deepEqual(appended, ["progress\n\n[pi-task-log:v1]"]);
    current.metadata.piLifecycle = {
      ...state,
      execution: { ...state.execution!, sessionId: "foreign" },
    };
    await assert.rejects(
      store.appendComment("jp-1", "forbidden", OWNER, validate),
      /foreign owner/,
    );
    assert.equal(appended.length, 1);
  }
});

test("enrollment uses the same normalized workstream shown by task displays", async () => {
  let raw = rawIssue();
  const store = createLifecycleStore(
    async (_, args) => {
      if (args[0] === "create")
        raw = {
          ...raw,
          metadata: JSON.parse(args[args.indexOf("--metadata") + 1]),
        };
      return result(raw);
    },
    {
      ...options(),
      readWorkManagementConfig: () => ({
        version: 1,
        ddAuthPath: "/bin/dd-auth",
        curlPath: "/usr/bin/curl",
        workstreams: { "pi-setup": WM_TARGET },
      }),
    },
  );
  const issue = await store.create(
    { title: "task", why: "why", workstream: "PI-SETUP  ", needsJp: false },
    lifecycle(),
    OWNER,
  );
  assert.deepEqual(
    (issue.metadata.piWorkManagement as WorkManagementState)?.target,
    WM_TARGET,
  );
});
