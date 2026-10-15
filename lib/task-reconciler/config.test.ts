import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadDaemonConfig, daemonEnvironment } from "./config.js";
import { configFixture } from "./test-fixtures.js";

test("loads explicit paths and bounded defaults without creating runtime state", async (t) => {
  const f = await configFixture(t);
  const config = await loadDaemonConfig(f.configPath);
  assert.equal(config.store, await realpath(join(f.root, ".beads")));
  assert.equal(Object.hasOwn(config.executables, "dolt"), false);
  assert.equal(config.limits.scanIntervalMs, 60_000);
  assert.equal(config.limits.externalConcurrency, 2);
  assert.equal(config.limits.maxQueuedTasks, 100);
  assert.equal(config.limits.commandTimeoutMs, 30_000);
  assert.equal(config.limits.observationTimeoutMs, 120_000);
  assert.equal(config.limits.requestTimeoutMs, 60_000);
  assert.equal(config.limits.maxOutputBytes, 16 * 1024 * 1024);
  await assert.rejects(access(config.runtimeRoot));
});

test("rejects relative, missing, and unknown configuration inputs", async (t) => {
  const f = await configFixture(t);
  f.raw.store = "relative-store";
  await f.save();
  await assert.rejects(loadDaemonConfig(f.configPath), /store.*absolute/);
  f.raw.store = join(f.root, "missing-store");
  await f.save();
  await assert.rejects(loadDaemonConfig(f.configPath), /store/);
  f.raw.store = join(f.root, ".beads");
  f.raw.secret = "private-value";
  await f.save();
  await assert.rejects(
    loadDaemonConfig(f.configPath),
    (e: any) =>
      /unknown field/.test(e.message) && !e.message.includes("private-value"),
  );
});

test("validates command paths before any runtime is created", async (t) => {
  const f = await configFixture(t);
  f.raw.executables = {
    node: process.execPath,
    bd: process.execPath,
    git: process.execPath,
    gh: join(f.root, "missing-gh"),
  };
  await f.save();
  await assert.rejects(loadDaemonConfig(f.configPath), /gh/);
  await assert.rejects(access(join(f.root, "runtime")));
});

test("configured Dolt is available to Beads child commands", async (t) => {
  const f = await configFixture(t);
  const bin = join(f.root, "dolt-bin");
  await mkdir(bin);
  const dolt = join(bin, "dolt");
  await writeFile(dolt, "#!/bin/sh\nprintf 'dolt-runtime-fixture\\n'\n", {
    mode: 0o755,
  });
  const alias = join(f.root, "dolt-link");
  await symlink(dolt, alias);
  f.raw.executables = {
    ...(f.raw.executables as Record<string, string>),
    dolt: alias,
  };
  await f.save();

  const config = await loadDaemonConfig(f.configPath);
  assert.equal(config.executables.dolt, await realpath(dolt));
  const { stdout } = await promisify(execFile)(
    config.executables.bd,
    [
      "-e",
      "process.stdout.write(require('node:child_process').execFileSync('dolt', ['--version']))",
    ],
    { env: daemonEnvironment(config), timeout: 3000 },
  );
  assert.equal(stdout, "dolt-runtime-fixture\n");
});

test("validates optional Dolt paths before creating runtime state", async (t) => {
  const f = await configFixture(t);
  const notExecutable = join(f.root, "not-executable");
  await writeFile(notExecutable, "not an executable", { mode: 0o644 });
  for (const dolt of [
    null,
    "dolt",
    join(f.root, "missing-dolt"),
    join(f.root, ".beads"),
    notExecutable,
  ]) {
    f.raw.executables = {
      ...(f.raw.executables as Record<string, unknown>),
      dolt,
    };
    await f.save();
    await assert.rejects(loadDaemonConfig(f.configPath), /executables\.dolt/);
  }
  await assert.rejects(access(join(f.root, "runtime")));
});

test("administration can load a retired Dolt executable path", async (t) => {
  const f = await configFixture(t);
  const retired = join(f.root, "retired-dolt");
  f.raw.executables = {
    ...(f.raw.executables as Record<string, string>),
    dolt: retired,
  };
  await f.save();
  const config = await loadDaemonConfig(f.configPath, {
    allowMissingExecutables: true,
  });
  assert.equal(config.executables.dolt, retired);
});

test("rejects invalid limits and incompatible timing/backoff values", async (t) => {
  const f = await configFixture(t);
  for (const value of [0, -1, null, 1.5, "many"]) {
    f.raw.limits = { externalConcurrency: value };
    await f.save();
    await assert.rejects(loadDaemonConfig(f.configPath), /externalConcurrency/);
  }
  f.raw.limits = { localFailureBaseMs: 10_000, localFailureMaxMs: 1000 };
  await f.save();
  await assert.rejects(loadDaemonConfig(f.configPath), /localFailure/);
  f.raw.limits = { heartbeatIntervalMs: 60_000, heartbeatStaleMs: 1000 };
  await f.save();
  await assert.rejects(loadDaemonConfig(f.configPath), /heartbeat/);
});

test("normalizes explicit accounts and rejects case-fold collisions", async (t) => {
  const f = await configFixture(t);
  f.raw.githubAccounts = { Example: "account-one" };
  await f.save();
  assert.deepEqual((await loadDaemonConfig(f.configPath)).githubAccounts, {
    example: "account-one",
  });
  f.raw.githubAccounts = { Example: "account-one", example: "account-two" };
  await f.save();
  await assert.rejects(loadDaemonConfig(f.configPath), /duplicate.*account/);
});

test("malformed config errors do not echo file contents", async (t) => {
  const f = await configFixture(t);
  await writeFile(f.configPath, "private-json-value");
  await assert.rejects(
    loadDaemonConfig(f.configPath),
    (e: any) =>
      /config/.test(e.message) && !e.message.includes("private-json-value"),
  );
});

test("child environment excludes parent credentials and disables interaction", async (t) => {
  const f = await configFixture(t);
  const config = await loadDaemonConfig(f.configPath);
  const names = ["GH_TOKEN", "GITHUB_TOKEN", "DD_API_KEY"];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = `fixture-parent-${name}`;
    const env = daemonEnvironment(config);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.DD_API_KEY, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GH_PROMPT_DISABLED, "1");
    assert.ok(env.PATH?.includes("/usr/bin"));
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
});
