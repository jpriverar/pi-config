import assert from "node:assert/strict";
import { test } from "node:test";

import type { OwnerIdentity } from "../../extensions/worktree-pool/operation-lock.js";
import type {
  AcquireRequest,
  AcquireResult,
  PoolListing,
  ReleaseResult,
} from "../../extensions/worktree-pool/pool.js";
import {
  normalizeLabelUpdate,
  TaskLifecycleService,
  type TaskLifecyclePoolPort,
} from "./service.js";
import type {
  ArtifactInput,
  LifecycleCheck,
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecycleStatus,
  LifecycleStore,
  LockOwner,
} from "./types.js";

const NOW_MS = Date.parse("2026-09-17T10:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

function session(sessionId: string): LockOwner {
  return { pid: 123, sessionId, host: "host", started: NOW_MS - 1_000 };
}

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

function lifecycleCheck(
  overrides: Partial<LifecycleCheck> = {},
): LifecycleCheck {
  return {
    id: "check-1",
    kind: "manual",
    targetArtifactIds: [],
    predicate: { reviewAt: NOW },
    onSatisfied: "actionable",
    wakeOn: [],
    state: "pending",
    createdAt: NOW,
    lastCheckedAt: null,
    nextCheckAt: NOW,
    lastObservation: null,
    errorCount: 0,
    ...overrides,
  };
}

function issue(
  state: LifecycleMetadataV1 | null = lifecycle(),
): LifecycleIssue {
  return {
    id: "jp-1",
    title: "Lifecycle task",
    status: state?.phase === "active" ? "in_progress" : "open",
    metadata: state === null ? {} : { piLifecycle: state },
    lifecycle: state,
    dependencies: [],
  };
}

function activeIssue(id: string, sessionId: string): LifecycleIssue {
  return {
    ...issue(
      lifecycle({
        phase: "active",
        execution: {
          sessionId,
          claimedAt: NOW,
          lastActivityAt: NOW,
          expiresAt: new Date(NOW_MS + 60_000).toISOString(),
          resourceSnapshot: { observedAt: NOW, resourceIds: [] },
        },
      }),
    ),
    id,
  };
}

class FakeStore implements LifecycleStore {
  saved: LifecycleIssue;
  listed: LifecycleIssue[] | null = null;
  blockers: Array<[string, string]> = [];
  comments: string[] = [];
  labelUpdates: Array<{ addLabels: string[]; removeLabels: string[] }> = [];
  mutations = 0;
  beforeMutate?: () => void;

  constructor(initial: LifecycleIssue = issue()) {
    this.saved = initial;
  }

  async show(): Promise<LifecycleIssue> {
    return this.saved;
  }

  async list(_statuses: readonly LifecycleStatus[]): Promise<LifecycleIssue[]> {
    return this.listed ?? [this.saved];
  }

  async readyIds(): Promise<ReadonlySet<string>> {
    return new Set(this.saved.status === "open" ? [this.saved.id] : []);
  }

  async create(
    input: {
      title: string;
      why: string;
      workstream?: string;
      needsJp: boolean;
    },
    state: LifecycleMetadataV1,
    _owner: LockOwner,
  ): Promise<LifecycleIssue> {
    this.saved = {
      ...issue(state),
      id: "jp-created",
      title: input.title,
    };
    return this.saved;
  }

  async updateLabels(
    _id: string,
    input: { addLabels: string[]; removeLabels: string[] },
    _owner: LockOwner,
  ): Promise<LifecycleIssue> {
    this.labelUpdates.push(input);
    return this.saved;
  }

  async appendComment(
    _id: string,
    message: string,
    _owner: LockOwner,
    validate: (issue: LifecycleIssue) => void,
  ): Promise<LifecycleIssue> {
    validate(this.saved);
    this.comments.push(message);
    return this.saved;
  }

  failActiveResourceOnce = false;

  async mutate(
    _id: string,
    _owner: LockOwner,
    operation: Parameters<LifecycleStore["mutate"]>[2],
  ): Promise<LifecycleIssue> {
    this.mutations += 1;
    const beforeMutate = this.beforeMutate;
    this.beforeMutate = undefined;
    beforeMutate?.();
    const mutation = operation(this.saved);
    if (
      this.failActiveResourceOnce &&
      mutation.lifecycle.resources.some(
        (resource) => resource.cleanupState === "active",
      )
    ) {
      this.failActiveResourceOnce = false;
      throw new Error("simulated finalization failure");
    }
    this.saved = {
      ...this.saved,
      status: mutation.status,
      lifecycle: mutation.lifecycle,
      metadata: { ...this.saved.metadata, piLifecycle: mutation.lifecycle },
    };
    return this.saved;
  }

  async addBlocker(
    dependentId: string,
    blockerId: string,
    _owner: LockOwner,
  ): Promise<void> {
    this.blockers.push([dependentId, blockerId]);
    this.saved = {
      ...this.saved,
      dependencies: [
        ...this.saved.dependencies,
        { id: blockerId, status: "open", dependencyType: "blocks" },
      ],
    };
  }
}

function service(
  store: FakeStore,
  options: {
    pool?: TaskLifecyclePoolPort;
    now?: () => number;
    checkAdapters?: any;
    activityWriteIntervalMs?: number;
    prPollIntervalMs?: number;
    maxBackoffMs?: number;
  } = {},
) {
  let uuid = 0;
  return new TaskLifecycleService({
    store,
    now: options.now ?? (() => NOW_MS),
    uuid: () => `generated-${++uuid}`,
    executionTimeoutMs: 6 * 60 * 60 * 1_000,
    pool: options.pool,
    checkAdapters: options.checkAdapters,
    activityWriteIntervalMs: options.activityWriteIntervalMs ?? 300_000,
    prPollIntervalMs: options.prPollIntervalMs ?? 900_000,
    maxBackoffMs: options.maxBackoffMs ?? 21_600_000,
  });
}

test("creates managed actionable tasks", async () => {
  const store = new FakeStore(issue(null));

  const created = await service(store).create(
    {
      title: "Ship it",
      why: "Required",
      workstream: "pi-setup",
      needsJp: false,
    },
    session("s1"),
  );

  assert.equal(created.id, "jp-created");
  assert.equal(created.status, "open");
  assert.equal(created.lifecycle?.phase, "actionable");
});

test("updates labels without adopting legacy lifecycle", async () => {
  const store = new FakeStore(issue(null));

  const saved = await service(store).updateLabels(
    "jp-1",
    { addLabels: ["priority:high"], removeLabels: ["priority:low"] },
    session("s1"),
  );

  assert.equal(saved.lifecycle, null);
  assert.deepEqual(store.labelUpdates, [
    { addLabels: ["priority:high"], removeLabels: ["priority:low"] },
  ]);
});

test("rejects empty and overlapping label updates", () => {
  assert.throws(
    () => normalizeLabelUpdate({ addLabels: [], removeLabels: [] }),
    /at least one label change/,
  );
  assert.throws(
    () =>
      normalizeLabelUpdate({
        addLabels: ["priority"],
        removeLabels: ["priority"],
      }),
    /both add and remove/,
  );
});

test("logs only while the same session owns the active task", async () => {
  const store = new FakeStore(activeIssue("jp-1", "s1"));

  await assert.rejects(
    service(store).log("jp-1", "progress", session("other")),
    /owned by active session s1/,
  );
  assert.deepEqual(store.comments, []);

  await service(store).log("jp-1", "progress", session("s1"));
  assert.deepEqual(store.comments, ["progress"]);
});

test("claims a legacy task into active ownership", async () => {
  const store = new FakeStore(issue(null));

  const saved = await service(store).claim("jp-1", session("s1"), "claim-1");

  assert.equal(saved.lifecycle?.phase, "active");
  assert.equal(saved.status, "in_progress");
  assert.equal(saved.lifecycle?.execution?.sessionId, "s1");
  assert.equal(
    saved.lifecycle?.execution?.expiresAt,
    "2026-09-17T16:00:00.000Z",
  );
});

test("claims a legacy blocked task without inventing a structured check", async () => {
  const store = new FakeStore({ ...issue(null), status: "blocked" });

  const saved = await service(store).claim("jp-1", session("s1"), "claim-1");

  assert.equal(saved.lifecycle?.phase, "active");
  assert.equal(saved.status, "in_progress");
  assert.equal(saved.lifecycle?.waiting, null);
  assert.equal(saved.lifecycle?.activeCheck, null);
});

test("claims dependency-waiting work without dropping blockers", async () => {
  const waiting = lifecycle({
    phase: "waiting",
    waiting: { kind: "dependency" },
  });
  const store = new FakeStore({
    ...issue(waiting),
    dependencies: [
      { id: "jp-blocker", status: "open", dependencyType: "blocks" },
    ],
  });

  const saved = await service(store).claim("jp-1", session("s1"), "claim-1");

  assert.equal(saved.lifecycle?.phase, "active");
  assert.deepEqual(saved.lifecycle?.waiting, { kind: "dependency" });
  assert.equal(saved.dependencies[0]?.status, "open");
});

test("claims check-waiting work without dropping its check", async () => {
  const waiting = lifecycle({
    phase: "waiting",
    waiting: { kind: "check" },
    activeCheck: lifecycleCheck(),
  });
  const store = new FakeStore({ ...issue(waiting), status: "blocked" });

  const saved = await service(store).claim("jp-1", session("s1"), "claim-1");

  assert.equal(saved.lifecycle?.phase, "active");
  assert.deepEqual(saved.lifecycle?.waiting, { kind: "check" });
  assert.equal(saved.lifecycle?.activeCheck?.id, "check-1");
});

test("returns active work to its retained condition", async () => {
  const active = activeIssue("jp-1", "s1");
  active.lifecycle = {
    ...active.lifecycle!,
    waiting: { kind: "check" },
    activeCheck: lifecycleCheck(),
  };
  active.metadata = { piLifecycle: active.lifecycle };
  const store = new FakeStore(active);

  const saved = await service(store).waitOnExistingCondition(
    "jp-1",
    session("s1"),
    "wait-1",
  );

  assert.equal(saved.lifecycle?.phase, "waiting");
  assert.equal(saved.lifecycle?.execution, null);
  assert.equal(saved.lifecycle?.activeCheck?.id, "check-1");
  assert.equal(saved.status, "blocked");
});

test("resolves explicit Active tasks owned by one session", async () => {
  const store = new FakeStore();
  const waiting = {
    ...issue(lifecycle({ phase: "waiting", waiting: { kind: "dependency" } })),
    id: "jp-waiting",
  };
  const legacy = {
    ...issue(null),
    id: "jp-legacy",
    status: "in_progress" as const,
  };
  store.listed = [
    activeIssue("jp-z", "session-a"),
    activeIssue("jp-foreign", "session-b"),
    waiting,
    legacy,
    activeIssue("jp-a", "session-a"),
  ];
  const sut = service(store);

  const owned = await sut.activeTasksForSession("session-a");

  assert.deepEqual(
    owned.map((candidate) => candidate.id),
    ["jp-a", "jp-z"],
  );
  assert.equal(await sut.hasActiveTask("session-a"), true);
  assert.deepEqual(await sut.activeTasksForSession("missing"), []);
});

test("rejects a claim owned by another live session", async () => {
  const store = new FakeStore();
  const sut = service(store);
  await sut.claim("jp-1", session("s1"), "claim-1");

  await assert.rejects(
    sut.claim("jp-1", session("s2"), "claim-2"),
    /owned by active session s1/,
  );
});

test("waits on native blockers without duplicating blocker IDs in metadata", async () => {
  const store = new FakeStore();
  const sut = service(store);
  await sut.claim("jp-1", session("s1"), "claim-1");

  const saved = await sut.waitForDependencies(
    "jp-1",
    ["jp-blocker", "jp-blocker"],
    session("s1"),
    "wait-1",
  );

  assert.deepEqual(store.blockers, [["jp-1", "jp-blocker"]]);
  assert.equal(saved.status, "open");
  assert.deepEqual(saved.lifecycle?.waiting, { kind: "dependency" });
  assert.equal(saved.lifecycle?.activeCheck, null);
  assert.doesNotMatch(JSON.stringify(saved.lifecycle), /jp-blocker/);
});

test("waits on exactly one typed external check", async () => {
  const store = new FakeStore();
  const sut = service(store);
  await sut.claim("jp-1", session("s1"), "claim-1");
  const check: LifecycleCheck = {
    id: "check-1",
    kind: "manual",
    targetArtifactIds: [],
    predicate: { reviewAt: "2026-09-18T10:00:00.000Z" },
    onSatisfied: "actionable",
    wakeOn: ["manual"],
    state: "pending",
    createdAt: NOW,
    lastCheckedAt: null,
    nextCheckAt: "2026-09-18T10:00:00.000Z",
    lastObservation: null,
    errorCount: 0,
  };

  const saved = await sut.waitForCheck(
    "jp-1",
    check,
    session("s1"),
    "wait-check-1",
  );

  assert.equal(saved.status, "blocked");
  assert.deepEqual(saved.lifecycle?.activeCheck, check);
  assert.deepEqual(saved.lifecycle?.waiting, { kind: "check" });
});

test("canonicalizes and deduplicates attached artifacts by identity", async () => {
  const store = new FakeStore();
  const sut = service(store);
  await sut.claim("jp-1", session("s1"), "claim-1");
  const artifact: ArtifactInput = {
    id: "artifact-1",
    kind: "pull_request",
    uri: "HTTPS://GitHub.COM/DataDog/dd-source/pull/42/",
    title: "Implementation",
    role: "deliverable",
  };

  await sut.attachArtifact("jp-1", artifact, session("s1"), "attach-1");
  const saved = await sut.attachArtifact(
    "jp-1",
    { ...artifact, id: "artifact-2", sourceArtifactIds: ["source-1"] },
    session("s1"),
    "attach-2",
  );

  assert.equal(saved.lifecycle?.artifacts.length, 1);
  assert.equal(
    saved.lifecycle?.artifacts[0].uri,
    "https://github.com/DataDog/dd-source/pull/42",
  );
  assert.deepEqual(saved.lifecycle?.artifacts[0].sourceArtifactIds, [
    "source-1",
  ]);
});

test("closes with a disposition and reopens according to native blockers", async () => {
  const store = new FakeStore();
  const sut = service(store);
  await sut.claim("jp-1", session("s1"), "claim-1");

  const closed = await sut.close(
    "jp-1",
    {
      kind: "completed",
      reason: "acceptance checks passed",
      evidenceArtifactIds: [],
    },
    session("s1"),
    "close-1",
  );
  assert.equal(closed.status, "closed");
  assert.equal(closed.lifecycle?.disposition?.kind, "completed");

  store.saved = {
    ...store.saved,
    dependencies: [
      { id: "jp-blocker", status: "open", dependencyType: "blocks" },
    ],
  };
  const reopened = await sut.reopen(
    "jp-1",
    "new acceptance gap",
    session("s1"),
    "reopen-1",
  );
  assert.equal(reopened.status, "open");
  assert.equal(reopened.lifecycle?.phase, "waiting");
  assert.deepEqual(reopened.lifecycle?.waiting, { kind: "dependency" });
});

test("blocks completed but permits cancelled with unresolved dependencies", async () => {
  const blocked = activeIssue("jp-1", "s1");
  blocked.dependencies = [
    { id: "jp-blocker", status: "open", dependencyType: "blocks" },
  ];
  const completedStore = new FakeStore(blocked);

  await assert.rejects(
    service(completedStore).close(
      "jp-1",
      { kind: "completed", reason: "done", evidenceArtifactIds: [] },
      session("s1"),
      "close-completed",
    ),
    /unresolved condition/,
  );
  assert.equal(completedStore.saved.lifecycle?.phase, "active");

  const cancelledStore = new FakeStore(blocked);
  const cancelled = await service(cancelledStore).close(
    "jp-1",
    { kind: "cancelled", reason: "obsolete", evidenceArtifactIds: [] },
    session("s1"),
    "close-cancelled",
  );
  assert.equal(cancelled.lifecycle?.phase, "done");
  assert.equal(cancelled.lifecycle?.disposition?.kind, "cancelled");

  const checked = activeIssue("jp-1", "s1");
  checked.lifecycle = {
    ...checked.lifecycle!,
    waiting: { kind: "check" },
    activeCheck: lifecycleCheck(),
  };
  checked.metadata = { piLifecycle: checked.lifecycle };
  await assert.rejects(
    service(new FakeStore(checked)).close(
      "jp-1",
      { kind: "completed", reason: "done", evidenceArtifactIds: [] },
      session("s1"),
      "close-check",
    ),
    /unresolved condition/,
  );
});

test("rechecks completion conditions inside the locked mutation", async () => {
  const store = new FakeStore(activeIssue("jp-1", "s1"));
  store.beforeMutate = () => {
    store.saved = {
      ...store.saved,
      dependencies: [
        { id: "jp-blocker", status: "open", dependencyType: "blocks" },
      ],
    };
  };

  await assert.rejects(
    service(store).close(
      "jp-1",
      { kind: "completed", reason: "done", evidenceArtifactIds: [] },
      session("s1"),
      "close-raced",
    ),
    /unresolved condition/,
  );
  assert.equal(store.saved.lifecycle?.phase, "active");
  assert.equal(store.saved.status, "in_progress");
});

test("returns expired ownership to actionable with one idempotent event", async () => {
  const store = new FakeStore();
  const sut = service(store, { now: () => NOW_MS });
  await sut.claim("jp-1", session("s1"), "claim-1");
  const afterExpiry = service(store, {
    now: () => NOW_MS + 6 * 60 * 60 * 1_000 + 1,
  });

  const first = await afterExpiry.reconcileExecutionTimeout(
    "jp-1",
    session("reconciler"),
  );
  const second = await afterExpiry.reconcileExecutionTimeout(
    "jp-1",
    session("reconciler"),
  );

  assert.equal(first.lifecycle?.phase, "actionable");
  assert.equal(first.status, "open");
  assert.equal(second.lifecycle?.transitionHistory.length, 2);
  assert.equal(
    second.lifecycle?.transitionHistory.at(-1)?.type,
    "execution_interrupted",
  );
});

test("expired retained conditions return to waiting", async (t) => {
  for (const kind of ["dependency", "check"] as const) {
    await t.test(kind, async () => {
      const active = activeIssue("jp-1", "s1");
      active.lifecycle = {
        ...active.lifecycle!,
        waiting: { kind },
        activeCheck: kind === "check" ? lifecycleCheck() : null,
      };
      active.metadata = { piLifecycle: active.lifecycle };
      if (kind === "dependency") {
        active.dependencies = [
          { id: "jp-blocker", status: "open", dependencyType: "blocks" },
        ];
      }
      const store = new FakeStore(active);
      const sut = service(store, { now: () => NOW_MS + 60_001 });

      const saved = await sut.reconcileExecutionTimeout(
        "jp-1",
        session("reconciler"),
      );

      assert.equal(saved.lifecycle?.phase, "waiting");
      assert.equal(saved.lifecycle?.execution, null);
      assert.equal(saved.status, kind === "check" ? "blocked" : "open");
      assert.deepEqual(saved.lifecycle?.waiting, { kind });
    });
  }
});

test("session interruption returns retained conditions to waiting", async (t) => {
  for (const kind of ["dependency", "check"] as const) {
    await t.test(kind, async () => {
      const active = activeIssue("jp-1", "s1");
      active.lifecycle = {
        ...active.lifecycle!,
        waiting: { kind },
        activeCheck: kind === "check" ? lifecycleCheck() : null,
      };
      active.metadata = { piLifecycle: active.lifecycle };
      if (kind === "dependency") {
        active.dependencies = [
          { id: "jp-blocker", status: "open", dependencyType: "blocks" },
        ];
      }
      const store = new FakeStore(active);

      const [saved] = await service(store).interruptSession(
        session("s1"),
        "quit",
      );

      assert.equal(saved.lifecycle?.phase, "waiting");
      assert.equal(saved.lifecycle?.execution, null);
      assert.equal(saved.status, kind === "check" ? "blocked" : "open");
      assert.deepEqual(saved.lifecycle?.waiting, { kind });
    });
  }
});

test("interruption releases retained-condition worktrees before waiting", async (t) => {
  for (const path of ["shutdown", "expiry"] as const) {
    for (const kind of ["dependency", "check"] as const) {
      await t.test(`${path} ${kind}`, async () => {
        const { store, pool, sut } = await activeServiceWithPool();
        const acquired = await sut.acquireWorktree(
          {
            taskId: "jp-1",
            repository: "DataDog/dd-source",
            branch: `jpriverar/${path}-${kind}`,
          },
          session("s1"),
          `acquire-${path}-${kind}`,
        );
        const claimId = acquired.lifecycle!.resources[0].claimId;
        store.saved.lifecycle = {
          ...store.saved.lifecycle!,
          waiting: { kind },
          activeCheck: kind === "check" ? lifecycleCheck() : null,
        };
        store.saved.metadata = { piLifecycle: store.saved.lifecycle };
        store.saved.dependencies =
          kind === "dependency"
            ? [{ id: "jp-blocker", status: "open", dependencyType: "blocks" }]
            : [];

        const saved =
          path === "shutdown"
            ? (await sut.interruptSession(session("s1"), "quit"))[0]
            : await service(store, {
                pool: pool as TaskLifecyclePoolPort,
                now: () => NOW_MS + 6 * 60 * 60 * 1_000 + 1,
              }).reconcileExecutionTimeout("jp-1", session("reconciler"));

        assert.equal(saved.lifecycle?.phase, "waiting");
        assert.equal(saved.lifecycle?.execution, null);
        assert.equal(saved.status, kind === "check" ? "blocked" : "open");
        assert.equal(saved.lifecycle?.resources[0].cleanupState, "released");
        assert.equal(pool.entries.has(claimId), false);
      });
    }
  }
});

test("cleanup refusal preserves retained-condition ownership during interruption", async (t) => {
  for (const path of ["shutdown", "expiry"] as const) {
    for (const kind of ["dependency", "check"] as const) {
      await t.test(`${path} ${kind}`, async () => {
        const { store, pool, sut } = await activeServiceWithPool();
        const acquired = await sut.acquireWorktree(
          {
            taskId: "jp-1",
            repository: "DataDog/dd-source",
            branch: `jpriverar/refuse-${path}-${kind}`,
          },
          session("s1"),
          `acquire-refuse-${path}-${kind}`,
        );
        const claimId = acquired.lifecycle!.resources[0].claimId;
        store.saved.lifecycle = {
          ...store.saved.lifecycle!,
          waiting: { kind },
          activeCheck: kind === "check" ? lifecycleCheck() : null,
        };
        store.saved.metadata = { piLifecycle: store.saved.lifecycle };
        store.saved.dependencies =
          kind === "dependency"
            ? [{ id: "jp-blocker", status: "open", dependencyType: "blocks" }]
            : [];
        pool.refuseRelease = true;

        const interrupt =
          path === "shutdown"
            ? () => sut.interruptSession(session("s1"), "quit")
            : () =>
                service(store, {
                  pool: pool as TaskLifecyclePoolPort,
                  now: () => NOW_MS + 6 * 60 * 60 * 1_000 + 1,
                }).reconcileExecutionTimeout("jp-1", session("reconciler"));

        await assert.rejects(interrupt(), /still owns worktree/);
        assert.equal(store.saved.lifecycle?.phase, "active");
        assert.equal(store.saved.lifecycle?.execution?.sessionId, "s1");
        assert.equal(
          store.saved.lifecycle?.resources[0].cleanupState,
          "release_pending",
        );
        assert.equal(pool.entries.has(claimId), true);
        assert.equal(pool.releaseCalls.length, 1);
      });
    }
  }
});

test("expiry cleanup does not release a concurrently renewed lease", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  const acquired = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/renew-before-cleanup",
    },
    session("s1"),
    "acquire-renew-before-cleanup",
  );
  const claimId = acquired.lifecycle!.resources[0].claimId;
  const renewedExpiresAt = new Date(
    NOW_MS + 12 * 60 * 60 * 1_000,
  ).toISOString();
  store.beforeMutate = () => {
    store.saved.lifecycle = {
      ...store.saved.lifecycle!,
      execution: {
        ...store.saved.lifecycle!.execution!,
        lastActivityAt: new Date(NOW_MS + 6 * 60 * 60 * 1_000).toISOString(),
        expiresAt: renewedExpiresAt,
      },
    };
    store.saved.metadata = { piLifecycle: store.saved.lifecycle };
  };

  await assert.rejects(
    service(store, {
      pool: pool as TaskLifecyclePoolPort,
      now: () => NOW_MS + 6 * 60 * 60 * 1_000 + 1,
    }).reconcileExecutionTimeout("jp-1", session("reconciler")),
    /still owns worktree/,
  );

  assert.equal(store.saved.lifecycle?.phase, "active");
  assert.equal(store.saved.lifecycle?.execution?.expiresAt, renewedExpiresAt);
  assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "active");
  assert.equal(pool.entries.has(claimId), true);
  assert.equal(pool.releaseCalls.length, 0);
});

