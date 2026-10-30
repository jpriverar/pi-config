import { legacyLifecycle } from "../lib/task-lifecycle/legacy-test-fixtures.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildReconciler } from "../scripts/build-task-reconciler.mjs";
import { loadDaemonConfig } from "../lib/task-reconciler/config.js";
import {
  requestReconciliation,
  ReconciliationUnknownResultError,
} from "../lib/task-reconciler/client.js";
import { localPidState } from "../lib/task-reconciler/files.js";
import { readDaemonHealth } from "../lib/task-reconciler/health.js";
import { runBoundedCommand } from "../lib/task-reconciler/commands.js";
import {
  waitingTask,
  fixturePolicy,
} from "../lib/task-reconciler/test-fixtures.js";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";
import { TaskLifecycleService } from "../lib/task-lifecycle/service.js";
import { fingerprintCheck } from "../lib/task-lifecycle/reconciliation.js";
import {
  loadWorktreePoolRuntime,
  poolGitArguments,
} from "../extensions/worktree-pool/runtime.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 45000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(20);
  }
}

test(
  "built daemon survives queue pressure, uncertain replies and restart without unsafe cleanup",
  { timeout: 120000 },
  async (t) => {
    const root = await fs.mkdtemp("/tmp/pi-recs-e2e-");
    const processes: Array<{ child: ChildProcess; done: Promise<unknown> }> =
      [];
    t.after(async () => {
      for (const p of processes)
        if (p.child.exitCode === null && p.child.signalCode === null)
          p.child.kill("SIGTERM");
      await Promise.allSettled(processes.map((p) => p.done));
      await fs.rm(root, { recursive: true, force: true });
    });
    const db = join(root, "db");
    const repos = join(root, "repos");
    const repo = join(repos, "repo");
    await fs.mkdir(db);
    await fs.mkdir(repo, { recursive: true });
    const env = {
      HOME: root,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (cwd: string, args: string[]) =>
      runBoundedCommand("/usr/bin/git", poolGitArguments(cwd, args), { env });
    assert.equal((await git(repo, ["init", "-b", "main"])).code, 0);
    assert.equal(
      (
        await git(repo, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        ])
      ).code,
      0,
    );
    const bd = join(root, "bd.mjs");
    const gh = join(root, "gh.mjs");
    await fs.copyFile(
      join(packageRoot, "tests/fixtures/task-reconciler/store.mjs"),
      bd,
    );
    await fs.copyFile(
      join(packageRoot, "tests/fixtures/task-reconciler/github.mjs"),
      gh,
    );
    for (const file of [bd, gh]) {
      const source = await fs.readFile(file, "utf8");
      await fs.writeFile(file, `#!${process.execPath}\n${source}`);
      await fs.chmod(file, 0o700);
    }
    const tasks = Array.from({ length: 105 }, (_, i) =>
      waitingTask(`due-${i}`),
    );
    const manual = waitingTask("manual-retry", "manual");
    const merged = waitingTask("pr-merged", "github_pull_request");
    const failed = waitingTask("pr-failed", "github_pull_request");
    failed.lifecycle!.artifacts[0].uri =
      "https://github.com/example/repo/pull/2";
    const retained = waitingTask("pr-retained", "github_pull_request");
    retained.lifecycle!.artifacts[0].uri =
      "https://github.com/example/repo/pull/4";
    const renewed = waitingTask("renewed", "github_pull_request");
    renewed.lifecycle!.artifacts[0].uri =
      "https://github.com/example/repo/pull/3";
    const dirty = waitingTask("dirty");
    dirty.lifecycle!.phase = "actionable";
    dirty.lifecycle!.activeCheck = null;
    legacyLifecycle(dirty.lifecycle!).waiting = null;
    dirty.status = "open";
    tasks.push(manual, merged, failed, retained, renewed, dirty);
    await fs.writeFile(join(db, "rows.json"), JSON.stringify(tasks));
    const policy = join(root, "policy.json");
    const poolConfig = join(root, "pool.json");
    await fs.writeFile(policy, JSON.stringify(fixturePolicy));
    await fs.writeFile(
      poolConfig,
      JSON.stringify({
        version: 2,
        root: join(root, "pool"),
        repositoryRoot: repos,
        defaultCapacity: 3,
        exclude: [],
        repositories: [],
      }),
    );
    const configPath = join(root, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        store: db,
        runtimeRoot: join(root, "run"),
        poolConfigPath: poolConfig,
        lifecycleConfigPath: policy,
        executables: { node: process.execPath, bd, gh, git: "/usr/bin/git" },
        githubAccounts: { example: "account-one" },
        limits: {
          scanIntervalMs: 1000,
          heartbeatIntervalMs: 100,
          heartbeatStaleMs: 2000,
          requestTimeoutMs: 10000,
        },
      }),
    );
    const config = await loadDaemonConfig(configPath);
    const execBd = (_command: string, args: readonly string[]) =>
      runBoundedCommand(bd, args, { env });
    const store = createLifecycleStore(execBd, { store: config.store });
    const runtime = await loadWorktreePoolRuntime(["repo"], "identity", {
      configPath: poolConfig,
      home: root,
      realpath: fs.realpath,
      runGit: git,
      uuid: randomUUID,
      operationLock: {
        hostname: hostname(),
        now: Date.now,
        sleep: delay,
        isPidAlive: localPidState,
        timeoutMs: 5000,
      },
    });
    let now = Date.now() - 24 * 60 * 60 * 1000;
    const service = new TaskLifecycleService({
      store,
      pool: runtime.pool,
      ...fixturePolicy,
      now: () => now,
      uuid: randomUUID,
    });
    const owner = {
      pid: process.pid,
      host: hostname(),
      started: Date.now(),
      sessionId: "fixture-dirty-owner",
    };
    await service.claim("dirty", owner);
    const acquired = await runtime.pool.acquire(
      {
        repository: "repo",
        branch: "jpriverar/fixture-dirty",
        startPoint: "main",
      },
      owner,
    );
    await service.recordWorktreeAcquire(
      {
        taskId: "dirty",
        repository: "repo",
        branch: "jpriverar/fixture-dirty",
      },
      acquired,
      owner,
      "fixture-acquire",
    );
    await fs.writeFile(
      join(acquired.path, "dirty.txt"),
      "fixture work must survive reconciliation",
    );
    now = Date.now() - 10 * 60 * 1000;
    const renewalOwner = { ...owner, sessionId: "fixture-renewed-owner" };
    await service.claim("renewed", renewalOwner);
    const renewalResource = await runtime.pool.acquire(
      {
        repository: "repo",
        branch: "jpriverar/fixture-renewed",
        startPoint: "main",
      },
      renewalOwner,
    );
    await service.recordWorktreeAcquire(
      {
        taskId: "renewed",
        repository: "repo",
        branch: "jpriverar/fixture-renewed",
      },
      renewalResource,
      renewalOwner,
      "fixture-renewal-acquire",
    );
    const built = await buildReconciler({ packageRoot });
    async function start() {
      const child = spawn(
        process.execPath,
        [
          join(built.directory, built.manifest.entry),
          "run",
          "--config",
          configPath,
        ],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr!.on("data", (b) => {
        stderr = (stderr + b.toString()).slice(-8000);
      });
      const done = once(child, "exit");
      processes.push({ child, done });
      await until(async () => {
        assert.equal(child.exitCode, null, stderr);
        assert.equal(child.signalCode, null, stderr);
        return (await readDaemonHealth(config)).state === "available";
      }, "daemon readiness");
      return { child, done };
    }
    const first = await start();
    await until(
      async () =>
        fs.access(join(root, "observing-3")).then(
          () => true,
          () => false,
        ),
      "blocked PR observation",
    );
    now = Date.now();
    const renewedExpiry = new Date(
      now + fixturePolicy.executionTimeoutMs,
    ).toISOString();
    assert.equal(
      (await service.refreshSessionActivity(renewalOwner)).length,
      1,
    );
    await fs.writeFile(join(root, "release-3"), "release");
    await until(async () => {
      const rows = JSON.parse(await fs.readFile(join(db, "rows.json"), "utf8"));
      return (
        rows.filter(
          (r: any) =>
            r.id.startsWith("due-") &&
            r.metadata.piLifecycle.phase === "actionable",
        ).length === 105
      );
    }, "all 105 due tasks");
    await until(
      async () =>
        (await store.show("pr-failed")).lifecycle!.activeCheck!.errorCount >
          0 &&
        (await store.show("pr-retained")).lifecycle!.activeCheck!.errorCount >
          0,
      "failed observations persisted",
    );
    const afterRenewal = await store.show("renewed");
    assert.equal(
      legacyLifecycle(afterRenewal.lifecycle!).execution!.expiresAt,
      renewedExpiry,
    );
    assert.equal(afterRenewal.lifecycle!.phase, "active");
    assert.equal(afterRenewal.lifecycle!.resources[0].cleanupState, "active");
    await fs.access(renewalResource.path);
    assert.equal(
      await fs.readFile(join(acquired.path, "dirty.txt"), "utf8"),
      "fixture work must survive reconciliation",
    );
    assert.ok(
      (await store.show("dirty")).lifecycle!.resources.every(
        (r) => r.cleanupState !== "released",
      ),
    );
    const replies = await Promise.all([
      requestReconciliation(config, {
        requestId: "shared-request",
        taskId: "due-104",
      }),
      requestReconciliation(config, {
        requestId: "shared-request",
        taskId: "due-104",
      }),
    ]);
    assert.deepEqual(replies[0], replies[1]);
    const binding = {
      requestId: "manual-uncertain",
      taskId: "manual-retry",
      manualOutcome: "satisfied" as const,
      expectedCheckFingerprint: fingerprintCheck(
        await store.show("manual-retry"),
      )!,
    };
    await fs.writeFile(join(db, "pause-response"), "pause");
    const abort = new AbortController();
    const uncertain = requestReconciliation(config, binding, abort.signal);
    const rejected = assert.rejects(uncertain, (error) => {
      assert.ok(error instanceof ReconciliationUnknownResultError);
      assert.deepEqual(error.request, binding);
      return true;
    });
    await until(
      async () =>
        fs.access(join(db, "committed-manual")).then(
          () => true,
          () => false,
        ),
      "manual mutation committed",
    );
    abort.abort();
    await rejected;
    await fs.unlink(join(db, "pause-response"));
    await until(async () => {
      const h = await readDaemonHealth(config);
      return (
        "queue" in h &&
        h.queue.localRunning === 0 &&
        h.queue.externalRunning === 0
      );
    }, "drain before crash");
    first.child.kill("SIGKILL");
    await first.done;
    const second = await start();
    const replay = await requestReconciliation(config, binding);
    assert.equal(replay.outcome, "already_applied");
    const manualOwner = { ...owner, sessionId: "fixture-manual-owner" };
    await service.claim("manual-retry", manualOwner);
    await service.waitForCheck(
      "manual-retry",
      { ...manual.lifecycle!.activeCheck!, id: "replacement" },
      manualOwner,
      "fixture-replace",
    );
    await requestReconciliation(config, binding);
    assert.equal(
      (await store.show("manual-retry")).lifecycle!.activeCheck!.id,
      "replacement",
    );
    await assert.rejects(
      requestReconciliation(config, {
        ...binding,
        requestId: "stale-new-request",
      }),
      { code: "check_changed" },
    );
    second.child.kill("SIGTERM");
    await second.done;
    assert.equal(second.child.exitCode, 0);
    const calls = (await fs.readFile(join(db, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((a) => a[0] === "update" && a[1] === "due-104").length,
      1,
    );
    assert.equal(
      (await store.show("manual-retry")).lifecycle!.transitionHistory.filter(
        (tr) => tr.type === "check_satisfied",
      ).length,
      1,
    );
    const pipePid = Number(await fs.readFile(join(root, "pipe-child"), "utf8"));
    await until(async () => {
      try {
        process.kill(pipePid, 0);
        return false;
      } catch {
        return true;
      }
    }, "test-owned retained pipe child exit");
  },
);

test(
  "built v2 daemon advertises its writer and retains ownership after a manual continuation",
  { timeout: 60_000 },
  async (t) => {
    const { withCheck, issue, OWNER, NOW } = await import(
      "../lib/task-lifecycle/v2-test-fixtures.js"
    );
    const { blockLifecycleV2, fingerprintConditionV2 } = await import(
      "../lib/task-lifecycle/v2-model.js"
    );
    const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-recs-v2-e2e-"));
    let child: ChildProcess | undefined, done: Promise<unknown> | undefined;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      if (done) await done;
      await fs.rm(root, { recursive: true, force: true });
    });
    const db = join(root, "db"),
      repos = join(root, "repos");
    await fs.mkdir(db);
    await fs.mkdir(repos);
    const bd = join(root, "bd.mjs"),
      gh = join(root, "gh.mjs");
    await fs.writeFile(
      bd,
      `#!${process.execPath}\n${await fs.readFile(join(packageRoot, "tests/fixtures/task-reconciler/store.mjs"), "utf8")}`,
    );
    await fs.writeFile(
      gh,
      `#!${process.execPath}\nthrow new Error('manual check must not call GitHub');\n`,
    );
    await fs.chmod(bd, 0o700);
    await fs.chmod(gh, 0o700);
    const current = withCheck();
    const paused = blockLifecycleV2(current, {
      operationId: "pause",
      sessionId: OWNER.sessionId,
      now: NOW,
      reason: "Await manual verification",
      conditionFingerprint: fingerprintConditionV2(current, [])!,
    });
    const task = issue(paused, "blocked");
    await fs.writeFile(join(db, "rows.json"), JSON.stringify([task]));
    const policy = join(root, "policy.json"),
      pool = join(root, "pool.json"),
      configPath = join(root, "config.json");
    await fs.writeFile(
      policy,
      JSON.stringify({ ...fixturePolicy, lifecycleWriteVersion: 2 }),
    );
    await fs.writeFile(
      pool,
      JSON.stringify({
        version: 2,
        root: join(root, "pool"),
        repositoryRoot: repos,
        defaultCapacity: 3,
        exclude: [],
        repositories: [],
      }),
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        store: db,
        runtimeRoot: join(root, "run"),
        poolConfigPath: pool,
        lifecycleConfigPath: policy,
        executables: { node: process.execPath, bd, gh, git: "/usr/bin/git" },
        githubAccounts: {},
        limits: {
          scanIntervalMs: 1000,
          heartbeatIntervalMs: 100,
          heartbeatStaleMs: 2000,
          requestTimeoutMs: 10000,
        },
      }),
    );
    const config = await loadDaemonConfig(configPath);
    const built = await buildReconciler({ packageRoot });
    const env = {
      HOME: root,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      GIT_TERMINAL_PROMPT: "0",
    };
    child = spawn(
      process.execPath,
      [
        join(built.directory, built.manifest.entry),
        "run",
        "--config",
        configPath,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-8000);
    });
    done = once(child, "exit");
    await until(async () => {
      assert.equal(child!.exitCode, null, stderr);
      return (await readDaemonHealth(config)).state === "available";
    }, "v2 daemon readiness");
    const health = await readDaemonHealth(config);
    assert.equal(health.state, "available");
    if (health.state !== "available")
      throw new Error("missing available health");
    assert.equal(health.lifecycleWriteVersion, 2);
    assert.deepEqual(health.supportedLifecycleVersions, [1, 2]);
    const store = createLifecycleStore(
      (_command, args) => runBoundedCommand(bd, args, { env }),
      { store: db, lifecycleWriteVersion: 2 },
    );
    const binding = {
      requestId: "manual-v2",
      taskId: task.id,
      manualOutcome: "action_required" as const,
      expectedCheckFingerprint: fingerprintCheck(await store.show(task.id))!,
    };
    await assert.rejects(requestReconciliation(config, binding, undefined, 1), {
      code: "incompatible",
    });
    assert.equal((await store.show(task.id)).lifecycle?.phase, "waiting");
    await requestReconciliation(config, binding, undefined, 2);
    const saved = (await store.show(task.id)).lifecycle;
    assert.equal(saved?.version, 2);
    if (saved?.version !== 2) throw new Error("writer changed the schema");
    assert.equal(saved.phase, "actionable");
    assert.deepEqual(saved.owner, OWNER);
    assert.equal(saved.pause, null);
    assert.equal(saved.condition?.purpose, "completion");
    assert.equal(saved.activeCheck?.state, "action_required");
    child.kill("SIGTERM");
    await done;
    assert.equal(child.exitCode, 0);
  },
);
