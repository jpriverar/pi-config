import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = join(repository, "scripts", "check-licenses.mjs");
const roots: string[] = [];

function createFixture() {
  const base = mkdtempSync(join(tmpdir(), "license-fixture-"));
  roots.push(base);
  const root = join(base, "repo");
  mkdirSync(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "license-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name: "license-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "license-fixture", version: "1.0.0" } } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "README.md"), "original\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  return { base, root };
}

function run(root: string, output: string) {
  return spawnSync(process.execPath, [checker, "--output", output], {
    cwd: root,
    encoding: "utf8",
  });
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("creates a new external report exclusively with private mode", () => {
  const fixture = createFixture();
  const output = join(fixture.base, "report.json");
  const result = run(fixture.root, output);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), []);
  assert.equal(lstatSync(output).mode & 0o777, 0o600);
});

test("rejects outputs lexically or canonically inside the repository", async (t) => {
  await t.test("lexical child", () => {
    const fixture = createFixture();
    const result = run(fixture.root, join(fixture.root, "report.json"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside repository/);
  });

  await t.test("symlinked parent", () => {
    const fixture = createFixture();
    const alias = join(fixture.base, "repository-alias");
    symlinkSync(fixture.root, alias, "dir");
    const result = run(fixture.root, join(alias, "report.json"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside repository/);
  });
});

test("rejects final symlinks and existing files without overwriting", async (t) => {
  await t.test("final symlink", () => {
    const fixture = createFixture();
    const output = join(fixture.base, "report-link.json");
    const target = join(fixture.root, "README.md");
    symlinkSync(target, output);
    const result = run(fixture.root, output);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symbolic link|already exists/);
    assert.equal(readFileSync(target, "utf8"), "original\n");
  });

  await t.test("existing regular file", () => {
    const fixture = createFixture();
    const output = join(fixture.base, "existing.json");
    writeFileSync(output, "do not replace\n");
    const result = run(fixture.root, output);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.equal(readFileSync(output, "utf8"), "do not replace\n");
  });
});
