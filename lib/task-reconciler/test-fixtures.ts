import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type {
  LifecycleStore,
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecycleStatus,
  LockOwner,
} from "../task-lifecycle/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const fixturePolicy = {
  version: 1,
  executionTimeoutMs: 21_600_000,
  activityWriteIntervalMs: 300_000,
  sessionReconcileLimit: 10,
  sessionPrCheckLimit: 5,
  prPollIntervalMs: 900_000,
  maxBackoffMs: 21_600_000,
  warningErrorCount: 3,
};

export async function configFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "reconciler-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".beads"));
  await writeFile(join(root, "pool.json"), "{}");
  await writeFile(join(root, "lifecycle.json"), JSON.stringify(fixturePolicy));
  const raw: Record<string, unknown> = {
    version: 1,
    store: join(root, ".beads"),
    poolConfigPath: join(root, "pool.json"),
    lifecycleConfigPath: join(root, "lifecycle.json"),
    runtimeRoot: join(root, "runtime"),
    executables: {
      node: process.execPath,
      bd: process.execPath,
      git: process.execPath,
      gh: process.execPath,
    },
    githubAccounts: { example: "account-one" },
  };
  const configPath = join(root, "config.json");
  const save = () => writeFile(configPath, JSON.stringify(raw));
  await save();
  return { root, raw, configPath, save };
}

export function waitingTask(
  id: string,
  kind: "time" | "manual" | "github_pull_request" = "time",
): LifecycleIssue {
  const at = "2026-01-01T00:00:00.000Z";
  const lifecycle: LifecycleMetadataV1 = {
    version: 1,
    phase: "waiting",
    waiting: { kind: "check" },
    stateEnteredAt: at,
    lastProgressAt: at,
    execution: null,
    artifacts:
      kind === "github_pull_request"
        ? [
            {
              id: "pr",
              kind: "pull_request",
              uri: "https://github.com/example/repo/pull/1",
              title: "PR",
              role: "deliverable",
              sourceArtifactIds: [],
              producedAt: at,
              supersededAt: null,
            },
          ]
        : [],
    activeCheck: {
      id: `check-${id}`,
      kind,
      targetArtifactIds: kind === "github_pull_request" ? ["pr"] : [],
      predicate:
        kind === "github_pull_request"
          ? { mode: "all" }
          : kind === "time"
            ? { at }
            : { reviewAt: at },
      onSatisfied: "actionable",
      wakeOn: [],
      state: "pending",
      createdAt: at,
      lastCheckedAt: null,
      nextCheckAt: at,
      lastObservation: null,
      errorCount: 0,
    },
    checkHistory: [],
    transitionHistory: [],
    resources: [],
    disposition: null,
  };
  return {
    id,
    title: "Queue fixture",
    status: "blocked",
    lifecycle,
    metadata: { piLifecycle: lifecycle },
    dependencies: [],
  };
}

export class MemoryLifecycleStore implements LifecycleStore {
  readonly issues = new Map<string, LifecycleIssue>();
  reads = 0;
  writes = 0;
  concurrent = 0;
  maxConcurrent = 0;
  failList = false;
  failTask: string | null = null;
  onWrite?: (id: string) => void;
  constructor(initial: LifecycleIssue[]) {
    initial.forEach((issue) =>
      this.issues.set(issue.id, structuredClone(issue)),
    );
  }
  private async access<T>(fn: () => T): Promise<T> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return fn();
    } finally {
      this.concurrent -= 1;
    }
  }
  async list(statuses: readonly LifecycleStatus[]) {
    return this.access(() => {
      this.reads += 1;
      if (this.failList) throw new Error("private fixture list error");
      return structuredClone(
        [...this.issues.values()].filter((issue) =>
          statuses.includes(issue.status),
        ),
      );
    });
  }
  async show(id: string) {
    return this.access(() => {
      if (id === this.failTask) throw new Error("private fixture task error");
      const issue = this.issues.get(id);
      if (!issue) throw new Error(`missing fixture task ${id}`);
      return structuredClone(issue);
    });
  }
  async showMany(ids: readonly string[]) {
    return this.access(() =>
      structuredClone(
        ids.flatMap((id) =>
          this.issues.has(id) ? [this.issues.get(id)!] : [],
        ),
      ),
    );
  }
  async mutate(
    id: string,
    _owner: LockOwner,
    operation: Parameters<LifecycleStore["mutate"]>[2],
  ) {
    return this.access(() => {
      const current = structuredClone(this.issues.get(id)!);
      const mutation = operation(current);
      if (mutation !== null) {
        const saved = {
          ...current,
          status: mutation.status,
          lifecycle: mutation.lifecycle,
          metadata: { ...current.metadata, piLifecycle: mutation.lifecycle },
        };
        this.issues.set(id, structuredClone(saved));
        this.writes += 1;
        this.onWrite?.(id);
      }
      return structuredClone(this.issues.get(id)!);
    });
  }
  async readyIds(): Promise<never> {
    throw new Error("unexpected ready query");
  }
  async create(): Promise<never> {
    throw new Error("unexpected task creation");
  }
  async updateLabels(): Promise<never> {
    throw new Error("unexpected label mutation");
  }
  async appendComment(): Promise<never> {
    throw new Error("unexpected comment");
  }
  async addBlocker(): Promise<never> {
    throw new Error("unexpected dependency mutation");
  }
}
