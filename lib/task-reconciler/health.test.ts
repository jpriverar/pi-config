import assert from "node:assert/strict";
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { hostFixture } from "./host-fixtures.js";
import { readDaemonHealth } from "./health.js";

test("health reads are unavailable without creating runtime files", async (t) => {
  const f = await hostFixture(t);
  assert.equal((await readDaemonHealth(f.config)).state, "unavailable");
  await assert.rejects(access(f.config.runtimeRoot));
});

test("health distinguishes live, stale, incompatible and unsafe snapshots", async (t) => {
  const f = await hostFixture(t);
  const host = await f.start();
  const paths = await f.paths();
  const health = await readDaemonHealth(f.config);
  assert.equal(health.state, "available");
  if (health.state !== "available") throw new Error("missing host");
  assert.equal(health.pid, process.pid);
  assert.equal(health.queue.lastScanSuccessAt, null);
  const original = JSON.parse(await readFile(paths.health, "utf8"));
  const old = structuredClone(original);
  old.health.heartbeatAt = "2020-01-01T00:00:00Z";
  await writeFile(paths.health, JSON.stringify(old));
  assert.equal((await readDaemonHealth(f.config)).state, "stale");
  const incompatible = structuredClone(original);
  incompatible.health.protocolVersion = 99;
  await writeFile(paths.health, JSON.stringify(incompatible));
  assert.equal((await readDaemonHealth(f.config)).state, "incompatible");
  await writeFile(paths.health, JSON.stringify(original));
  await chmod(paths.health, 0o644);
  assert.equal((await readDaemonHealth(f.config)).state, "unavailable");
  await chmod(paths.health, 0o600);
  await host.stop();
});

test("malformed and oversized health is not exposed as healthy or echoed", async (t) => {
  const f = await hostFixture(t);
  const host = await f.start();
  const paths = await f.paths();
  for (const value of [
    '{"payload":"raw-json-must-not-leak"',
    "raw-json-must-not-leak".repeat(10_000),
  ]) {
    await writeFile(paths.health, value);
    const health = await readDaemonHealth(f.config);
    assert.equal(health.state, "unavailable");
    assert.ok(!JSON.stringify(health).includes("raw-json-must-not-leak"));
  }
  await host.stop();
});
