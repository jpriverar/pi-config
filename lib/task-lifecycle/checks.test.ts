import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCheckAdapterRegistry,
  nextCheckBackoffMs,
  type GitHubExecutor,
} from "./checks.js";
import type { Artifact, LifecycleCheck } from "./types.js";

const NOW_MS = Date.parse("2026-09-17T10:00:00.000Z");

function artifact(id: string, pull: number): Artifact {
  return {
    id,
    kind: "pull_request",
    uri: `https://github.com/DataDog/dd-source/pull/${pull}`,
    title: `PR ${pull}`,
    role: "deliverable",
    sourceArtifactIds: [],
    producedAt: new Date(NOW_MS).toISOString(),
    supersededAt: null,
  };
}

function check(
  kind: LifecycleCheck["kind"],
  predicate: Record<string, unknown>,
  targetArtifactIds: string[] = [],
): LifecycleCheck {
  return {
    id: "check-1",
    kind,
    targetArtifactIds,
    predicate,
    onSatisfied: "actionable",
    wakeOn: [],
    state: "pending",
    createdAt: new Date(NOW_MS).toISOString(),
    lastCheckedAt: null,
    nextCheckAt: null,
    lastObservation: null,
    errorCount: 0,
  };
}

function registry(
  states: Record<
    string,
    {
      state: "OPEN" | "CLOSED" | "MERGED";
      reviewDecision: string;
      mergeStateStatus: string;
      mergedAt: string | null;
    }
  > = {},
) {
  const calls: string[][] = [];
  const execGh: GitHubExecutor = async (args) => {
    calls.push([...args]);
    const value = states[args[2]];
    if (value === undefined) {
      return { code: 1, stdout: "", stderr: "not found" };
    }
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  return {
    calls,
    registry: createCheckAdapterRegistry({
      execGh,
      now: () => NOW_MS,
      prPollIntervalMs: 15 * 60 * 1_000,
    }),
  };
}

test("maps open and merged GitHub pull requests deterministically", async () => {
  const open = artifact("pr-open", 1);
  const merged = artifact("pr-merged", 2);
  const h = registry({
    [open.uri]: {
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergedAt: null,
    },
    [merged.uri]: {
      state: "MERGED",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergedAt: "2026-09-17T09:00:00Z",
    },
  });

  assert.deepEqual(
    await h.registry.observe(check("github_pull_request", {}, [open.id]), [
      open,
    ]),
    { outcome: "pending", observation: "0/1 merged" },
  );
  assert.deepEqual(
    await h.registry.observe(check("github_pull_request", {}, [merged.id]), [
      merged,
    ]),
    { outcome: "satisfied", observation: "1/1 merged" },
  );
  assert.deepEqual(h.calls[0], [
    "pr",
    "view",
    open.uri,
    "--json",
    "state,reviewDecision,mergeStateStatus,mergedAt",
  ]);
});

test("maps review, merge conflict, and closed-unmerged states to action required", async () => {
  for (const [pull, state, reviewDecision, mergeStateStatus, observation] of [
    [3, "OPEN", "CHANGES_REQUESTED", "CLEAN", "changes_requested"],
    [4, "OPEN", "APPROVED", "DIRTY", "merge_conflict"],
    [5, "CLOSED", "APPROVED", "CLEAN", "closed_unmerged"],
  ] as const) {
    const target = artifact(`pr-${pull}`, pull);
    const h = registry({
      [target.uri]: {
        state,
        reviewDecision,
        mergeStateStatus,
        mergedAt: null,
      },
    });
    assert.deepEqual(
      await h.registry.observe(check("github_pull_request", {}, [target.id]), [
        target,
      ]),
      { outcome: "action_required", observation },
    );
  }
});

test("evaluates explicit all and any multi-PR predicates", async () => {
  const merged = artifact("pr-merged", 10);
  const open = artifact("pr-open", 11);
  const h = registry({
    [merged.uri]: {
      state: "MERGED",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergedAt: "2026-09-17T09:00:00Z",
    },
    [open.uri]: {
      state: "OPEN",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      mergedAt: null,
    },
  });
  const targets = [merged, open];

  assert.deepEqual(
    await h.registry.observe(
      check(
        "github_pull_request",
        { mode: "all" },
        targets.map((x) => x.id),
      ),
      targets,
    ),
    { outcome: "pending", observation: "1/2 merged" },
  );
  assert.deepEqual(
    await h.registry.observe(
      check(
        "github_pull_request",
        { mode: "any" },
        targets.map((x) => x.id),
      ),
      targets,
    ),
    { outcome: "satisfied", observation: "1/2 merged" },
  );
});

test("compares one RFC3339 time predicate", async () => {
  const h = registry();

  assert.deepEqual(
    await h.registry.observe(
      check("time", { at: "2026-09-17T11:00:00.000Z" }),
      [],
    ),
    { outcome: "pending", observation: "time not reached" },
  );
  assert.deepEqual(
    await h.registry.observe(
      check("time", { at: "2026-09-17T09:00:00.000Z" }),
      [],
    ),
    { outcome: "satisfied", observation: "time reached" },
  );
});

test("manual checks remain pending when overdue without explicit input", async () => {
  const h = registry();

  assert.deepEqual(
    await h.registry.observe(
      check("manual", { reviewAt: "2026-09-17T09:00:00.000Z" }),
      [],
    ),
    { outcome: "pending", observation: "manual review overdue" },
  );
  assert.deepEqual(
    await h.registry.observe(
      check("manual", { reviewAt: "2026-09-17T11:00:00.000Z" }),
      [],
    ),
    { outcome: "pending", observation: "manual review pending" },
  );
});

test("manual checks accept only explicit terminal input", async () => {
  const h = registry();
  const manual = check("manual", {
    reviewAt: "2026-09-17T09:00:00.000Z",
  });

  assert.deepEqual(
    await h.registry.observe(manual, [], { manualOutcome: "satisfied" }),
    { outcome: "satisfied", observation: "manual input: satisfied" },
  );
  assert.deepEqual(
    await h.registry.observe(manual, [], {
      manualOutcome: "action_required",
    }),
    {
      outcome: "action_required",
      observation: "manual input: action_required",
    },
  );
});

test("returns curated adapter errors and bounded exponential backoff", async () => {
  const target = artifact("missing", 404);
  const h = registry();

  assert.deepEqual(
    await h.registry.observe(check("github_pull_request", {}, [target.id]), [
      target,
    ]),
    { outcome: "error", observation: "gh exited with code 1" },
  );
  assert.equal(nextCheckBackoffMs(1, 1_000, 8_000), 1_000);
  assert.equal(nextCheckBackoffMs(2, 1_000, 8_000), 2_000);
  assert.equal(nextCheckBackoffMs(20, 1_000, 8_000), 8_000);
});
