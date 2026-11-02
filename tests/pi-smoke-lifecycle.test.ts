import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSmokePackage } from "./pi-smoke.js";

const execute = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));

test("package smoke exercises both writers without changing supplied configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-smoke-lifecycle-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = await createSmokePackage(
    repository,
    join(root, "package"),
    2,
  );
  const policyPath = join(packagePath, "extensions/task-lifecycle/config.json");
  const before = await readFile(policyPath, "utf8");

  const { stdout } = await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      join(repository, "tests/pi-smoke.ts"),
      "--package",
      packagePath,
    ],
    { cwd: repository, timeout: 90_000, maxBuffer: 1024 * 1024 },
  );

  assert.match(stdout, /Pi package smoke verified \(lifecycle v1,/);
  assert.match(stdout, /Pi package smoke verified \(lifecycle v2,/);
  assert.equal(await readFile(policyPath, "utf8"), before);
});

test("package staging preserves symlink-backed policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-smoke-symlink-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createSmokePackage(repository, join(root, "source"), 1);
  const policyPath = join(source, "extensions/task-lifecycle/config.json");
  const backingPath = join(root, "shared-policy.json");
  await rename(policyPath, backingPath);
  await symlink(backingPath, policyPath);
  const before = await readFile(backingPath, "utf8");

  const snapshot = await createSmokePackage(source, join(root, "snapshot"), 2);

  assert.equal(await readFile(backingPath, "utf8"), before);
  const stagedPolicy = JSON.parse(
    await readFile(
      join(snapshot, "extensions/task-lifecycle/config.json"),
      "utf8",
    ),
  );
  assert.equal(stagedPolicy.lifecycleWriteVersion, 2);
});