test("expiry cleanup reservation suppresses concurrent activity renewal", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  const acquired = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/renew-after-reservation",
    },
    session("s1"),
    "acquire-renew-after-reservation",
  );
  const claimId = acquired.lifecycle!.resources[0].claimId;
  const expiredNow = NOW_MS + 6 * 60 * 60 * 1_000 + 1;
  const renewer = service(store, {
    pool: pool as TaskLifecyclePoolPort,
    now: () => expiredNow,
    activityWriteIntervalMs: 0,
  });
  let refreshResults = -1;
  pool.onRelease = async () => {
    refreshResults = (await renewer.refreshSessionActivity(session("s1")))
      .length;
  };

  const saved = await service(store, {
    pool: pool as TaskLifecyclePoolPort,
    now: () => expiredNow,
  }).reconcileExecutionTimeout("jp-1", session("reconciler"));

  assert.equal(refreshResults, 0);
  assert.equal(saved.lifecycle?.phase, "actionable");
  assert.equal(saved.lifecycle?.execution, null);
  assert.equal(saved.lifecycle?.resources[0].cleanupState, "released");
  assert.equal(pool.entries.has(claimId), false);
});

test("deduplicates retried operations by explicit operation ID", async () => {
  const store = new FakeStore();
  const sut = service(store);

  const first = await sut.claim("jp-1", session("s1"), "claim-1");
  const retried = await sut.claim("jp-1", session("s1"), "claim-1");

  assert.equal(first.lifecycle?.transitionHistory.length, 1);
  assert.equal(retried.lifecycle?.transitionHistory.length, 1);
});

