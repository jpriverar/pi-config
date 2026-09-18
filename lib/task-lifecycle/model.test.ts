import assert from "node:assert/strict";
import test from "node:test";

import {
  adoptLegacyLifecycle,
  attachArtifact,
  canonicalizeArtifact,
  claimLifecycle,
  closeLifecycle,
  decodeLifecycle,
  interruptLifecycle,
  reopenLifecycle,
  validateLifecycle,
  waitLifecycle,
} from "./model.js";
import type {
  Artifact,
  LifecycleCheck,
  LifecycleIssue,
  LifecycleMetadataV1,
  WorktreeResource,
} from "./types.js";

const NOW = "2026-09-17T04:00:00.000Z";
const LATER = "2026-09-17T05:00:00.000Z";

function baseLifecycle(
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
  status: LifecycleIssue["status"],
  lifecycle: LifecycleMetadataV1,
  dependencies: LifecycleIssue["dependencies"] = [],
): LifecycleIssue {
  return {
    id: "jp-test",
    title: "Test lifecycle",
    status,
    metadata: { unrelated: { keep: true }, piLifecycle: lifecycle },
    lifecycle,
    dependencies,
  };
}

function check(overrides: Partial<LifecycleCheck> = {}): LifecycleCheck {
  return {
    id: "check-1",
    kind: "manual",
    targetArtifactIds: [],
    predicate: { reviewAt: LATER },
    onSatisfied: "actionable",
    wakeOn: [],
    state: "pending",
    createdAt: NOW,
    lastCheckedAt: null,
    nextCheckAt: LATER,
    lastObservation: null,
    errorCount: 0,
    ...overrides,
  };
}

function resource(overrides: Partial<WorktreeResource> = {}): WorktreeResource {
  return {
    id: "resource-1",
    kind: "worktree",
    repository: "dd-source",
    claimId: "123e4567-e89b-42d3-a456-426614174000",
    pathId: "223e4567-e89b-42d3-a456-426614174001",
    operationId: "operation-1",
    path: "/tmp/worktree",
    branch: "refs/heads/jpriverar/example",
    branchArtifactId: null,
    acquiredAt: NOW,
    releasedAt: null,
    cleanupState: "active",
    ...overrides,
  };
}

test("decodes a complete version-1 lifecycle without coercion", () => {
  const lifecycle = baseLifecycle();
  assert.deepEqual(decodeLifecycle(lifecycle), { ok: true, value: lifecycle });
});

test("reports unsupported, malformed, and unknown lifecycle values", () => {
  assert.deepEqual(decodeLifecycle({ version: 2 }), {
    ok: false,
    warning: "unsupported piLifecycle version 2",
  });

  for (const [name, value] of [
    ["phase", baseLifecycle({ phase: "blocked" as never })],
    ["timestamp", baseLifecycle({ stateEnteredAt: "yesterday" })],
    ["disposition", baseLifecycle({ disposition: { kind: "done" } as never })],
    [
      "check state",
      baseLifecycle({ activeCheck: check({ state: "open" as never }) }),
    ],
    [
      "resource state",
      baseLifecycle({
        resources: [resource({ cleanupState: "lost" as never })],
      }),
    ],
  ] as const) {
    const decoded = decodeLifecycle(value);
    assert.equal(decoded.ok, false, name);
    if (!decoded.ok)
      assert.match(decoded.warning, new RegExp(name.split(" ")[0], "i"));
  }
});

test("validates every phase and native status projection", () => {
  const execution = {
    sessionId: "session-a",
    claimedAt: NOW,
    lastActivityAt: NOW,
    expiresAt: LATER,
    resourceSnapshot: { observedAt: NOW, resourceIds: [] },
  };
  const disposition = {
    kind: "completed" as const,
    reason: "Acceptance passed",
    at: LATER,
    evidenceArtifactIds: [],
  };
  const blocker = {
    id: "jp-blocker",
    status: "open" as const,
    dependencyType: "blocks",
  };

  const cases: Array<
    [
      LifecycleMetadataV1,
      LifecycleIssue["status"],
      LifecycleIssue["dependencies"],
    ]
  > = [
    [baseLifecycle(), "open", []],
    [baseLifecycle({ phase: "active", execution }), "in_progress", []],
    [
      baseLifecycle({ phase: "waiting", waiting: { kind: "dependency" } }),
      "open",
      [blocker],
    ],
    [
      baseLifecycle({
        phase: "waiting",
        waiting: { kind: "check" },
        activeCheck: check(),
      }),
      "blocked",
      [],
    ],
    [baseLifecycle({ phase: "deferred" }), "deferred", []],
    [baseLifecycle({ phase: "done", disposition }), "closed", []],
  ];
  for (const [lifecycle, status, dependencies] of cases) {
    assert.doesNotThrow(() =>
      validateLifecycle(lifecycle, issue(status, lifecycle, dependencies)),
    );
  }
});

