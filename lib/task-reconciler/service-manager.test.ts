import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { configFixture } from "./test-fixtures.js";
import {
  manageService,
  type ServiceManagerDependencies,
} from "./service-manager.js";
import type { RuntimeBuild } from "./runtime-build.js";

async function fixture(t: TestContext) {
  const f = await configFixture(t);
  const home = join(f.root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const uid = process.getuid!();
  const canonicalStore = await fs.realpath(String(f.raw.store));
  await fs.mkdir(join(f.root, "repos"));
  await fs.writeFile(
    String(f.raw.poolConfigPath),
    JSON.stringify({
      version: 2,
      root: join(f.root, "pool"),
      repositoryRoot: join(f.root, "repos"),
      defaultCapacity: 3,
      exclude: [],
      repositories: [],
    }),
  );
  const calls: {
    file: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }[] = [];
  const output: string[] = [];
  let buildCalls = 0;
  let buildFailure = false;
  let malformedStatus = false;
  let loaded = false;
  let disabled = true;
  let currentVersion = "fixture-v1";
  let agentPath = "";
  let programArguments: string[] = [];
  let clock = Date.now();
  const buildRoot = join(f.root, "build");
  const entry = "lib/task-reconciler/cli.js" as const;
  await fs.mkdir(join(buildRoot, "lib/task-reconciler"), { recursive: true });
  const files = {
    "package.json": '{"type":"module"}',
    [entry]: "export const runCli = async () => 0;\n",
  };
  for (const [path, text] of Object.entries(files))
    await fs.writeFile(join(buildRoot, path), text);
  const hashes = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      createHash("sha256").update(text).digest("hex"),
    ]),
  );
  async function build(): Promise<RuntimeBuild> {
    buildCalls += 1;
    if (buildFailure) throw new Error("fixture compiler missing");
    const manifest = {
      version: 1 as const,
      runtimeVersion: currentVersion,
      sourceRevision: "a".repeat(40),
      sourceDigest: "b".repeat(64),
      entry,
      files: hashes,
    };
    await fs.writeFile(
      join(buildRoot, "manifest.json"),
      JSON.stringify(manifest),
      { mode: 0o600 },
    );
    return { directory: buildRoot, manifest };
  }
  const decode = (value: string) =>
    value
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  const deps: ServiceManagerDependencies = {
    fs,
    home,
    uid,
    platform: "darwin",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    build,
    output: (line) => output.push(line),
    pidState: () => (loaded ? "live" : "dead"),
    exec: async (file, args, env) => {
      calls.push({ file, args, env });
      if (file.endsWith("plutil")) return { code: 0, stdout: "OK", stderr: "" };
      if (file === process.execPath) {
        if (args[0] === "--version")
          return { code: 0, stdout: process.version, stderr: "" };
        if (args.includes("--runtime-info"))
          return {
            code: 0,
            stdout: JSON.stringify({
              protocolVersion: 1,
              runtimeVersion: currentVersion,
            }),
            stderr: "",
          };
        throw new Error("unexpected runtime execution");
      }
      assert.equal(file, "/bin/launchctl");
      if (args[0] === "print-disabled")
        return {
          code: 0,
          stdout: `disabled services = {\n "${label()}" => ${disabled}\n}\n`,
          stderr: "",
        };
      if (args[0] === "print")
        return loaded
          ? {
              code: 0,
              stdout: malformedStatus
                ? "unrecognized output"
                : `${args[1]} = {\n path = ${agentPath}\n program = ${programArguments[0]}\n arguments = {\n${programArguments.map((arg) => `  ${arg}`).join("\n")}\n }\n pid = 12345\n}\n`,
              stderr: "",
            }
          : {
              code: 113,
              stdout: "",
              stderr: `Could not find service "${label()}" in domain for user gui:${uid}`,
            };
      if (args[0] === "enable") disabled = false;
      else if (args[0] === "disable") disabled = true;
      else if (args[0] === "bootout") loaded = false;
      else if (args[0] === "bootstrap") {
        assert.equal(disabled, false);
        agentPath = args[2];
        const xml = await fs.readFile(agentPath, "utf8");
        const body =
          /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
            xml,
          )![1];
        programArguments = [...body.matchAll(/<string>(.*?)<\/string>/g)].map(
          (m) => decode(m[1]),
        );
        loaded = true;
      } else throw new Error(`unexpected launchctl action ${args[0]}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    health: async () =>
      !loaded
        ? { state: "unavailable", reason: "not_running" }
        : {
            state: "available",
            protocolVersion: 1,
            runtimeVersion: currentVersion,
            pid: 12345,
            startedAt: new Date(clock).toISOString(),
            heartbeatAt: new Date(clock).toISOString(),
            queue: {
              lastScanAttemptAt: null,
              lastScanSuccessAt: null,
              queued: 0,
              localRunning: 0,
              externalRunning: 0,
              diagnostics: [],
            },
          },
  };
  function label() {
    return `com.pi.task-reconciler.${createHash("sha256").update(canonicalStore).digest("hex").slice(0, 16)}`;
  }
  return {
    ...f,
    deps,
    calls,
    output,
    home,
    label,
    get buildCalls() {
      return buildCalls;
    },
    get loaded() {
      return loaded;
    },
    get disabled() {
      return disabled;
    },
    get buildFailure() {
      return buildFailure;
    },
    get malformedStatus() {
      return malformedStatus;
    },
    get version() {
      return currentVersion;
    },
    set buildFailure(value: boolean) {
      buildFailure = value;
    },
    set malformedStatus(value: boolean) {
      malformedStatus = value;
    },
    set version(value: string) {
      currentVersion = value;
    },
  };
}

test("install prepares private files without registering, running, or mutating tasks", async (t) => {
  const f = await fixture(t);
  const result = await manageService("install", f.configPath, f.deps);
  assert.equal(result.installed, true);
  assert.equal(result.enabled, false);
  assert.equal(
    f.calls.some((c) => c.file.includes("launchctl") || c.args.includes("run")),
    false,
  );
  assert.equal(f.buildCalls, 1);
  assert.ok(f.output[0].includes(f.label()));
  const xml = await fs.readFile(result.paths.template, "utf8");
  assert.ok(xml.includes("<key>ExitTimeOut</key>"));
  assert.ok(!xml.includes("AbandonProcessGroup"));
  assert.ok(!xml.includes("GH_TOKEN"));
  assert.ok(!xml.includes("SSH_AUTH_SOCK"));
  await assert.rejects(fs.access(result.paths.agent));
  assert.equal((await fs.stat(result.paths.root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(result.paths.manifest)).mode & 0o777, 0o600);
});

test("start and stop affect only the owned label and publish no inherited credentials", async (t) => {
  const f = await fixture(t);
  const installed = await manageService("install", f.configPath, f.deps);
  const started = await manageService("start", f.configPath, f.deps);
  assert.equal(started.enabled, true);
  assert.equal(f.loaded, true);
  const target = `gui/${f.deps.uid}/${f.label()}`;
  assert.ok(
    f.calls.some((c) => c.args[0] === "enable" && c.args[1] === target),
  );
  assert.ok(
    f.calls.some(
      (c) =>
        c.args[0] === "bootstrap" &&
        c.args[1] === `gui/${f.deps.uid}` &&
        c.args[2] === installed.paths.agent,
    ),
  );
  assert.ok(
    f.calls.every(
      (c) => c.env.GH_TOKEN === undefined && c.env.GITHUB_TOKEN === undefined,
    ),
  );
  const stopped = await manageService("stop", f.configPath, f.deps);
  assert.equal(stopped.enabled, false);
  assert.equal(f.disabled, true);
  assert.equal(f.loaded, false);
  assert.ok(
    f.calls.some((c) => c.args[0] === "bootout" && c.args[1] === target),
  );
});

test("a stopped update stays stopped and retains the previous runtime", async (t) => {
  const f = await fixture(t);
  const installed = await manageService("install", f.configPath, f.deps);
  f.version = "fixture-v2";
  const updated = await manageService("update", f.configPath, f.deps);
  assert.equal(updated.enabled, false);
  assert.ok(!f.calls.some((c) => ["enable", "bootstrap"].includes(c.args[0])));
  const manifest = JSON.parse(
    await fs.readFile(installed.paths.manifest, "utf8"),
  );
  assert.ok(manifest.previousDeployment);
  await fs.access(
    join(installed.paths.root, "runtimes", manifest.previousDeployment),
  );
});

test("failed enabled update drains first and does not resume old policy", async (t) => {
  const f = await fixture(t);
  await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  f.calls.length = 0;
  f.buildFailure = true;
  await assert.rejects(
    manageService("update", f.configPath, f.deps),
    /compiler missing/,
  );
  assert.equal(f.disabled, true);
  assert.equal(f.loaded, false);
  assert.ok(f.calls.some((c) => c.args[0] === "bootout"));
  assert.ok(!f.calls.some((c) => ["enable", "bootstrap"].includes(c.args[0])));
});

test("unrecognized status refuses mutation instead of guessing ownership", async (t) => {
  const f = await fixture(t);
  await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  f.calls.length = 0;
  f.malformedStatus = true;
  await assert.rejects(
    manageService("stop", f.configPath, f.deps),
    /unrecognized|unverifiable|status/,
  );
  assert.ok(f.calls.every((c) => c.args[0].startsWith("print")));
});

test("status is read-only and uninstall refuses an unrelated agent definition", async (t) => {
  const f = await fixture(t);
  const installed = await manageService("install", f.configPath, f.deps);
  const before = await fs.readFile(installed.paths.manifest, "utf8");
  const builds = f.buildCalls;
  await manageService("status", f.configPath, f.deps);
  assert.equal(await fs.readFile(installed.paths.manifest, "utf8"), before);
  assert.equal(f.buildCalls, builds);
  await fs.mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
  await fs.writeFile(installed.paths.agent, "unrelated definition", {
    mode: 0o600,
  });
  await assert.rejects(
    manageService("uninstall", f.configPath, f.deps),
    /ownership|unowned|unrelated/,
  );
  assert.equal(
    await fs.readFile(installed.paths.agent, "utf8"),
    "unrelated definition",
  );
  await fs.access(String(f.raw.store));
});

test("uninstall removes only owned service files and leaves source inputs intact", async (t) => {
  const f = await fixture(t);
  const installed = await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  const result = await manageService("uninstall", f.configPath, f.deps);
  assert.equal(result.installed, false);
  assert.equal(f.loaded, false);
  await assert.rejects(fs.access(installed.paths.root));
  await assert.rejects(fs.access(installed.paths.agent));
  await fs.access(f.configPath);
  await fs.access(String(f.raw.store));
  await fs.access(String(f.raw.poolConfigPath));
});

test("partial definition publication restores a usable stopped administration path", async (t) => {
  const f = await fixture(t);
  const installed = await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  const priorAdmin = await fs.readFile(installed.paths.admin, "utf8");
  f.version = "fixture-v2";
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, env) =>
    file.endsWith("plutil")
      ? { code: 1, stdout: "", stderr: "fixture plist validation failure" }
      : exec(file, args, env);
  await assert.rejects(manageService("update", f.configPath, f.deps));
  f.deps.exec = exec;
  const status = await manageService("status", f.configPath, f.deps);
  assert.equal(status.enabled, false);
  assert.equal(status.runtimeVersion, "fixture-v1");
  assert.equal(await fs.readFile(installed.paths.admin, "utf8"), priorAdmin);
  assert.equal(f.loaded, false);
});

test("unconfirmed process drain persists across retries and blocks replacement", async (t) => {
  const f = await fixture(t);
  f.raw.limits = { requestTimeoutMs: 5 };
  await f.save();
  const installed = await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  f.deps.pidState = () => "live";
  await assert.rejects(
    manageService("stop", f.configPath, f.deps),
    /drain remains unconfirmed/,
  );
  await assert.rejects(
    manageService("update", f.configPath, f.deps),
    /drain remains unconfirmed/,
  );
  assert.equal(f.buildCalls, 1);
  assert.deepEqual(
    JSON.parse(await fs.readFile(installed.paths.manifest, "utf8"))
      .drainingPids,
    [12345],
  );
  f.deps.pidState = () => "dead";
  await manageService("stop", f.configPath, f.deps);
  assert.deepEqual(
    JSON.parse(await fs.readFile(installed.paths.manifest, "utf8"))
      .drainingPids,
    [],
  );
});

test("start cannot accept the health of an unrelated foreground process", async (t) => {
  const f = await fixture(t);
  f.raw.limits = { requestTimeoutMs: 5 };
  await f.save();
  await manageService("install", f.configPath, f.deps);
  const probe = f.deps.health;
  f.deps.health = async (config) => {
    const h = await probe(config);
    return "pid" in h ? { ...h, pid: 99999 } : h;
  };
  await assert.rejects(
    manageService("start", f.configPath, f.deps),
    /health did not become available/,
  );
  assert.equal(f.disabled, true);
  assert.equal(f.loaded, false);
});

test("explicit rollback selects the retained runtime without compiling or starting a stopped service", async (t) => {
  const f = await fixture(t);
  await manageService("install", f.configPath, f.deps);
  f.version = "fixture-v2";
  await manageService("update", f.configPath, f.deps);
  const builds = f.buildCalls;
  f.calls.length = 0;
  const reverted = await manageService("update", f.configPath, f.deps, {
    rollback: true,
  });
  assert.equal(reverted.runtimeVersion, "fixture-v1");
  assert.equal(reverted.enabled, false);
  assert.equal(f.buildCalls, builds);
  assert.ok(!f.calls.some((c) => ["enable", "bootstrap"].includes(c.args[0])));
});

test("first install cannot replace an existing login agent", async (t) => {
  const f = await fixture(t);
  const agent = join(f.home, "Library/LaunchAgents", `${f.label()}.plist`);
  await fs.mkdir(join(f.home, "Library/LaunchAgents"), { recursive: true });
  await fs.writeFile(agent, "unrelated login agent", { mode: 0o600 });
  await assert.rejects(
    manageService("install", f.configPath, f.deps),
    /unowned|unrelated|existing/,
  );
  assert.equal(await fs.readFile(agent, "utf8"), "unrelated login agent");
  assert.equal(f.buildCalls, 0);
  assert.equal(f.calls.length, 0);
});

test("installed admin remains callable at every atomic update publication boundary", async (t) => {
  const f = await fixture(t);
  await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const exec = promisify(execFile);
  const source = join(f.root, "package-without-compiler");
  const { dirname } = await import("node:path");
  for (const name of [
    "bin/task-reconciler.mjs",
    "scripts/build-task-reconciler.mjs",
    "lib/task-reconciler/admin-entry.mjs",
  ]) {
    await fs.mkdir(dirname(join(source, name)), { recursive: true });
    await fs.copyFile(
      fileURLToPath(new URL(`../../${name}`, import.meta.url)),
      join(source, name),
    );
  }
  const launcher = join(source, "bin/task-reconciler.mjs");
  const failures: string[] = [];
  f.deps.fs = {
    ...fs,
    rename: async (from, to) => {
      await fs.rename(from, to);
      try {
        await exec(
          process.execPath,
          [launcher, "status", "--config", f.configPath],
          { env: { HOME: f.home, PATH: "/usr/bin:/bin" }, timeout: 5000 },
        );
      } catch (error) {
        failures.push((error as Error).message);
      }
    },
  };
  f.version = "fixture-v2";
  await manageService("update", f.configPath, f.deps);
  assert.deepEqual(failures, []);
});

test("already-loaded unhealthy service is not reported as successfully started", async (t) => {
  const f = await fixture(t);
  f.raw.limits = { requestTimeoutMs: 5 };
  await f.save();
  await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  f.calls.length = 0;
  f.deps.health = async () => ({
    state: "unavailable",
    reason: "fixture heartbeat missing",
  });
  await assert.rejects(
    manageService("start", f.configPath, f.deps),
    /health did not become available/,
  );
  assert.ok(f.calls.every((c) => c.args[0].startsWith("print")));
});

test("uninstall refuses a live singleton even when health is unavailable", async (t) => {
  const f = await fixture(t);
  const runtimeRoot = await fs.mkdtemp("/tmp/pi-admin-lock-");
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  f.raw.runtimeRoot = runtimeRoot;
  await f.save();
  const installed = await manageService("install", f.configPath, f.deps);
  const { loadDaemonConfig } = await import("./config.js");
  const { resolveRuntimePaths, localPidState } = await import("./files.js");
  const { withFileOperationLock } = await import("../file-operation-lock.js");
  const { hostname } = await import("node:os");
  const paths = await resolveRuntimePaths(
    await loadDaemonConfig(f.configPath),
    true,
  );
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = {
    pid: process.pid,
    host: hostname(),
    sessionId: "fixture-live-daemon",
    started: Date.now(),
  };
  const held = withFileOperationLock(
    paths.lockRoot,
    owner,
    async () => {
      entered();
      await blocked;
    },
    {
      now: Date.now,
      sleep: async () => {},
      isPidAlive: localPidState,
      hostname: hostname(),
      timeoutMs: 0,
    },
  );
  await ready;
  try {
    await assert.rejects(
      manageService("uninstall", f.configPath, f.deps),
      /owner|lock|singleton/,
    );
    await fs.access(installed.paths.manifest);
  } finally {
    release();
    await held;
  }
});

test("invalid pool configuration is rejected before building a service", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(String(f.raw.poolConfigPath), "{}");
  await assert.rejects(
    manageService("install", f.configPath, f.deps),
    /pool|config/,
  );
  assert.equal(f.buildCalls, 0);
});

test("first-install compiler failure can be retried without manual directory deletion", async (t) => {
  const f = await fixture(t);
  f.buildFailure = true;
  await assert.rejects(
    manageService("install", f.configPath, f.deps),
    /compiler missing/,
  );
  f.buildFailure = false;
  assert.equal(
    (await manageService("install", f.configPath, f.deps)).installed,
    true,
  );
});

test(
  "generated LaunchAgent is accepted by macOS plutil with XML-sensitive paths",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const f = await fixture(t);
    f.deps.home = join(f.root, "home<&");
    await fs.mkdir(f.deps.home, { mode: 0o700 });
    const installed = await manageService("install", f.configPath, f.deps);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("/usr/bin/plutil", ["-lint", installed.paths.template]);
    const { stdout } = await exec("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      installed.paths.template,
    ]);
    const plist = JSON.parse(stdout);
    assert.ok(plist.ProgramArguments[4].includes("home<&"));
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.KeepAlive, true);
    assert.equal(plist.ExitTimeOut, 30);
    assert.equal(plist.AbandonProcessGroup, undefined);
  },
);

test("installed stop and status do not depend on source configuration assets", async (t) => {
  const f = await fixture(t);
  await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  await fs.unlink(String(f.raw.poolConfigPath));
  await fs.unlink(String(f.raw.lifecycleConfigPath));
  assert.equal(
    (await manageService("status", f.configPath, f.deps)).installed,
    true,
  );
  assert.equal(
    (await manageService("stop", f.configPath, f.deps)).enabled,
    false,
  );
  assert.equal(
    (await manageService("uninstall", f.configPath, f.deps)).installed,
    false,
  );
});

test("missing configured tool cannot prevent stopping or uninstalling an installed service", async (t) => {
  const f = await fixture(t);
  const tool = join(f.root, "retired-bd");
  await fs.writeFile(tool, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  (f.raw.executables as Record<string, string>).bd = tool;
  await f.save();
  await manageService("install", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  await fs.unlink(tool);
  assert.equal(
    (await manageService("status", f.configPath, f.deps)).installed,
    true,
  );
  await manageService("stop", f.configPath, f.deps);
  assert.equal(
    (await manageService("uninstall", f.configPath, f.deps)).installed,
    false,
  );
});

test("retained verified releases do not prevent owned uninstall", async (t) => {
  const f = await fixture(t);
  const installed = await manageService("install", f.configPath, f.deps);
  const manifest = JSON.parse(
    await fs.readFile(installed.paths.manifest, "utf8"),
  );
  const runtimes = join(installed.paths.root, "runtimes");
  for (let i = 0; i < 30; i += 1)
    await fs.cp(
      join(runtimes, manifest.currentDeployment),
      join(runtimes, `${manifest.currentDeployment}-copy${i}`),
      { recursive: true },
    );
  assert.equal(
    (await manageService("uninstall", f.configPath, f.deps)).installed,
    false,
  );
});

test("first install recovers after deployment publication without adopting foreign contents", async (t) => {
  const f = await fixture(t);
  let failed = false;
  const interrupted = {
    ...f.deps,
    fs: {
      ...fs,
      rename: (async (from: string, to: string) => {
        if (to.endsWith("service.json") && !failed) {
          failed = true;
          throw new Error("fixture interrupted first publication");
        }
        return fs.rename(from, to);
      }) as typeof fs.rename,
    },
  };
  await assert.rejects(
    manageService("install", f.configPath, interrupted),
    /interrupted first publication/,
  );
  const installed = await manageService("install", f.configPath, f.deps);
  assert.equal(installed.installed, true);
  assert.equal(installed.loaded, false);
  assert.equal(
    f.calls.some((call) => call.file.includes("launchctl")),
    false,
  );
});

test("rollback uses retained assets despite missing source policies and stale source tools", async (t) => {
  const f = await fixture(t);
  await manageService("install", f.configPath, f.deps);
  f.version = "fixture-v2";
  await manageService("update", f.configPath, f.deps);
  await fs.unlink(String(f.raw.poolConfigPath));
  await fs.unlink(String(f.raw.lifecycleConfigPath));
  f.raw.executables = {
    node: process.execPath,
    bd: join(f.root, "retired-bd"),
    git: process.execPath,
    gh: process.execPath,
  };
  await f.save();
  const calls = f.buildCalls;
  const rolled = await manageService("update", f.configPath, f.deps, {
    rollback: true,
  });
  assert.equal(rolled.runtimeVersion, "fixture-v1");
  assert.equal(rolled.loaded, false);
  assert.equal(f.buildCalls, calls);
});

test("unchanged updates preserve the distinct rollback deployment", async (t) => {
  const f = await fixture(t);
  await manageService("install", f.configPath, f.deps);
  f.version = "fixture-v2";
  await manageService("update", f.configPath, f.deps);
  await manageService("update", f.configPath, f.deps);
  const calls = f.buildCalls;
  const rolled = await manageService("update", f.configPath, f.deps, {
    rollback: true,
  });
  assert.equal(rolled.runtimeVersion, "fixture-v1");
  assert.equal(f.buildCalls, calls);
});

for (const boundary of ["smoke", "manifest", "root"] as const)
  test(`crashed first installation at ${boundary} leaves no partially published service`, async (t) => {
    const f = await fixture(t);
    const services = join(
      await fs.realpath(f.home),
      ".pi/task-reconciler/services",
    );
    const root = join(services, f.label().split(".").at(-1)!);
    const interrupted = {
      ...f.deps,
      exec: async (...args: Parameters<typeof f.deps.exec>) => {
        if (boundary === "smoke" && args[1].includes("--runtime-info"))
          throw new Error("fixture crash");
        return f.deps.exec(...args);
      },
      fs: {
        ...fs,
        rename: (async (from: string, to: string) => {
          if (
            (boundary === "manifest" && to.endsWith("service.json")) ||
            (boundary === "root" && to === root)
          )
            throw new Error("fixture crash");
          return fs.rename(from, to);
        }) as typeof fs.rename,
        rm: (async (path: string, options: Parameters<typeof fs.rm>[1]) => {
          if (String(path).startsWith(join(services, ".install-"))) return;
          return fs.rm(path, options);
        }) as typeof fs.rm,
      },
    };
    await assert.rejects(
      manageService("install", f.configPath, interrupted),
      /fixture crash/,
    );
    await assert.rejects(fs.access(root), { code: "ENOENT" });
    const orphan = (await fs.readdir(services)).find((name) =>
      name.startsWith(".install-"),
    )!;
    await fs.writeFile(join(services, orphan, "unrelated-note"), "preserve");
    const result = await manageService("install", f.configPath, f.deps);
    assert.equal(result.installed, true);
    assert.equal(result.loaded, false);
    assert.equal(
      await fs.readFile(join(services, orphan, "unrelated-note"), "utf8"),
      "preserve",
    );
    assert.equal(
      f.calls.some((call) => call.file.includes("launchctl")),
      false,
    );
    await manageService("uninstall", f.configPath, f.deps);
    await fs.access(join(services, orphan, "unrelated-note"));
  });

test("rollback refuses an unusable retained executable and leaves the service stopped", async (t) => {
  const f = await fixture(t);
  const oldBd = join(f.root, "old-bd");
  await fs.writeFile(oldBd, "fixture", { mode: 0o700 });
  f.raw.executables = {
    node: process.execPath,
    bd: oldBd,
    git: process.execPath,
    gh: process.execPath,
  };
  await f.save();
  await manageService("install", f.configPath, f.deps);
  f.version = "fixture-v2";
  f.raw.executables = {
    node: process.execPath,
    bd: process.execPath,
    git: process.execPath,
    gh: process.execPath,
  };
  await f.save();
  await manageService("update", f.configPath, f.deps);
  await manageService("start", f.configPath, f.deps);
  await fs.unlink(oldBd);
  await assert.rejects(
    manageService("update", f.configPath, f.deps, { rollback: true }),
    /executable/,
  );
  assert.equal(f.loaded, false);
  assert.equal(f.disabled, true);
});