test("deduplicates a retried wait before adding blockers or releasing again", async () => {
  const store = new FakeStore();
  const sut = service(store);
  await sut.claim("jp-1", session("s1"), "claim-1");
  const first = await sut.waitForDependencies(
    "jp-1",
    ["jp-blocker"],
    session("s1"),
    "wait-1",
  );

  const retried = await sut.waitForDependencies(
    "jp-1",
    ["jp-blocker"],
    session("s1"),
    "wait-1",
  );

  assert.equal(retried, first);
  assert.deepEqual(store.blockers, [["jp-1", "jp-blocker"]]);
  assert.equal(retried.lifecycle?.transitionHistory.length, 2);
});

test("keeps phase and ownership active when resource release fails", async () => {
  const active = lifecycle({
    phase: "active",
    execution: {
      sessionId: "s1",
      claimedAt: NOW,
      lastActivityAt: NOW,
      expiresAt: "2026-09-17T16:00:00.000Z",
      resourceSnapshot: { observedAt: NOW, resourceIds: ["resource-1"] },
    },
    resources: [
      {
        id: "resource-1",
        kind: "worktree",
        repository: "repo",
        claimId: "claim-1",
        pathId: "path-1",
        operationId: "acquire-1",
        path: "/tmp/worktree",
        branch: "jpriverar/topic",
        branchArtifactId: null,
        acquiredAt: NOW,
        releasedAt: null,
        cleanupState: "active",
      },
    ],
  });
  const store = new FakeStore(issue(active));
  const pool: TaskLifecyclePoolPort = {
    async list() {
      throw new Error("unexpected list");
    },
    async acquire() {
      throw new Error("unexpected acquire");
    },
    async release() {
      throw new Error("worktree is dirty");
    },
  };

  await assert.rejects(
    service(store, { pool }).close(
      "jp-1",
      { kind: "cancelled", reason: "stop", evidenceArtifactIds: [] },
      session("s1"),
      "close-1",
    ),
    /task jp-1 still owns worktree claim-1; make it releasable or release it before waiting/,
  );

  assert.equal(store.saved.lifecycle?.phase, "active");
  assert.equal(store.saved.lifecycle?.execution?.sessionId, "s1");
});

