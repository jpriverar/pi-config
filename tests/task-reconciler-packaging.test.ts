import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildReconciler } from "../scripts/build-task-reconciler.mjs";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package exposes only explicit build/admin entry points, with no installation hooks", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.bin["task-reconciler"], "./bin/task-reconciler.mjs");
  assert.equal(
    pkg.scripts["build:reconciler"],
    "node scripts/build-task-reconciler.mjs",
  );
  for (const hook of [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "prepare",
    "postprepare",
  ])
    assert.equal(pkg.scripts[hook], undefined);
  assert.ok(
    pkg.pi.extensions.every((path: string) => !path.includes("reconciler")),
  );
});

test("importing the Node launcher cannot execute commands or create service files", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "reconciler-import-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const program = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; for (const key of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork']) cp[key] = () => {throw new Error('unexpected command execution')}; syncBuiltinESMExports(); await import(${JSON.stringify(new URL("../bin/task-reconciler.mjs", import.meta.url).href)});`;
  await exec(process.execPath, ["--input-type=module", "-e", program], {
    env: { HOME: home, PATH: process.env.PATH },
  });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(home), []);
});

test("missing compiler is an explicit setup error and does not create an installation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reconciler-no-compiler-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "package.json"),
    await readFile(join(root, "package.json")),
  );
  await assert.rejects(
    buildReconciler({ packageRoot: directory }),
    /compiler|typescript|npm ci/i,
  );
});

test(
  "built runtime loads outside the checkout without tsx, Pi packages, or node_modules",
  { timeout: 60000 },
  async (t) => {
    const built = await buildReconciler({ packageRoot: root });
    const directory = await mkdtemp(join(tmpdir(), "reconciler-hermetic-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const home = join(directory, "home");
    await mkdir(home);
    const isolated = join(directory, "runtime");
    await cp(built.directory, isolated, { recursive: true });
    const result = await exec(
      process.execPath,
      [join(isolated, built.manifest.entry), "--runtime-info"],
      {
        cwd: directory,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        timeout: 15000,
      },
    );
    const info = JSON.parse(result.stdout);
    assert.equal(info.protocolVersion, 1);
    assert.equal(info.runtimeVersion, built.manifest.runtimeVersion);
    assert.notEqual(info.runtimeVersion, "source-unbuilt");
    const help = await exec(
      process.execPath,
      [join(isolated, built.manifest.entry), "--help"],
      {
        cwd: directory,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        timeout: 15000,
      },
    );
    assert.match(help.stdout, /--config/);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(home), []);
  },
);

test("an empty interrupted installation still reaches explicit compiler setup", async (t) => {
  const { realpath } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "reconciler-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const store = join(directory, "store");
  const source = join(directory, "source");
  await mkdir(home, { mode: 0o700 });
  await mkdir(store);
  for (const name of [
    "bin/task-reconciler.mjs",
    "scripts/build-task-reconciler.mjs",
    "lib/task-reconciler/admin-entry.mjs",
  ]) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await cp(join(root, name), join(source, name));
  }
  const key = createHash("sha256")
    .update(await realpath(store))
    .digest("hex")
    .slice(0, 16);
  await mkdir(join(home, ".pi/task-reconciler/services", key), {
    recursive: true,
    mode: 0o700,
  });
  const config = join(directory, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, store }));
  await assert.rejects(
    exec(
      process.execPath,
      [join(source, "bin/task-reconciler.mjs"), "install", "--config", config],
      { env: { HOME: home, PATH: "/usr/bin:/bin" } },
    ),
    (error: unknown) =>
      /compiler missing/.test(String((error as { stderr?: string }).stderr)),
  );
});