test("rejects active state without exactly one execution lease", () => {
  const lifecycle = baseLifecycle({ phase: "active", execution: null });
  assert.throws(
    () => validateLifecycle(lifecycle, issue("in_progress", lifecycle)),
    /phase active requires one execution lease/,
  );
});

test("rejects each invalid waiting authority combination", () => {
  const blocker = {
    id: "jp-blocker",
    status: "open" as const,
    dependencyType: "blocks",
  };
  const dependencyWait = baseLifecycle({
    phase: "waiting",
    waiting: { kind: "dependency" },
    activeCheck: check(),
  });
  assert.throws(
    () =>
      validateLifecycle(
        dependencyWait,
        issue("open", dependencyWait, [blocker]),
      ),
    /dependency wait must not have an active check/,
  );

  const checkWait = baseLifecycle({
    phase: "waiting",
    waiting: { kind: "check" },
    activeCheck: check(),
  });
  assert.throws(
    () => validateLifecycle(checkWait, issue("blocked", checkWait, [blocker])),
    /check wait must not have unresolved blockers/,
  );
});

test("requires disposition for done and no execution outside active", () => {
  const done = baseLifecycle({ phase: "done" });
  assert.throws(
    () => validateLifecycle(done, issue("closed", done)),
    /disposition/,
  );

  const actionable = baseLifecycle({
    execution: {
      sessionId: "session-a",
      claimedAt: NOW,
      lastActivityAt: NOW,
      expiresAt: LATER,
      resourceSnapshot: { observedAt: NOW, resourceIds: [] },
    },
  });
  assert.throws(
    () => validateLifecycle(actionable, issue("open", actionable)),
    /only phase active may retain an execution lease/,
  );
});

test("rejects duplicate unreleased repository and full branch pairs", () => {
  const lifecycle = baseLifecycle({
    phase: "active",
    execution: {
      sessionId: "session-a",
      claimedAt: NOW,
      lastActivityAt: NOW,
      expiresAt: LATER,
      resourceSnapshot: { observedAt: NOW, resourceIds: [] },
    },
    resources: [
      resource(),
      resource({
        id: "resource-2",
        claimId: "323e4567-e89b-42d3-a456-426614174002",
        pathId: "423e4567-e89b-42d3-a456-426614174003",
      }),
    ],
  });
  assert.throws(
    () => validateLifecycle(lifecycle, issue("in_progress", lifecycle)),
    /duplicate unreleased worktree resource.*dd-source.*refs\/heads\/jpriverar\/example/,
  );
});

test("adopts legacy issues for read-only presentation", () => {
  const statuses: Array<
    [
      LifecycleIssue["status"],
      ReadonlySet<string>,
      LifecycleIssue["dependencies"],
      LifecycleMetadataV1["phase"],
      string | undefined,
    ]
  > = [
    ["closed", new Set(), [], "done", undefined],
    ["deferred", new Set(), [], "deferred", undefined],
    [
      "blocked",
      new Set(),
      [],
      "waiting",
      "legacy blocked issue has no structured check",
    ],
    [
      "in_progress",
      new Set(),
      [],
      "actionable",
      "legacy in_progress ownership was not trusted",
    ],
    [
      "open",
      new Set(),
      [{ id: "jp-b", status: "open", dependencyType: "blocks" }],
      "waiting",
      undefined,
    ],
    ["open", new Set(["jp-test"]), [], "actionable", undefined],
  ];

  for (const [status, readyIds, dependencies, phase, warning] of statuses) {
    const legacy = issue(status, baseLifecycle(), dependencies);
    legacy.lifecycle = null;
    delete legacy.metadata.piLifecycle;
    const adopted = adoptLegacyLifecycle(legacy, readyIds, NOW);
    assert.equal(adopted.lifecycle.phase, phase);
    if (warning === undefined) assert.deepEqual(adopted.warnings, []);
    else assert.ok(adopted.warnings.includes(warning));
  }
});

test("canonicalizes and idempotently attaches typed artifacts", () => {
  const artifact = canonicalizeArtifact(
    {
      id: "artifact-pr",
      kind: "pull_request",
      uri: "HTTPS://GitHub.com/DataDog/dd-source/pull/123/?utm=test#discussion",
      title: "  Fix lifecycle  ",
      role: "deliverable",
      sourceArtifactIds: ["artifact-branch", "artifact-branch"],
    },
    NOW,
    "session-a",
  );
  assert.deepEqual(artifact, {
    id: "artifact-pr",
    kind: "pull_request",
    uri: "https://github.com/DataDog/dd-source/pull/123",
    title: "Fix lifecycle",
    role: "deliverable",
    sourceArtifactIds: ["artifact-branch"],
    producedAt: NOW,
    producedBySession: "session-a",
    supersededAt: null,
  });

  const state = baseLifecycle({
    artifacts: [
      {
        ...artifact,
        id: "existing-pr",
        producedBySession: undefined,
        sourceArtifactIds: [],
      },
    ],
  });
  const attached = attachArtifact(state, artifact);
  assert.equal(attached.artifacts.length, 1);
  assert.equal(attached.artifacts[0].id, "existing-pr");
  assert.equal(attached.artifacts[0].producedBySession, "session-a");
  assert.deepEqual(attached.artifacts[0].sourceArtifactIds, [
    "artifact-branch",
  ]);
});