class FakeTaskPool {
  onAcquire?: () => void;
  onRelease?: () => void | Promise<void>;
  refuseRelease = false;
  duplicateClaims = false;
  acquireCalls: Array<{
    request: AcquireRequest;
    owner: OwnerIdentity;
    identity: { claimId: string; pathId: string };
  }> = [];
  releaseCalls: Array<{
    repository: string;
    claimId: string;
    owner: OwnerIdentity;
  }> = [];
  entries = new Map<
    string,
    {
      repository: string;
      claimId: string;
      path: string;
      branch: string;
      head: string;
      clean: boolean;
      valid: boolean;
    }
  >();

  async list(repository?: string): Promise<PoolListing> {
    const names =
      repository === undefined
        ? [
            ...new Set(
              [...this.entries.values()].map((entry) => entry.repository),
            ),
          ]
        : [repository];
    return {
      repositories: names.map((name) => {
        const entries = [...this.entries.values()].filter(
          (entry) => entry.repository === name,
        );
        const worktrees = entries.map((entry) => ({
          claimId: entry.claimId,
          path: entry.path,
          state: entry.valid && entry.clean ? "active" : "needs-attention",
          branch: entry.branch,
          currentBranch: entry.valid
            ? `refs/heads/${entry.branch}`
            : "refs/heads/contradiction",
          head: entry.head,
          clean: entry.clean,
          branchProtectsHead: entry.valid,
          evidence: {
            pathExists: true,
            registered: entry.valid,
            nativeClaimMatches: entry.valid,
          },
        }));
        return {
          name,
          capacity: 3,
          used: worktrees.length,
          worktrees:
            this.duplicateClaims && worktrees.length > 0
              ? [...worktrees, { ...worktrees[0] }]
              : worktrees,
        };
      }),
    };
  }

