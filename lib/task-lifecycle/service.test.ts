import assert from "node:assert/strict";
import { test } from "node:test";

import { TaskLifecycleService, type TaskLifecyclePoolPort } from "./service.js";
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

class FakeStore implements LifecycleStore {
  saved: LifecycleIssue;
  blockers: Array<[string, string]> = [];
  mutations = 0;

  constructor(initial: LifecycleIssue = issue()) {
    this.saved = initial;
  }

  async show(): Promise<LifecycleIssue> {
    return this.saved;
  }

  async list(_statuses: readonly LifecycleStatus[]): Promise<LifecycleIssue[]> {
    return [this.saved];
  }

  async readyIds(): Promise<ReadonlySet<string>> {
    return new Set(this.saved.status === "open" ? [this.saved.id] : []);
  }

  async mutate(
    _id: string,
    _owner: LockOwner,
    operation: Parameters<LifecycleStore["mutate"]>[2],
  ): Promise<LifecycleIssue> {
    this.mutations += 1;
    const mutation = operation(this.saved);
    this.saved = {
      ...this.saved,
      status: mutation.status,
      lifecycle: mutation.lifecycle,
      metadata: { ...this.saved.metadata, piLifecycle: mutation.lifecycle },
    };
    return this.saved;
  }

  async addBlocker(dependentId: string, blockerId: string): Promise<void> {
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
  options: { pool?: TaskLifecyclePoolPort; now?: () => number } = {},
) {
  let uuid = 0;
  return new TaskLifecycleService({
    store,
    now: options.now ?? (() => NOW_MS),
    uuid: () => `generated-${++uuid}`,
    executionTimeoutMs: 6 * 60 * 60 * 1_000,
    pool: options.pool,
  });
}

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
    /worktree is dirty/,
  );

  assert.equal(store.saved.lifecycle?.phase, "active");
  assert.equal(store.saved.lifecycle?.execution?.sessionId, "s1");
});
