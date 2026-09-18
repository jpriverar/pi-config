import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadWorktreePoolRuntime } from "../extensions/worktree-pool/runtime.js";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";
import { createCheckAdapterRegistry } from "../lib/task-lifecycle/checks.js";
import { TaskLifecycleService } from "../lib/task-lifecycle/service.js";
import {
  classifyMigrationCandidates,
  formatMigrationReport,
} from "../scripts/report-lifecycle-migration.mjs";
import type {
  LifecycleCheck,
  LifecycleIssue,
  LockOwner,
} from "../lib/task-lifecycle/types.js";

const execFileAsync = promisify(execFile);
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== "BEADS_DIR" && key !== "BEADS_DB",
  ),
);

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: baseEnvironment,
      encoding: "utf8",
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

async function mustRun(command: string, args: string[], cwd: string) {
  const result = await run(command, args, cwd);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} exited ${result.code}`,
  );
  return result.stdout.trim();
}

async function initializeRepository(path: string, remote: string) {
  await mkdir(path, { recursive: true });
  await mkdir(remote, { recursive: true });
  await mustRun("git", ["init", "--bare", "-b", "main"], remote);
  await mustRun("git", ["init", "-b", "main"], path);
  await mustRun("git", ["config", "user.name", "Lifecycle Test"], path);
  await mustRun(
    "git",
    ["config", "user.email", "lifecycle-test@example.invalid"],
    path,
  );
  await writeFile(join(path, "README.md"), "fixture\n");
  await mustRun("git", ["add", "README.md"], path);
  await mustRun("git", ["commit", "-m", "fixture"], path);
  await mustRun("git", ["remote", "add", "origin", remote], path);
  await mustRun("git", ["push", "-u", "origin", "main"], path);
}

function pendingCheck(
  id: string,
  kind: LifecycleCheck["kind"],
  now: string,
  options: {
    targets?: string[];
    predicate?: Record<string, unknown>;
    onSatisfied?: "close" | "actionable";
  } = {},
): LifecycleCheck {
  return {
    id,
    kind,
    targetArtifactIds: options.targets ?? [],
    predicate: options.predicate ?? {},
    onSatisfied: options.onSatisfied ?? "actionable",
    wakeOn: ["action_required"],
    state: "pending",
    createdAt: now,
    lastCheckedAt: null,
    nextCheckAt: now,
    lastObservation: null,
    errorCount: 0,
  };
}

function transitionCount(issue: LifecycleIssue, type: string): number {
  return (
    issue.lifecycle?.transitionHistory.filter(
      (transition) => transition.type === type,
    ).length ?? 0
  );
}

test("real Beads, Git, and pool adapters preserve lifecycle contracts", async () => {
  const prefix = join(tmpdir(), "pi-task-lifecycle-integration-");
  const root = await mkdtemp(prefix);
  const storePath = join(root, ".beads");
  const repositoriesRoot = join(root, "repositories");
  const poolRoot = join(root, "pool");
  const repositoryA = join(repositoriesRoot, "repo-a");
  const repositoryB = join(repositoriesRoot, "repo-b");
  let now = Date.parse("2026-09-17T10:00:00.000Z");
  let uuidSequence = 0;
  const nextUuid = () =>
    `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`;
  const owner: LockOwner = {
    pid: process.pid,
    sessionId: "integration-session",
    host: "integration-host",
    started: now,
  };
  const pullStates = new Map<string, boolean>();

  try {
    await mkdir(repositoriesRoot, { recursive: true });
    await initializeRepository(
      repositoryA,
      join(root, "remotes", "repo-a.git"),
    );
    await initializeRepository(
      repositoryB,
      join(root, "remotes", "repo-b.git"),
    );
    await mustRun(
      "bd",
      ["init", "--init-if-missing", "--non-interactive", "--prefix", "zz"],
      root,
    );

    const poolConfigPath = join(root, "worktree-pool.json");
    await writeFile(
      poolConfigPath,
      JSON.stringify({
        version: 2,
        root: poolRoot,
        repositoryRoot: repositoriesRoot,
        defaultCapacity: 4,
        exclude: [],
        repositories: [{ name: "repo-a" }, { name: "repo-b" }],
      }),
    );
    const runtime = await loadWorktreePoolRuntime(
      ["repo-a", "repo-b"],
      "acquire",
      {
        configPath: poolConfigPath,
        home: root,
        runGit: (cwd, args) =>
          run("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], root),
        realpath,
        operationLock: {
          now: () => now,
          sleep: async () => {},
          isPidAlive: () => "live",
          hostname: owner.host,
          timeoutMs: 1_000,
        },
        uuid: randomUUID,
      },
    );
    const store = createLifecycleStore(
      (command, args) => run(command, [...args], root),
      { store: storePath },
    );
    const adapters = createCheckAdapterRegistry({
      now: () => now,
      prPollIntervalMs: 60_000,
      execGh: async (args) => {
        const merged = pullStates.get(args[2]);
        if (merged === undefined)
          return { code: 1, stdout: "", stderr: "unknown fixture PR" };
        return {
          code: 0,
          stdout: JSON.stringify({
            state: merged ? "MERGED" : "OPEN",
            reviewDecision: "APPROVED",
            mergeStateStatus: "CLEAN",
            mergedAt: merged ? new Date(now).toISOString() : null,
          }),
          stderr: "",
        };
      },
    });
    const service = new TaskLifecycleService({
      store,
      now: () => now,
      uuid: nextUuid,
      executionTimeoutMs: 10 * 60_000,
      activityWriteIntervalMs: 60_000,
      prPollIntervalMs: 60_000,
      maxBackoffMs: 10 * 60_000,
      pool: runtime.pool,
      checkAdapters: adapters,
    });
    const createTask = async (title: string): Promise<string> => {
      const raw = await mustRun(
        "bd",
        ["create", title, "--json", "--db", storePath],
        root,
      );
      const decoded = JSON.parse(raw) as { id: string } | Array<{ id: string }>;
      return Array.isArray(decoded) ? decoded[0].id : decoded.id;
    };

    const primary = await createTask("multi repository lifecycle");
    await service.claim(primary, owner, "claim-primary");
    let primaryIssue = await service.acquireWorktree(
      {
        taskId: primary,
        repository: "repo-a",
        branch: "integration/branch-a",
      },
      owner,
      "acquire-a",
    );
    primaryIssue = await service.acquireWorktree(
      {
        taskId: primary,
        repository: "repo-b",
        branch: "integration/branch-b",
      },
      owner,
      "acquire-b",
    );
    assert.equal(primaryIssue.lifecycle?.resources.length, 2);

    const pullA = "https://github.com/example/repo-a/pull/1";
    const pullB = "https://github.com/example/repo-b/pull/2";
    pullStates.set(pullA, true);
    pullStates.set(pullB, false);
    await service.attachArtifact(
      primary,
      {
        id: "pr-a",
        kind: "pull_request",
        uri: pullA,
        title: "PR A",
        role: "deliverable",
      },
      owner,
      "attach-pr-a",
    );
    await service.attachArtifact(
      primary,
      {
        id: "pr-b",
        kind: "pull_request",
        uri: pullB,
        title: "PR B",
        role: "deliverable",
      },
      owner,
      "attach-pr-b",
    );
    for (const resource of primaryIssue.lifecycle?.resources ?? []) {
      await service.releaseWorktree(
        primary,
        resource.claimId,
        owner,
        `release-${resource.claimId}`,
      );
    }
    const waitStarted = new Date(now).toISOString();
    await service.waitForCheck(
      primary,
      pendingCheck("merge-both", "github_pull_request", waitStarted, {
        targets: ["pr-a", "pr-b"],
        predicate: { mode: "all" },
        onSatisfied: "close",
      }),
      owner,
      "wait-for-both",
    );
    const oneMerged = await service.reconcileTask(primary, owner);
    assert.equal(oneMerged.lifecycle?.phase, "waiting");
    assert.equal(
      oneMerged.lifecycle?.activeCheck?.lastObservation,
      "1/2 merged",
    );

    pullStates.set(pullB, true);
    now += 60_001;
    const bothMerged = await service.reconcileTask(primary, owner);
    const reconciledAgain = await service.reconcileTask(primary, owner);
    assert.equal(bothMerged.lifecycle?.phase, "done");
    assert.equal(bothMerged.status, "closed");
    assert.equal(transitionCount(reconciledAgain, "close"), 1);

    const blocker = await createTask("dependency blocker");
    const dependent = await createTask("dependency dependent");
    await service.claim(dependent, owner, "claim-dependent");
    await service.waitForDependencies(
      dependent,
      [blocker],
      owner,
      "wait-dependency",
    );
    assert.equal((await store.show(dependent)).lifecycle?.phase, "waiting");
    await mustRun("bd", ["close", blocker, "--db", storePath], root);
    const unblocked = await service.reconcileTask(dependent, owner);
    assert.equal(unblocked.lifecycle?.phase, "actionable");

    const timed = await createTask("time wait");
    await service.claim(timed, owner, "claim-time");
    const timeTarget = new Date(now + 60_000).toISOString();
    await service.waitForCheck(
      timed,
      pendingCheck("time-check", "time", new Date(now).toISOString(), {
        predicate: { at: timeTarget },
      }),
      owner,
      "wait-time",
    );
    now += 60_001;
    assert.equal(
      (await service.reconcileTask(timed, owner)).lifecycle?.phase,
      "actionable",
    );

    const manual = await createTask("manual wait");
    await service.claim(manual, owner, "claim-manual");
    await service.waitForCheck(
      manual,
      pendingCheck("manual-check", "manual", new Date(now).toISOString(), {
        predicate: { reviewAt: new Date(now).toISOString() },
      }),
      owner,
      "wait-manual",
    );
    assert.equal(
      (await service.reconcileTask(manual, owner)).lifecycle?.phase,
      "waiting",
    );
    assert.equal(
      (
        await service.reconcileTask(manual, owner, {
          manualOutcome: "satisfied",
        })
      ).lifecycle?.phase,
      "actionable",
    );

    const interrupted = await createTask("interrupted execution");
    await service.claim(interrupted, owner, "claim-interrupted");
    now += 10 * 60_000 + 1;
    const interruption = await service.reconcileExecutionTimeout(
      interrupted,
      owner,
    );
    assert.equal(interruption.lifecycle?.phase, "actionable");
    assert.equal(transitionCount(interruption, "execution_interrupted"), 1);

    const dirty = await createTask("dirty retained worktree");
    await service.claim(dirty, owner, "claim-dirty");
    const dirtyIssue = await service.acquireWorktree(
      {
        taskId: dirty,
        repository: "repo-a",
        branch: "integration/dirty",
      },
      owner,
      "acquire-dirty",
    );
    const dirtyResource = dirtyIssue.lifecycle?.resources[0];
    assert.ok(dirtyResource?.path);
    await writeFile(join(dirtyResource.path, "dirty.txt"), "preserve\n");
    await assert.rejects(
      service.waitForCheck(
        dirty,
        pendingCheck("dirty-check", "manual", new Date(now).toISOString(), {
          predicate: { reviewAt: new Date(now).toISOString() },
        }),
        owner,
        "wait-dirty",
      ),
      /dirty|release/i,
    );
    const retained = await store.show(dirty);
    assert.equal(retained.lifecycle?.phase, "active");
    assert.equal(
      retained.lifecycle?.resources[0].cleanupState,
      "release_pending",
    );
    assert.equal(
      await readFile(join(dirtyResource.path, "dirty.txt"), "utf8"),
      "preserve\n",
    );

    const recovery = await createTask("partial acquisition recovery");
    const acquiredThenFailed = { value: false };
    const recoveryService = new TaskLifecycleService({
      store,
      now: () => now,
      uuid: nextUuid,
      executionTimeoutMs: 10 * 60_000,
      pool: {
        ...runtime.pool,
        list: runtime.pool.list.bind(runtime.pool),
        release: runtime.pool.release.bind(runtime.pool),
        async acquire(request, poolOwner, identity) {
          const result = await runtime.pool.acquire(
            request,
            poolOwner,
            identity,
          );
          if (!acquiredThenFailed.value) {
            acquiredThenFailed.value = true;
            throw new Error("simulated response loss after acquisition");
          }
          return result;
        },
      },
      checkAdapters: adapters,
    });
    await recoveryService.claim(recovery, owner, "claim-recovery");
    await assert.rejects(
      recoveryService.acquireWorktree(
        {
          taskId: recovery,
          repository: "repo-b",
          branch: "integration/recovery",
        },
        owner,
        "recover-acquire",
      ),
      /simulated response loss/,
    );
    const recovered = await recoveryService.acquireWorktree(
      {
        taskId: recovery,
        repository: "repo-b",
        branch: "integration/recovery",
      },
      owner,
      "recover-acquire",
    );
    assert.equal(recovered.lifecycle?.resources.length, 1);
    assert.equal(recovered.lifecycle?.resources[0].cleanupState, "active");
    assert.equal(
      (await runtime.pool.list("repo-b")).repositories[0].worktrees.filter(
        (worktree) =>
          worktree.claimId === recovered.lifecycle?.resources[0].claimId,
      ).length,
      1,
    );
  } finally {
    assert.ok(root.startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  }
});

test("migration report classifies candidates without mutation", () => {
  const issues = [
    { id: "jp-ready", status: "open", updated_at: "2026-09-01T00:00:00Z" },
    {
      id: "jp-dependency",
      status: "open",
      metadata: {
        piLifecycle: {
          version: 1,
          phase: "waiting",
          waiting: { kind: "dependency" },
          resources: [],
        },
      },
    },
    { id: "jp-manual", status: "blocked" },
    {
      id: "jp-stale",
      status: "in_progress",
      updated_at: "2026-07-01T00:00:00Z",
    },
    { id: "jp-deferred", status: "deferred" },
    { id: "jp-done", status: "closed" },
    {
      id: "jp-retained",
      status: "in_progress",
      metadata: {
        piLifecycle: {
          version: 1,
          phase: "active",
          resources: [{ claimId: "claim-1", cleanupState: "active" }],
        },
      },
    },
  ];

  const report = classifyMigrationCandidates(
    issues,
    new Set(["jp-ready"]),
    new Set(["claim-1"]),
    Date.parse("2026-09-18T00:00:00Z"),
  );
  const rendered = formatMigrationReport(report);

  assert.match(rendered, /legacy_actionable count=1 ids=jp-ready/);
  assert.match(rendered, /dependency_waiting count=1 ids=jp-dependency/);
  assert.match(rendered, /manually_blocked count=1 ids=jp-manual/);
  assert.match(rendered, /stale_in_progress count=1 ids=jp-stale/);
  assert.match(rendered, /deferred count=1 ids=jp-deferred/);
  assert.match(rendered, /done count=1 ids=jp-done/);
  assert.match(
    rendered,
    /retained_resource_candidates count=1 ids=jp-retained/,
  );
});