  async acquire(
    request: AcquireRequest,
    owner: OwnerIdentity,
    identity: { claimId: string; pathId: string },
  ): Promise<AcquireResult> {
    this.onAcquire?.();
    this.acquireCalls.push({ request, owner, identity });
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const path = `/pool/worktree-${identity.pathId}`;
    this.entries.set(identity.claimId, {
      repository: request.repository,
      claimId: identity.claimId,
      path,
      branch: request.branch,
      head,
      clean: true,
      valid: true,
    });
    return {
      claimId: identity.claimId,
      path,
      branch: request.branch,
      reused: false,
      head,
      startPoint: request.startPoint ?? "origin/main",
      startPointHead: head,
      startPointFetched: true,
      relationship: "equal",
    };
  }

  async release(
    repository: string,
    claimId: string,
    owner: OwnerIdentity,
  ): Promise<ReleaseResult> {
    await this.onRelease?.();
    this.releaseCalls.push({ repository, claimId, owner });
    const entry = this.entries.get(claimId);
    if (!this.refuseRelease) this.entries.delete(claimId);
    return {
      path: entry?.path ?? "/pool/released",
      released: entry !== undefined && !this.refuseRelease,
    };
  }
}

async function activeServiceWithPool() {
  const store = new FakeStore();
  const pool = new FakeTaskPool();
  const sut = service(store, { pool: pool as TaskLifecyclePoolPort });
  await sut.claim("jp-1", session("s1"), "claim-task");
  return { store, pool, sut };
}

test("defers only after releasing task worktrees", async () => {
  const { pool, sut } = await activeServiceWithPool();
  const owner = session("s1");
  const request = {
    repository: "pi-config",
    branch: "jpriverar/topic",
    startPoint: "origin/main",
  };
  const identity = {
    claimId: "11111111-1111-4111-8111-111111111111",
    pathId: "22222222-2222-4222-8222-222222222222",
  };
  const acquired = await pool.acquire(request, owner, identity);
  await sut.recordWorktreeAcquire(
    { ...request, taskId: "jp-1" },
    acquired,
    owner,
    "acquire-1",
  );

  const saved = await sut.defer("jp-1", "Lower priority", owner, "defer-1");

  assert.equal(pool.releaseCalls.length, 1);
  assert.equal(saved.lifecycle?.phase, "deferred");
  assert.equal(saved.lifecycle?.execution, null);
  assert.equal(saved.lifecycle?.resources[0]?.cleanupState, "released");
  assert.equal(saved.status, "deferred");
});

test("records a pool-generated acquisition after the tool succeeds", async () => {
  const { pool, sut } = await activeServiceWithPool();
  const pathId = "22222222-2222-4222-8222-222222222222";
  const acquired: AcquireResult = {
    claimId: "11111111-1111-4111-8111-111111111111",
    path: `/pool/worktree-${pathId}`,
    branch: "jpriverar/topic",
    reused: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    startPoint: "origin/main",
    startPointHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    startPointFetched: true,
    relationship: "equal",
  };
  pool.entries.set(acquired.claimId, {
    repository: "DataDog/dd-source",
    claimId: acquired.claimId,
    path: acquired.path,
    branch: acquired.branch,
    head: acquired.head,
    clean: true,
    valid: true,
  });

  const saved = await sut.recordWorktreeAcquire(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: acquired.branch,
    },
    acquired,
    session("s1"),
    "tool-call-1",
  );

  const resource = saved.lifecycle?.resources[0];
  assert.deepEqual(
    {
      repository: resource?.repository,
      claimId: resource?.claimId,
      pathId: resource?.pathId,
      operationId: resource?.operationId,
      path: resource?.path,
      branch: resource?.branch,
      cleanupState: resource?.cleanupState,
    },
    {
      repository: "DataDog/dd-source",
      claimId: acquired.claimId,
      pathId,
      operationId: "tool-call-1",
      path: acquired.path,
      branch: acquired.branch,
      cleanupState: "active",
    },
  );
  assert.deepEqual(resource?.lastObservation, {
    claimId: acquired.claimId,
    path: acquired.path,
    state: "active",
    branch: acquired.branch,
    currentBranch: `refs/heads/${acquired.branch}`,
    head: acquired.head,
    clean: true,
    branchProtectsHead: true,
    evidence: {
      pathExists: true,
      registered: true,
      nativeClaimMatches: true,
    },
  });

  const retried = await sut.recordWorktreeAcquire(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: acquired.branch,
    },
    acquired,
    session("s1"),
    "tool-call-1",
  );
  assert.equal(retried.lifecycle?.resources.length, 1);
});

