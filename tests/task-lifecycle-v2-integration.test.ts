import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { localPidState } from "../lib/task-reconciler/files.js";
import test from "node:test";
import { loadWorktreePoolRuntime } from "../extensions/worktree-pool/runtime.js";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";
import { createCheckAdapterRegistry } from "../lib/task-lifecycle/checks.js";
import { TaskLifecycleService } from "../lib/task-lifecycle/service.js";
import {
  planLifecycleV2Migration,
  readLifecycleV2MigrationSnapshot,
} from "../lib/task-lifecycle/v2-migration.js";
import { check, withCheck } from "../lib/task-lifecycle/v2-test-fixtures.js";
import {
  blockLifecycleV2,
  fingerprintConditionV2,
} from "../lib/task-lifecycle/v2-model.js";
import type {
  LifecycleIssue,
  LifecycleMetadataV2,
  LockOwner,
} from "../lib/task-lifecycle/types.js";

function v2(issue: LifecycleIssue): LifecycleMetadataV2 {
  assert.equal(issue.lifecycle?.version, 2);
  return issue.lifecycle as LifecycleMetadataV2;
}

test(
  "real Beads and Git preserve v2 ownership, completion gates and cutover safety",
  { timeout: 120_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "pi-lifecycle-v2-native-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const { BEADS_DIR: _dir, BEADS_DB: _db, ...baseEnvironment } = process.env;
    const storePath = join(root, ".beads");
    const run = async (command: string, args: readonly string[]) => {
      try {
        const result = await promisify(execFile)(command, [...args], {
          cwd: root,
          env: {
            ...baseEnvironment,
            BD_BACKUP_ENABLED: "false",
            GIT_TERMINAL_PROMPT: "0",
          },
          timeout: 20_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { code: 0, ...result };
      } catch (error) {
        const e = error as { code?: unknown; stdout?: string; stderr?: string };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(error),
        };
      }
    };
    const must = async (command: string, args: string[]) => {
      const result = await run(command, args);
      assert.equal(
        result.code,
        0,
        `${command} ${args.join(" ")}: ${result.stderr}`,
      );
      return result.stdout;
    };
    await must("bd", [
      "init",
      "--init-if-missing",
      "--non-interactive",
      "--prefix",
      "zz",
    ]);
    const repo = join(root, "repositories", "repo");
    await mkdir(repo, { recursive: true });
    await must("git", ["-C", repo, "init", "-b", "main"]);
    await must("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const poolConfig = join(root, "pool.json");
    await writeFile(
      poolConfig,
      JSON.stringify({
        version: 2,
        root: join(root, "pool"),
        repositoryRoot: join(root, "repositories"),
        defaultCapacity: 3,
        exclude: [],
        repositories: [],
      }),
    );
    const runtime = await loadWorktreePoolRuntime(["repo"], "identity", {
      configPath: poolConfig,
      home: root,
      realpath,
      runGit: (cwd, args) =>
        run("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args]),
      uuid: randomUUID,
      operationLock: {
        hostname: hostname(),
        now: Date.now,
        sleep: delay,
        isPidAlive: localPidState,
        timeoutMs: 5000,
      },
    });
    let now = Date.now();
    const actor = (sessionId: string): LockOwner => ({
      sessionId,
      host: hostname(),
      pid: process.pid,
      started: now,
    });
    const a = actor("owner-a"),
      b = actor("owner-b"),
      migrator = actor("migration-operator"),
      daemon = actor("daemon");
    const oldStore = createLifecycleStore(run, { store: storePath });
    const oldService = new TaskLifecycleService({
      store: oldStore,
      now: () => now,
      uuid: randomUUID,
      executionTimeoutMs: 60_000,
    });
    const legacy = await oldService.create(
      {
        title: "Legacy owner",
        why: "Preserve validated ownership",
        workstream: "test",
        needsJp: false,
      },
      migrator,
    );
    await oldService.claim(legacy.id, migrator, "claim-legacy");
    const store = createLifecycleStore(run, {
      store: storePath,
      lifecycleWriteVersion: 2,
    });
    const snapshot = await readLifecycleV2MigrationSnapshot(store);
    const plan = planLifecycleV2Migration(snapshot, {});
    assert.deepEqual(plan.diagnostics, []);
    await store.applyLifecycleV2Migration({ ...plan, storePath }, migrator);
    assert.equal(
      v2(await store.show(legacy.id)).owner?.sessionId,
      migrator.sessionId,
    );
    await assert.rejects(
      oldService.claim(legacy.id, migrator, "obsolete-writer"),
      /write version 1/,
    );

    let merged = false;
    const adapters = createCheckAdapterRegistry({
      now: () => now,
      prPollIntervalMs: 1000,
      execGh: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          state: merged ? "MERGED" : "OPEN",
          reviewDecision: merged ? "APPROVED" : "CHANGES_REQUESTED",
          mergeStateStatus: "CLEAN",
          mergedAt: merged ? new Date(now).toISOString() : null,
        }),
      }),
    });
    const service = () =>
      new TaskLifecycleService({
        store,
        lifecycleWriteVersion: 2,
        pool: runtime.pool,
        checkAdapters: adapters,
        now: () => now,
        uuid: randomUUID,
        executionTimeoutMs: 60_000,
        prPollIntervalMs: 1000,
      });
    const sut = service();
    const create = (title: string) =>
      sut.create(
        {
          title,
          why: "Native integration",
          workstream: "test",
          needsJp: false,
        },
        a,
      );
    const task = await create("Merge requirement");
    await sut.claim(task.id, a, "claim-a");
    await sut.attachArtifact(
      task.id,
      {
        id: "pr",
        kind: "pull_request",
        uri: "https://github.com/example/repo/pull/1",
        title: "Change",
        role: "deliverable",
      },
      a,
      "attach-pr",
    );
    await sut.updateCondition(
      task.id,
      {
        kind: "check",
        purpose: "completion",
        reason: "Delivery requires merge",
        check: check({
          kind: "github_pull_request",
          targetArtifactIds: ["pr"],
          onSatisfied: "close",
          createdAt: new Date(now).toISOString(),
          nextCheckAt: new Date(now).toISOString(),
        }),
      },
      a,
      "require-merge",
    );
    const acquired = await sut.acquireWorktree(
      {
        taskId: task.id,
        repository: "repo",
        branch: "jpriverar/native-v2",
        startPoint: "main",
      },
      a,
      "acquire",
    );
    const claimId = acquired.lifecycle!.resources[0].claimId;
    await sut.block(
      task.id,
      { reason: "Await merge or corrective feedback" },
      a,
      "pause-a",
    );
    await assert.rejects(
      sut.release(task.id, "Handoff", a, "unsafe-release"),
      /resource|worktree/,
    );
    const ready = v2(await sut.reconcileTask(task.id, daemon));
    assert.equal(ready.phase, "actionable");
    assert.equal(ready.owner?.sessionId, a.sessionId);
    assert.equal(ready.activeCheck?.state, "action_required");
    assert.equal(ready.condition?.purpose, "completion");
    assert.equal(ready.resources[0].cleanupState, "active");
    await sut.resume(
      task.id,
      "Make approved review corrections",
      a,
      "resume-a",
    );
    await sut.releaseWorktree(task.id, claimId, a, "cleanup");
    const finish = {
      kind: "completed" as const,
      reason: "Delivery finished",
      evidenceArtifactIds: ["pr"],
    };
    await assert.rejects(
      sut.close(task.id, finish, a, "premature-close"),
      /condition|requirement/,
    );
    const released = v2(
      await sut.release(task.id, "Explicit handoff", a, "release-a"),
    );
    assert.equal(released.owner, null);
    assert.equal(released.condition?.purpose, "completion");
    await sut.claim(task.id, b, "claim-b");
    await assert.rejects(
      sut.close(task.id, finish, b, "still-premature"),
      /condition|requirement/,
    );
    await sut.block(task.id, { reason: "Await final merge" }, b, "pause-b");
    merged = true;
    now += 60_000;
    const done = v2(await sut.reconcileTask(task.id, daemon));
    assert.equal(done.phase, "done");
    assert.equal(done.owner?.sessionId, b.sessionId);
    assert.equal(
      (await service().ownedTasksForSession(b.sessionId))[0].id,
      task.id,
    );
    assert.deepEqual(await service().ownedTasksForSession("fork"), []);
    const another = await create("Deferred association");
    await assert.rejects(sut.claim(another.id, b, "claim-while-done"), /owns/);
    await sut.release(
      task.id,
      "Release completed association",
      b,
      "release-done",
    );
    await sut.claim(another.id, b, "claim-next");
    await sut.defer(another.id, "Explicitly parked", b, "defer");
    assert.equal(
      (await service().ownedTasksForSession(b.sessionId))[0].lifecycle?.phase,
      "deferred",
    );
    await sut.release(another.id, "Handoff parked work", b, "release-deferred");

    const stale = await create("Stale pause observation");
    await sut.claim(stale.id, a, "claim-stale");
    await sut.attachArtifact(
      stale.id,
      {
        id: "pr",
        kind: "pull_request",
        uri: "https://github.com/example/repo/pull/2",
        title: "Another change",
        role: "deliverable",
      },
      a,
      "attach-stale",
    );
    await sut.block(
      stale.id,
      {
        reason: "Pause one",
        condition: {
          kind: "check",
          purpose: "completion",
          check: check({
            kind: "github_pull_request",
            targetArtifactIds: ["pr"],
            onSatisfied: "close",
            nextCheckAt: new Date(now).toISOString(),
          }),
        },
      },
      a,
      "pause-one",
    );
    const old = await sut.prepareReconciliation(
      { taskId: stale.id, requestId: "old-observation" },
      daemon,
    );
    assert.equal(old.kind, "observe");
    if (old.kind !== "observe")
      throw new Error("expected an external observation");
    await sut.resume(stale.id, "Independent approved work", a, "resume-stale");
    const newPause = v2(
      await sut.block(stale.id, { reason: "Pause two" }, a, "pause-two"),
    ).pause;
    const late = await sut.applyReconciliation(
      old.prepared,
      { outcome: "satisfied", observation: "1/1 merged" },
      daemon,
    );
    assert.equal(late.issue.lifecycle?.phase, "waiting");
    assert.equal(v2(late.issue).pause?.id, newPause?.id);
    assert.equal(v2(late.issue).owner?.sessionId, a.sessionId);

    const first = await create("Concurrent claim one"),
      second = await create("Concurrent claim two");
    const c = actor("concurrent-owner");
    const claims = await Promise.allSettled([
      sut.claim(first.id, c, "concurrent-one"),
      sut.claim(second.id, c, "concurrent-two"),
    ]);
    assert.equal(
      claims.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal((await sut.ownedTasksForSession(c.sessionId)).length, 1);

    const nativeCreate = async (title: string, args: string[] = []) => {
      const raw = JSON.parse(
        await must("bd", [
          "create",
          title,
          ...args,
          "--json",
          "--db",
          storePath,
        ]),
      );
      const created = Array.isArray(raw) ? raw[0] : raw;
      assert.equal(typeof created.id, "string");
      return created.id as string;
    };
    const unmanaged = await nativeCreate("Untracked ready work", [
      "--metadata",
      JSON.stringify({ custom: "retained" }),
    ]);
    const initialized = await sut.claim(
      unmanaged,
      actor("unmanaged-owner"),
      "initialize-unmanaged",
    );
    assert.equal(v2(initialized).phase, "active");
    assert.equal(initialized.metadata.custom, "retained");
    const dependent = await nativeCreate("Untracked dependency-blocked work");
    await must("bd", ["dep", "add", dependent, unmanaged, "--db", storePath]);
    const blocked = await sut.claim(
      dependent,
      actor("dependent-owner"),
      "initialize-dependent",
    );
    assert.equal(v2(blocked).phase, "waiting");
    assert.equal(v2(blocked).condition?.purpose, "completion");
    assert.equal(blocked.dependencies[0].id, unmanaged);

    const gateOwner = actor("hidden-owner");
    const timestamp = new Date(now).toISOString();
    const gateState = withCheck({
      owner: {
        sessionId: gateOwner.sessionId,
        claimedAt: timestamp,
        lastActivityAt: timestamp,
      },
    });
    const gatePause = blockLifecycleV2(gateState, {
      operationId: "gate-pause",
      sessionId: gateOwner.sessionId,
      now: timestamp,
      reason: "Native hidden ownership fixture",
      conditionFingerprint: fingerprintConditionV2(gateState, [])!,
    });
    const gate = await nativeCreate("Owned hidden gate", [
      "--type",
      "gate",
      "--metadata",
      JSON.stringify({ piLifecycle: gatePause }),
    ]);
    await must("bd", ["update", gate, "-s", "blocked", "--db", storePath]);
    const normal = JSON.parse(
      await must("bd", [
        "list",
        "--all",
        "-n",
        "0",
        "--json",
        "--db",
        storePath,
      ]),
    );
    assert.equal(
      normal.some((row: { id: string }) => row.id === gate),
      false,
    );
    assert.deepEqual(
      (await sut.ownedTasksForSession(gateOwner.sessionId)).map(
        (row) => row.id,
      ),
      [gate],
    );
    assert.ok(
      (await readLifecycleV2MigrationSnapshot(store)).some(
        (row) => row.id === gate,
      ),
    );
    const unclaimed = claims[0].status === "rejected" ? first : second;
    await assert.rejects(
      sut.claim(unclaimed.id, gateOwner, "second-hidden-claim"),
      /already owns/,
    );
    assert.equal((await runtime.pool.list("repo")).repositories[0].used, 0);
  },
);
