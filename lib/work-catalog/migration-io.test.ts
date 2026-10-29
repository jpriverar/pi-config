import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCatalogRuntime,
  readMigrationJson,
  writeMigrationPlan,
  verifyMigrationStore,
} from "./migration-io.js";
import { writePrivateJson } from "../task-reconciler/files.js";
import { parseRuntimeManifest } from "../task-reconciler/runtime-build.js";

const manifest = {
  version: 1 as const,
  runtimeVersion: "fixture-v2",
  sourceRevision: "unknown",
  sourceDigest: "a".repeat(64),
  entry: "lib/task-reconciler/cli.js" as const,
  files: {
    "package.json": "b".repeat(64),
    "lib/task-reconciler/cli.js": "c".repeat(64),
  },
};
const health = {
  state: "available" as const,
  protocolVersion: 2 as const,
  supportedLifecycleVersions: [1, 2],
  lifecycleWriteVersion: 1,
  runtimeVersion: "fixture-v2",
  pid: process.pid,
  startedAt: "2026-01-01T00:00:00Z",
  heartbeatAt: "2026-01-01T00:00:00Z",
  queue: {
    lastScanAttemptAt: null,
    lastScanSuccessAt: null,
    queued: 0,
    localRunning: 0,
    externalRunning: 0,
    diagnostics: [],
  },
};
test("activation requires a catalog-capable artifact matching the live daemon", () => {
  assert.throws(() => assertCatalogRuntime(manifest, health), /catalog/i);
  const compatible = { ...manifest, workCatalogVersion: 1 as const };
  assert.doesNotThrow(() => assertCatalogRuntime(compatible, health));
  assert.throws(
    () =>
      assertCatalogRuntime(compatible, {
        ...health,
        runtimeVersion: "old-build",
      }),
    /runtime/i,
  );
  assert.throws(
    () => assertCatalogRuntime(compatible, { ...health, state: "stale" }),
    /available/i,
  );
  assert.throws(
    () => parseRuntimeManifest({ ...manifest, workCatalogVersion: 2 }),
    /catalog/i,
  );
});
test("private migration reports support bounded larger files and never overwrite or follow links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "migration-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "plan.json");
  const report = { data: "x".repeat(70000) };
  await writeMigrationPlan(path, report);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readMigrationJson(path), report);
  await assert.rejects(writeMigrationPlan(path, { replaced: true }));
  assert.deepEqual(await readMigrationJson(path), report);
  const link = join(root, "link.json");
  await symlink(path, link);
  await assert.rejects(readMigrationJson(link));
  await assert.rejects(writeMigrationPlan(link, report));
  await assert.rejects(
    writeMigrationPlan(join(root, "too-big.json"), {
      data: "x".repeat(1024 * 1024),
    }),
  );
  await assert.rejects(
    writePrivateJson(join(root, "daemon.json"), report),
    /limit/i,
  );
  await chmod(path, 0o644);
  await assert.rejects(readMigrationJson(path));
  assert.ok((await readFile(path, "utf8")).includes("data"));
});
test("migration store paths must be owned directories without unsafe parents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "migration-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, ".beads");
  await mkdir(store, { mode: 0o755 });
  assert.equal(await verifyMigrationStore(store), await realpath(store));
  await chmod(root, 0o777);
  await assert.rejects(verifyMigrationStore(store), /parent/i);
  await chmod(root, 0o700);
  await writeFile(join(root, "file"), "x");
  await assert.rejects(verifyMigrationStore(join(root, "file")), /directory/i);
});