test("rejects contradictory pool evidence for a generated acquisition", async () => {
  const { pool, sut } = await activeServiceWithPool();
  const acquired: AcquireResult = {
    claimId: "11111111-1111-4111-8111-111111111111",
    path: "/pool/worktree-22222222-2222-4222-8222-222222222222",
    branch: "jpriverar/topic",
    reused: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    startPoint: "origin/main",
    startPointHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    startPointFetched: true,
    relationship: "equal",
  };
  pool.entries.set(acquired.claimId, {
    repository: "DataDog/dd-source",
    claimId: acquired.claimId,
    path: "/pool/worktree-33333333-3333-4333-8333-333333333333",
    branch: acquired.branch,
    head: acquired.head,
    clean: true,
    valid: true,
  });

  await assert.rejects(
    sut.recordWorktreeAcquire(
      {
        taskId: "jp-1",
        repository: "DataDog/dd-source",
        branch: acquired.branch,
      },
      acquired,
      session("s1"),
      "tool-call-1",
    ),
    /contradictory worktree association/,
  );
});

test("prepares worktree acquisition before pool mutation and finalizes its receipt", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  const prepared = await sut.prepareWorktreeAcquire(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "tool-call-1",
  );

  assert.equal(pool.acquireCalls.length, 0);
  assert.deepEqual(prepared, {
    version: 1,
    mode: "acquire",
    taskId: "jp-1",
    operationId: "tool-call-1",
    claimId: "generated-1",
    pathId: "generated-2",
    repository: "DataDog/dd-source",
  });
  assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "acquiring");

  const saved = await sut.finalizeWorktreeAcquire(
    prepared,
    {
      claimId: "generated-1",
      path: "/pool/worktree-generated-2",
      branch: "jpriverar/topic",
      reused: false,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startPoint: "origin/main",
      startPointHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startPointFetched: true,
      relationship: "equal",
    },
    session("s1"),
  );

  assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
  assert.equal(
    saved.lifecycle?.resources[0].path,
    "/pool/worktree-generated-2",
  );
});

test("reuses pending acquisition identity across ordinary tool retries", async () => {
  const { store, sut } = await activeServiceWithPool();
  const request = {
    taskId: "jp-1",
    repository: "DataDog/dd-source",
    branch: "jpriverar/topic",
  };

  const first = await sut.prepareWorktreeAcquire(
    request,
    session("s1"),
    "tool-call-1",
  );
  const retry = await sut.prepareWorktreeAcquire(
    request,
    session("s1"),
    "tool-call-2",
  );

  assert.deepEqual(retry, first);
  assert.equal(store.saved.lifecycle?.resources.length, 1);
});

test("prepares and finalizes release separately from the pool mutation", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  const acquired = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "acquire-1",
  );
  const claimId = acquired.lifecycle!.resources[0].claimId;

  const prepared = await sut.prepareWorktreeRelease(
    "jp-1",
    claimId,
    session("s1"),
    "release-1",
  );
  assert.equal(pool.releaseCalls.length, 0);
  assert.equal(
    store.saved.lifecycle?.resources[0].cleanupState,
    "release_pending",
  );

  const retry = await sut.prepareWorktreeRelease(
    "jp-1",
    claimId,
    session("s1"),
    "release-2",
  );
  assert.deepEqual(retry, prepared);

  pool.entries.delete(claimId);
  const released = await sut.finalizeWorktreeRelease(prepared, session("s1"));
  assert.equal(released.lifecycle?.resources[0].cleanupState, "released");
});

test("finds every lifecycle task associated with a claim deterministically", async () => {
  const store = new FakeStore();
  const resource = {
    id: "worktree:claim-1",
    kind: "worktree" as const,
    repository: "repo",
    claimId: "claim-1",
    pathId: "path-1",
    operationId: "acquire-1",
    path: "/pool/path-1",
    branch: "topic",
    branchArtifactId: null,
    acquiredAt: NOW,
    releasedAt: null,
    cleanupState: "active" as const,
  };
  store.listed = [
    {
      ...activeIssue("jp-z", "s2"),
      lifecycle: lifecycle({ resources: [resource] }),
    },
    {
      ...activeIssue("jp-a", "s1"),
      lifecycle: lifecycle({ resources: [resource] }),
    },
  ];

  const associated = await service(store).associatedTasksForClaim("claim-1");

  assert.deepEqual(
    associated.map((candidate) => candidate.id),
    ["jp-a", "jp-z"],
  );
});

test("reconciles an exact pending acquisition from pool evidence", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  const prepared = await sut.prepareWorktreeAcquire(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "acquire-pending",
  );
  await pool.acquire(
    { repository: prepared.repository, branch: "jpriverar/topic" },
    session("s1"),
    { claimId: prepared.claimId, pathId: prepared.pathId },
  );

  const saved = await sut.reconcileTask("jp-1", session("reconciler"));

  assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
  assert.equal(
    saved.lifecycle?.resources[0].path,
    `/pool/worktree-${prepared.pathId}`,
  );
  assert.equal(store.saved.lifecycle?.artifacts[0].kind, "branch");
});

test("reconciles a pending release after the pool claim disappeared", async () => {
  const { pool, sut } = await activeServiceWithPool();
  const acquired = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "acquire-1",
  );
  const claimId = acquired.lifecycle!.resources[0].claimId;
  await sut.prepareWorktreeRelease(
    "jp-1",
    claimId,
    session("s1"),
    "release-pending",
  );
  pool.entries.delete(claimId);

  const saved = await sut.reconcileTask("jp-1", session("reconciler"));

  assert.equal(saved.lifecycle?.resources[0].cleanupState, "released");
});

test("leaves missing, ambiguous, and contradictory acquisitions pending", async () => {
  for (const evidence of ["missing", "ambiguous", "contradictory"] as const) {
    const { store, pool, sut } = await activeServiceWithPool();
    const prepared = await sut.prepareWorktreeAcquire(
      {
        taskId: "jp-1",
        repository: "DataDog/dd-source",
        branch: "jpriverar/topic",
      },
      session("s1"),
      `acquire-${evidence}`,
    );
    if (evidence !== "missing") {
      await pool.acquire(
        { repository: prepared.repository, branch: "jpriverar/topic" },
        session("s1"),
        { claimId: prepared.claimId, pathId: prepared.pathId },
      );
    }
    if (evidence === "ambiguous") pool.duplicateClaims = true;
    if (evidence === "contradictory") {
      pool.entries.get(prepared.claimId)!.valid = false;
    }

    await assert.rejects(
      sut.reconcileTask("jp-1", session("reconciler")),
      new RegExp(`${evidence} worktree association.*${prepared.claimId}`),
    );
    assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "acquiring");
  }
});

test("pending acquisition prevents waiting or closing", async () => {
  const { store, sut } = await activeServiceWithPool();
  const prepared = await sut.prepareWorktreeAcquire(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "acquire-pending",
  );
  const reason = new RegExp(
    `task jp-1 still owns worktree ${prepared.claimId}; make it releasable or release it before waiting`,
  );

  await assert.rejects(
    sut.waitForDependencies("jp-1", ["jp-blocker"], session("s1"), "wait-1"),
    reason,
  );
  await assert.rejects(
    sut.close(
      "jp-1",
      { kind: "cancelled", reason: "stop", evidenceArtifactIds: [] },
      session("s1"),
      "close-1",
    ),
    reason,
  );
  assert.equal(store.saved.lifecycle?.phase, "active");
  assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "acquiring");
});

