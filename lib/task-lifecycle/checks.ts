import type { Artifact, LifecycleCheck } from "./types.js";

export interface GitHubExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitHubExecutor = (
  args: readonly string[],
) => Promise<GitHubExecutionResult>;

export type CheckOutcome =
  | "pending"
  | "satisfied"
  | "action_required"
  | "error";

export interface CheckObservation {
  outcome: CheckOutcome;
  observation: string;
}

export interface ObserveCheckInput {
  manualOutcome?: "satisfied" | "action_required";
}

export interface CheckAdapterRegistry {
  observe(
    check: LifecycleCheck,
    artifacts: readonly Artifact[],
    input?: ObserveCheckInput,
  ): Promise<CheckObservation>;
}

export interface CheckAdapterRegistryDependencies {
  execGh: GitHubExecutor;
  now(): number;
  prPollIntervalMs: number;
}

interface PullRequestState {
  state: string;
  reviewDecision: string;
  mergeStateStatus: string;
  mergedAt: string | null;
}

export function createCheckAdapterRegistry(
  deps: CheckAdapterRegistryDependencies,
): CheckAdapterRegistry {
  return {
    async observe(check, artifacts, input = {}) {
      if (check.kind === "github_pull_request") {
        return observePullRequests(check, artifacts, deps.execGh);
      }
      if (check.kind === "time") {
        const at = timestampPredicate(check.predicate, "at");
        return deps.now() >= at
          ? { outcome: "satisfied", observation: "time reached" }
          : { outcome: "pending", observation: "time not reached" };
      }
      if (input.manualOutcome !== undefined) {
        return {
          outcome: input.manualOutcome,
          observation: `manual input: ${input.manualOutcome}`,
        };
      }
      const reviewAt = timestampPredicate(check.predicate, "reviewAt");
      return deps.now() >= reviewAt
        ? { outcome: "pending", observation: "manual review overdue" }
        : { outcome: "pending", observation: "manual review pending" };
    },
  };
}

export function nextCheckBackoffMs(
  errorCount: number,
  baseMs: number,
  maxMs: number,
): number {
  if (!Number.isInteger(errorCount) || errorCount < 1) {
    throw new Error("error count must be a positive integer");
  }
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    throw new Error("base backoff must be positive");
  }
  if (!Number.isFinite(maxMs) || maxMs < baseMs) {
    throw new Error("maximum backoff must be at least the base backoff");
  }
  return Math.min(maxMs, baseMs * 2 ** Math.min(52, errorCount - 1));
}

async function observePullRequests(
  check: LifecycleCheck,
  artifacts: readonly Artifact[],
  execGh: GitHubExecutor,
): Promise<CheckObservation> {
  if (check.targetArtifactIds.length === 0) {
    return {
      outcome: "error",
      observation: "pull request check has no targets",
    };
  }
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const targets: Artifact[] = [];
  for (const id of check.targetArtifactIds) {
    const artifact = byId.get(id);
    if (artifact === undefined || artifact.kind !== "pull_request") {
      return {
        outcome: "error",
        observation: `pull request artifact ${id} is unavailable`,
      };
    }
    targets.push(artifact);
  }

  const observations: CheckObservation[] = [];
  for (const target of targets) {
    const result = await execGh([
      "pr",
      "view",
      target.uri,
      "--json",
      "state,reviewDecision,mergeStateStatus,mergedAt",
    ]);
    if (result.code !== 0) {
      return {
        outcome: "error",
        observation: `gh exited with code ${result.code}`,
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      return { outcome: "error", observation: "gh returned malformed JSON" };
    }
    const decoded = decodePullRequestState(value);
    if (decoded === null) {
      return { outcome: "error", observation: "gh returned invalid PR state" };
    }
    observations.push(classifyPullRequest(decoded));
  }

  const merged = observations.filter(
    (observation) => observation.outcome === "satisfied",
  ).length;
  const actionRequired = observations.filter(
    (observation) => observation.outcome === "action_required",
  );
  const mode = check.predicate.mode === "any" ? "any" : "all";
  if (mode === "any" && merged > 0) {
    return {
      outcome: "satisfied",
      observation: `${merged}/${targets.length} merged`,
    };
  }
  if (mode === "all" && merged === targets.length) {
    return {
      outcome: "satisfied",
      observation: `${merged}/${targets.length} merged`,
    };
  }
  if (
    (mode === "all" && actionRequired.length > 0) ||
    (mode === "any" && actionRequired.length === targets.length)
  ) {
    return actionRequired[0];
  }
  return {
    outcome: "pending",
    observation: `${merged}/${targets.length} merged`,
  };
}

function decodePullRequestState(value: unknown): PullRequestState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.state !== "string" ||
    typeof record.reviewDecision !== "string" ||
    typeof record.mergeStateStatus !== "string" ||
    (record.mergedAt !== null && typeof record.mergedAt !== "string")
  ) {
    return null;
  }
  return {
    state: record.state,
    reviewDecision: record.reviewDecision,
    mergeStateStatus: record.mergeStateStatus,
    mergedAt: record.mergedAt,
  };
}

function classifyPullRequest(value: PullRequestState): CheckObservation {
  if (value.mergedAt !== null) {
    return { outcome: "satisfied", observation: "merged" };
  }
  if (value.reviewDecision === "CHANGES_REQUESTED") {
    return { outcome: "action_required", observation: "changes_requested" };
  }
  if (value.mergeStateStatus === "DIRTY") {
    return { outcome: "action_required", observation: "merge_conflict" };
  }
  if (value.state === "CLOSED") {
    return { outcome: "action_required", observation: "closed_unmerged" };
  }
  return { outcome: "pending", observation: "open" };
}

function timestampPredicate(
  predicate: Record<string, unknown>,
  key: string,
): number {
  const value = predicate[key];
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${key} predicate must be an RFC3339 timestamp`);
  }
  return Date.parse(value);
}
