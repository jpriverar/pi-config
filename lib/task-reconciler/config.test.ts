import assert from "node:assert/strict";
import { access, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadDaemonConfig, daemonEnvironment } from "./config.js";
import { configFixture } from "./test-fixtures.js";

test("loads explicit paths and bounded defaults without creating runtime state", async (t) => {
  const f = await configFixture(t);
  const config = await loadDaemonConfig(f.configPath);
  assert.equal(config.store, await realpath(join(f.root, ".beads")));
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