test("releases active worktrees before waiting or closing", async () => {
  for (const transition of ["wait", "close"] as const) {
    const { pool, sut } = await activeServiceWithPool();
    const acquired = await sut.acquireWorktree(
      {
        taskId: "jp-1",
        repository: "DataDog/dd-source",
        branch: `jpriverar/${transition}`,
      },
      session("s1"),
      `acquire-${transition}`,
    );
    const claimId = acquired.lifecycle!.resources[0].claimId;

    const saved =
      transition === "wait"
        ? await sut.waitForDependencies(
            "jp-1",
            ["jp-blocker"],
            session("s1"),
            "wait-1",
          )
        : await sut.close(
            "jp-1",
            { kind: "cancelled", reason: "stop", evidenceArtifactIds: [] },
            session("s1"),
            "close-1",
          );

    assert.equal(
      saved.lifecycle?.phase,
      transition === "wait" ? "waiting" : "done",
    );
    assert.equal(saved.lifecycle?.resources[0].cleanupState, "released");
    assert.equal(pool.entries.has(claimId), false);
  }
});

test("acquires with persisted deterministic identities and attaches the branch", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  pool.onAcquire = () => {
    assert.equal(store.saved.lifecycle?.resources[0].cleanupState, "acquiring");
  };

  const saved = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "tool-call-1",
  );

  assert.deepEqual(pool.acquireCalls[0].identity, {
    claimId: "generated-1",
    pathId: "generated-2",
  });
  assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
  assert.equal(
    saved.lifecycle?.resources[0].branchArtifactId,
    saved.lifecycle?.artifacts[0].id,
  );
});

test("retries finalization by exact claim without allocating twice", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  store.failActiveResourceOnce = true;
  const request = {
    taskId: "jp-1",
    repository: "DataDog/dd-source",
    branch: "jpriverar/topic",
  };

  await assert.rejects(
    sut.acquireWorktree(request, session("s1"), "tool-call-1"),
    /simulated finalization failure/,
  );
  const saved = await sut.acquireWorktree(
    request,
    session("s1"),
    "tool-call-1",
  );

  assert.equal(pool.acquireCalls.length, 1);
  assert.equal(saved.lifecycle?.resources[0].claimId, "generated-1");
  assert.equal(saved.lifecycle?.resources[0].cleanupState, "active");
});

test("allows distinct healthy and dirty resources but rejects a duplicate pair", async () => {
  const { pool, sut } = await activeServiceWithPool();
  await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic-a",
    },
    session("s1"),
    "acquire-a",
  );
  pool.entries.get("generated-1")!.clean = false;

  const saved = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-go",
      branch: "jpriverar/topic-b",
    },
    session("s1"),
    "acquire-b",
  );
  assert.equal(saved.lifecycle?.resources.length, 2);

  await assert.rejects(
    sut.acquireWorktree(
      {
        taskId: "jp-1",
        repository: "DataDog/dd-source",
        branch: "refs/heads/jpriverar/topic-a",
      },
      session("s1"),
      "acquire-duplicate",
    ),
    /duplicate unreleased worktree resource/,
  );
});

test("blocks another acquire when an exact resource association contradicts the pool", async () => {
  const { pool, sut } = await activeServiceWithPool();
  await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic-a",
    },
    session("s1"),
    "acquire-a",
  );
  pool.entries.get("generated-1")!.valid = false;

  await assert.rejects(
    sut.acquireWorktree(
      {
        taskId: "jp-1",
        repository: "DataDog/dd-go",
        branch: "jpriverar/topic-b",
      },
      session("s1"),
      "acquire-b",
    ),
    /contradictory worktree association.*generated-1/,
  );
});

test("persists release intent before the pool call and finalizes afterward", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  const acquired = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "acquire-1",
  );
  const claimId = acquired.lifecycle!.resources[0].claimId;
  pool.onRelease = () => {
    assert.equal(
      store.saved.lifecycle?.resources[0].cleanupState,
      "release_pending",
    );
  };

  const released = await sut.releaseWorktree(
    "jp-1",
    claimId,
    session("s1"),
    "release-1",
  );

  assert.equal(pool.releaseCalls.length, 1);
  assert.equal(released.lifecycle?.resources[0].cleanupState, "released");
  assert.equal(released.lifecycle?.resources[0].releasedAt, NOW);
});

function waitingLifecycle(
  kind: "dependency" | "check",
  activeCheck: LifecycleCheck | null = null,
): LifecycleMetadataV1 {
  return lifecycle({
    phase: "waiting",
    waiting: { kind },
    activeCheck,
  });
}

function adapter(outcome: string, observation: string) {
  return {
    calls: 0,
    async observe() {
      this.calls += 1;
      return { outcome, observation };
    },
  };
}

test("reconciles the final native blocker to actionable exactly once", async () => {
  const state = waitingLifecycle("dependency");
  const store = new FakeStore({
    ...issue(state),
    status: "open",
    dependencies: [
      { id: "jp-blocker", status: "closed", dependencyType: "blocks" },
    ],
  });
  const sut = service(store);

  const first = await sut.reconcileTask("jp-1", session("reconciler"));
  const second = await sut.reconcileTask("jp-1", session("reconciler"));

  assert.equal(first.lifecycle?.phase, "actionable");
  assert.equal(second.lifecycle?.transitionHistory.length, 1);
  assert.equal(
    second.lifecycle?.transitionHistory[0].type,
    "dependencies_satisfied",
  );
});

test("closes a due satisfied check and wakes action-required work exactly once", async () => {
  const pull = {
    id: "pr-1",
    kind: "pull_request" as const,
    uri: "https://github.com/DataDog/dd-source/pull/1",
    title: "PR",
    role: "deliverable" as const,
    sourceArtifactIds: [],
    producedAt: NOW,
    supersededAt: null,
  };
  const baseCheck: LifecycleCheck = {
    id: "check-1",
    kind: "github_pull_request",
    targetArtifactIds: [pull.id],
    predicate: {},
    onSatisfied: "close",
    wakeOn: [],
    state: "pending",
    createdAt: NOW,
    lastCheckedAt: null,
    nextCheckAt: NOW,
    lastObservation: null,
    errorCount: 0,
  };
  const satisfied = adapter("satisfied", "1/1 merged");
  const closedStore = new FakeStore({
    ...issue(waitingLifecycle("check", baseCheck)),
    status: "blocked",
    lifecycle: waitingLifecycle("check", baseCheck),
  });
  closedStore.saved.lifecycle!.artifacts = [pull];
  const closedService = service(closedStore, { checkAdapters: satisfied });

  const closed = await closedService.reconcileTask(
    "jp-1",
    session("reconciler"),
  );
  await closedService.reconcileTask("jp-1", session("reconciler"));
  assert.equal(closed.status, "closed");
  assert.equal(closed.lifecycle?.phase, "done");
  assert.equal(satisfied.calls, 1);

  const action = adapter("action_required", "changes_requested");
  const actionCheck = { ...baseCheck, onSatisfied: "actionable" as const };
  const actionState = waitingLifecycle("check", actionCheck);
  actionState.artifacts = [pull];
  const actionStore = new FakeStore({
    ...issue(actionState),
    status: "blocked",
  });
  const actionable = await service(actionStore, {
    checkAdapters: action,
  }).reconcileTask("jp-1", session("reconciler"));
  assert.equal(actionable.status, "open");
  assert.equal(actionable.lifecycle?.phase, "actionable");
  assert.equal(actionable.lifecycle?.checkHistory[0].state, "action_required");
});

