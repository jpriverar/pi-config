import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readPrivateJson, writePrivateJson } from "../task-reconciler/files.js";
import {
  readMigrationJson,
  writeMigrationPlan,
} from "../work-catalog/migration-io.js";
import {
  readLifecycleV2MigrationReport,
  writeLifecycleV2MigrationReport,
} from "./v2-migration-io.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-report-io-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "report.json") };
}

test("lifecycle reports round-trip evidence beyond 1 MiB without enlarging other file budgets", async (t) => {
  const h = await fixture(t);
  const report = { evidence: "é".repeat(700_000) };
  await writeLifecycleV2MigrationReport(h.path, report);
  assert.deepEqual(await readLifecycleV2MigrationReport(h.path), report);
  assert.equal((await stat(h.path)).mode & 0o777, 0o600);
  await assert.rejects(readMigrationJson(h.path));
  await assert.rejects(readPrivateJson(h.path), /limit/);
  await assert.rejects(
    writeMigrationPlan(join(h.root, "catalog.json"), report),
    /limit/,
  );
  await assert.rejects(
    writePrivateJson(join(h.root, "runtime.json"), "x".repeat(65_536)),
    /limit/,
  );
  await assert.rejects(
    writePrivateJson(join(h.root, "override.json"), report, {
      maxBytes: 16 * 1024 * 1024,
    }),
    /Invalid private-file budget/,
  );
  assert.deepEqual(await readdir(h.root), ["report.json"]);
});

test("lifecycle report writes include the exact 16 MiB serialized boundary", async (t) => {
  const h = await fixture(t);
  const report = "x".repeat(16 * 1024 * 1024 - 2);
  await writeLifecycleV2MigrationReport(h.path, report);
  assert.equal((await stat(h.path)).size, 16 * 1024 * 1024);
  assert.equal(await readLifecycleV2MigrationReport(h.path), report);
});

test("lifecycle report reads allow the exact 16 MiB boundary", async (t) => {
  const h = await fixture(t);
  const report = "x".repeat(16 * 1024 * 1024 - 2);
  await writeFile(h.path, JSON.stringify(report), { mode: 0o600 });
  assert.equal(await readLifecycleV2MigrationReport(h.path), report);
});

test("lifecycle report writes reject UTF-8 bytes beyond 16 MiB before creating files", async (t) => {
  const h = await fixture(t);
  await assert.rejects(
    writeLifecycleV2MigrationReport(h.path, "é".repeat(8 * 1024 * 1024)),
    /limit/,
  );
  assert.deepEqual(await readdir(h.root), []);
});

test("lifecycle report reads reject bytes beyond 16 MiB", async (t) => {
  const h = await fixture(t);
  await writeFile(h.path, JSON.stringify("é".repeat(8 * 1024 * 1024)), {
    mode: 0o600,
  });
  await assert.rejects(readLifecycleV2MigrationReport(h.path), /bounded file/);
});

test("lifecycle reports never replace existing evidence or follow links", async (t) => {
  const h = await fixture(t);
  const report = { evidence: "original" };
  await writeLifecycleV2MigrationReport(h.path, report);
  await assert.rejects(
    writeLifecycleV2MigrationReport(h.path, { replaced: true }),
  );
  assert.deepEqual(await readLifecycleV2MigrationReport(h.path), report);
  const link = join(h.root, "link.json");
  await symlink(h.path, link);
  await assert.rejects(readLifecycleV2MigrationReport(link));
  await assert.rejects(
    writeLifecycleV2MigrationReport(link, { replaced: true }),
  );
  assert.deepEqual(await readLifecycleV2MigrationReport(h.path), report);
  assert.deepEqual((await readdir(h.root)).sort(), [
    "link.json",
    "report.json",
  ]);
});

test("lifecycle reports refuse unsafe modes, unsafe parents and malformed JSON", async (t) => {
  const h = await fixture(t);
  await writeLifecycleV2MigrationReport(h.path, { evidence: "original" });
  await chmod(h.path, 0o644);
  await assert.rejects(readLifecycleV2MigrationReport(h.path));
  await assert.rejects(
    writeLifecycleV2MigrationReport(h.path, { replaced: true }),
  );
  assert.equal(await readFile(h.path, "utf8"), '{"evidence":"original"}');
  await chmod(h.path, 0o600);
  await chmod(h.root, 0o777);
  try {
    await assert.rejects(readLifecycleV2MigrationReport(h.path), /parent/);
    await assert.rejects(
      writeLifecycleV2MigrationReport(join(h.root, "unsafe.json"), {}),
      /parent/,
    );
  } finally {
    await chmod(h.root, 0o700);
  }
  await writeFile(h.path, "{malformed");
  await assert.rejects(
    readLifecycleV2MigrationReport(h.path),
    /Invalid migration JSON/,
  );
});