test("requires canonical branch identities and rejects task artifacts", () => {
  assert.throws(
    () =>
      canonicalizeArtifact(
        {
          id: "artifact-branch",
          kind: "branch",
          uri: "jpriverar/example",
          title: "branch",
          role: "supporting",
          sourceArtifactIds: [],
        },
        NOW,
      ),
    /branch URI.*repository.*refs\/heads/,
  );
  assert.throws(
    () =>
      canonicalizeArtifact(
        {
          id: "artifact-task",
          kind: "task" as never,
          uri: "jp-other",
          title: "task",
          role: "supporting",
          sourceArtifactIds: [],
        },
        NOW,
      ),
    /artifact kind/,
  );
});

test("performs idempotent claim, wait, close, and reopen transitions", () => {
  const claimed = claimLifecycle(baseLifecycle(), {
    operationId: "claim-1",
    sessionId: "session-a",
    now: NOW,
    expiresAt: LATER,
    resourceSnapshot: { observedAt: NOW, resourceIds: [] },
  });
  assert.equal(claimed.phase, "active");
  assert.equal(claimed.execution?.sessionId, "session-a");
  assert.deepEqual(
    claimLifecycle(claimed, {
      operationId: "claim-1",
      sessionId: "session-a",
      now: NOW,
      expiresAt: LATER,
      resourceSnapshot: { observedAt: NOW, resourceIds: [] },
    }),
    claimed,
  );

  const released = { ...claimed, resources: [] };
  const waiting = waitLifecycle(released, {
    operationId: "wait-1",
    now: LATER,
    kind: "check",
    check: check(),
  });
  assert.equal(waiting.phase, "waiting");
  assert.equal(waiting.execution, null);
  assert.equal(waiting.activeCheck?.id, "check-1");

  const closable = baseLifecycle({
    phase: "waiting",
    waiting: { kind: "check" },
    activeCheck: check({ state: "satisfied" }),
  });
  const done = closeLifecycle(closable, {
    operationId: "close-1",
    now: LATER,
    disposition: {
      kind: "completed",
      reason: "Acceptance passed",
      at: LATER,
      evidenceArtifactIds: [],
    },
  });
  assert.equal(done.phase, "done");
  assert.equal(done.activeCheck, null);
  assert.equal(done.checkHistory.length, 1);

  const reopened = reopenLifecycle(done, {
    operationId: "reopen-1",
    now: LATER,
    reason: "Regression found",
    hasUnresolvedBlockers: true,
  });
  assert.equal(reopened.phase, "waiting");
  assert.deepEqual(reopened.waiting, { kind: "dependency" });
  assert.equal(reopened.disposition, null);
});

test("idempotently interrupts expired active ownership", () => {
  const active = claimLifecycle(baseLifecycle(), {
    operationId: "claim-1",
    sessionId: "session-a",
    now: NOW,
    expiresAt: LATER,
    resourceSnapshot: { observedAt: NOW, resourceIds: [] },
  });
  const interrupted = interruptLifecycle(active, {
    operationId: "interrupt-1",
    now: LATER,
    expectedSessionId: "session-a",
  });

  assert.equal(interrupted.phase, "actionable");
  assert.equal(interrupted.execution, null);
  assert.deepEqual(interrupted.transitionHistory.at(-1), {
    operationId: "interrupt-1",
    type: "execution_interrupted",
    at: LATER,
    from: "active",
    to: "actionable",
    sessionId: "session-a",
    reason: `last activity ${NOW}; observed ${LATER}`,
  });
  assert.deepEqual(
    interruptLifecycle(interrupted, {
      operationId: "interrupt-1",
      now: LATER,
      expectedSessionId: "session-a",
    }),
    interrupted,
  );
});

test("refuses waiting or done transitions while worktrees remain unreleased", () => {
  const active = baseLifecycle({
    phase: "active",
    execution: {
      sessionId: "session-a",
      claimedAt: NOW,
      lastActivityAt: NOW,
      expiresAt: LATER,
      resourceSnapshot: { observedAt: NOW, resourceIds: ["resource-1"] },
    },
    resources: [resource()],
  });
  assert.throws(
    () =>
      waitLifecycle(active, {
        operationId: "wait-1",
        now: LATER,
        kind: "dependency",
      }),
    /unreleased worktree/,
  );
  assert.throws(
    () =>
      closeLifecycle(
        { ...active, execution: null },
        {
          operationId: "close-1",
          now: LATER,
          disposition: {
            kind: "completed",
            reason: "Done",
            at: LATER,
            evidenceArtifactIds: [],
          },
        },
      ),
    /unreleased worktree/,
  );
});