test("does not clear a retained dependency when a blocker appears during reconciliation", async () => {
  const active = activeIssue("jp-1", "s1");
  active.lifecycle = {
    ...active.lifecycle!,
    waiting: { kind: "dependency" },
  };
  active.metadata = { piLifecycle: active.lifecycle };
  const store = new FakeStore(active);
  store.beforeMutate = () => {
    store.saved = {
      ...store.saved,
      dependencies: [
        { id: "jp-blocker", status: "open", dependencyType: "blocks" },
      ],
    };
  };

  await assert.rejects(
    service(store).reconcileTask("jp-1", session("reconciler")),
    /active work without a waiting condition must not have unresolved blockers/,
  );
  assert.equal(store.saved.lifecycle?.phase, "active");
  assert.deepEqual(store.saved.lifecycle?.waiting, { kind: "dependency" });
});

test("satisfied retained checks do not close active work", async () => {
  const active = activeIssue("jp-1", "s1");
  const execution = active.lifecycle!.execution;
  active.lifecycle = {
    ...active.lifecycle!,
    waiting: { kind: "check" },
    activeCheck: lifecycleCheck({ onSatisfied: "close" }),
  };
  active.metadata = { piLifecycle: active.lifecycle };
  const store = new FakeStore(active);

  const saved = await service(store, {
    checkAdapters: adapter("satisfied", "merged"),
  }).reconcileTask("jp-1", session("reconciler"));

  assert.equal(saved.lifecycle?.phase, "active");
  assert.deepEqual(saved.lifecycle?.execution, execution);
  assert.equal(saved.lifecycle?.waiting, null);
  assert.equal(saved.lifecycle?.activeCheck, null);
  assert.equal(saved.lifecycle?.checkHistory.at(-1)?.state, "satisfied");
});

test("pending polls update check observation without changing phase timestamps", async () => {
  const pending = adapter("pending", "0/1 merged");
  const activeCheck: LifecycleCheck = {
    id: "check-1",
    kind: "manual",
    targetArtifactIds: [],
    predicate: { reviewAt: NOW },
    onSatisfied: "actionable",
    wakeOn: [],
    state: "pending",
    createdAt: NOW,
    lastCheckedAt: null,
    nextCheckAt: NOW,
    lastObservation: null,
    errorCount: 0,
  };
  const state = waitingLifecycle("check", activeCheck);
  const store = new FakeStore({ ...issue(state), status: "blocked" });

  const saved = await service(store, {
    checkAdapters: pending,
  }).reconcileTask("jp-1", session("reconciler"));

  assert.equal(saved.lifecycle?.stateEnteredAt, NOW);
  assert.equal(saved.lifecycle?.lastProgressAt, NOW);
  assert.equal(saved.lifecycle?.activeCheck?.lastCheckedAt, NOW);
  assert.equal(saved.lifecycle?.activeCheck?.lastObservation, "0/1 merged");
  assert.equal(
    saved.lifecycle?.activeCheck?.nextCheckAt,
    "2026-09-17T10:15:00.000Z",
  );
});

test("adapter errors remain waiting with bounded backoff", async () => {
  const errors = adapter("error", "gh exited with code 1");
  const activeCheck: LifecycleCheck = {
    id: "check-1",
    kind: "github_pull_request",
    targetArtifactIds: [],
    predicate: {},
    onSatisfied: "actionable",
    wakeOn: [],
    state: "pending",
    createdAt: NOW,
    lastCheckedAt: null,
    nextCheckAt: NOW,
    lastObservation: null,
    errorCount: 2,
  };
  const state = waitingLifecycle("check", activeCheck);
  const store = new FakeStore({ ...issue(state), status: "blocked" });

  const saved = await service(store, {
    checkAdapters: errors,
    prPollIntervalMs: 1_000,
    maxBackoffMs: 8_000,
  }).reconcileTask("jp-1", session("reconciler"));

  assert.equal(saved.lifecycle?.phase, "waiting");
  assert.equal(saved.lifecycle?.activeCheck?.state, "error");
  assert.equal(saved.lifecycle?.activeCheck?.errorCount, 3);
  assert.equal(
    saved.lifecycle?.activeCheck?.nextCheckAt,
    "2026-09-17T10:00:04.000Z",
  );
});

test("reconcileDue honors task and check limits", async () => {
  const store = new FakeStore();
  const sut = service(store);
  const reconciled: string[] = [];
  (sut as any).reconcileTask = async (id: string) => {
    reconciled.push(id);
    return store.saved;
  };
  store.list = async () =>
    ["jp-1", "jp-2", "jp-3"].map((id) => ({ ...store.saved, id }));

  await sut.reconcileDue(session("reconciler"), {
    taskLimit: 2,
    checkLimit: 1,
  });

  assert.deepEqual(reconciled, ["jp-1", "jp-2"]);
});

test("activity refresh is rate-limited and extends a long-running execution", async () => {
  let now = NOW_MS;
  const store = new FakeStore();
  const sut = service(store, {
    now: () => now,
    activityWriteIntervalMs: 300_000,
  });
  await sut.claim("jp-1", session("s1"), "claim-1");
  const afterClaimMutations = store.mutations;

  await sut.refreshSessionActivity(session("s1"));
  assert.equal(store.mutations, afterClaimMutations);
  now += 300_001;
  const refreshed = await sut.refreshSessionActivity(session("s1"));

  assert.equal(store.mutations, afterClaimMutations + 1);
  assert.equal(
    refreshed[0].lifecycle?.execution?.lastActivityAt,
    new Date(now).toISOString(),
  );
  assert.equal(
    refreshed[0].lifecycle?.execution?.expiresAt,
    new Date(now + 6 * 60 * 60 * 1_000).toISOString(),
  );
});

test("session interruption preserves reload but relinquishes other shutdowns", async () => {
  const store = new FakeStore();
  const sut = service(store);
  await sut.claim("jp-1", session("s1"), "claim-1");

  const preserved = await sut.interruptSession(session("s1"), "reload");
  assert.equal(preserved.length, 0);
  assert.equal(store.saved.lifecycle?.phase, "active");

  const interrupted = await sut.interruptSession(session("s1"), "quit");
  assert.equal(interrupted[0].lifecycle?.phase, "actionable");
  assert.equal(interrupted[0].status, "open");
});

test("preserves release-pending when the pool refuses release", async () => {
  const { store, pool, sut } = await activeServiceWithPool();
  const acquired = await sut.acquireWorktree(
    {
      taskId: "jp-1",
      repository: "DataDog/dd-source",
      branch: "jpriverar/topic",
    },
    session("s1"),
    "acquire-refused",
  );
  const claimId = acquired.lifecycle!.resources[0].claimId;
  pool.refuseRelease = true;

  await assert.rejects(
    sut.releaseWorktree("jp-1", claimId, session("s1"), "release-refused"),
    /worktree release refused/,
  );

  assert.equal(store.saved.lifecycle?.phase, "active");
  assert.equal(
    store.saved.lifecycle?.resources[0].cleanupState,
    "release_pending",
  );
  assert.equal(pool.entries.has(claimId), true);
});
