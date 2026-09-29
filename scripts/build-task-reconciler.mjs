import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ownRoot = dirname(dirname(fileURLToPath(import.meta.url)));
/** @param {string | Buffer} bytes */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {string} directory @returns {Promise<string[]>} */
async function files(directory) {
  /** @type {string[]} */ const result = [];
  /** @param {string} relative */
  async function walk(relative) {
    const path = join(directory, relative);
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error(`build contains a symlink: ${path}`);
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort())
        await walk(relative ? `${relative}/${name}` : name);
    else if (stat.isFile()) result.push(relative);
    else throw new Error(`build contains an unsupported file: ${path}`);
  }
  await walk("");
  return result;
}
/** @param {{packageRoot?: string}} [options] @returns {Promise<import('../lib/task-reconciler/runtime-build.js').RuntimeBuild>} */
export async function buildReconciler({ packageRoot = ownRoot } = {}) {
  const compiler = join(packageRoot, "node_modules/typescript/bin/tsc");
  try {
    await access(compiler);
  } catch {
    throw new Error(
      `TypeScript compiler missing; run npm ci --ignore-scripts in ${packageRoot}`,
    );
  }
  const pkg = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (pkg.name !== "jpriverar-pi-config")
    throw new Error("refusing to build an unrelated package");
  const cache = join(packageRoot, ".reconciler-build");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  if ((await lstat(cache)).isSymbolicLink())
    throw new Error("build cache must not be a symlink");
  const staging = await mkdtemp(join(cache, ".staging-"));
  const env = {
    HOME: process.env.HOME,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LC_ALL: "C",
  };
  try {
    await exec(
      process.execPath,
      [
        compiler,
        "--project",
        join(packageRoot, "tsconfig.reconciler.json"),
        "--outDir",
        staging,
        "--pretty",
        "false",
      ],
      { cwd: packageRoot, env, timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    await writeFile(
      join(staging, "package.json"),
      JSON.stringify({ type: "module", private: true }),
    );
    for (const asset of [
      "extensions/task-lifecycle/config.json",
      "extensions/worktree-pool/config.json",
    ]) {
      await mkdir(dirname(join(staging, asset)), { recursive: true });
      await cp(join(packageRoot, asset), join(staging, asset));
    }
    let sourceRevision = "unknown";
    try {
      const result = await exec(
        "/usr/bin/git",
        ["-C", packageRoot, "rev-parse", "HEAD"],
        { env, timeout: 5000 },
      );
      if (/^[a-f0-9]{40,64}$/.test(result.stdout.trim()))
        sourceRevision = result.stdout.trim();
    } catch {
      /* A package archive need not include Git metadata. */
    }
    const names = await files(staging);
    if (names.some((path) => /(?:\.test\.js$|fixtures|^tests\/)/.test(path)))
      throw new Error("test-only code leaked into the runtime");
    const compilerVersion = JSON.parse(
      await readFile(
        join(packageRoot, "node_modules/typescript/package.json"),
        "utf8",
      ),
    ).version;
    const sourceHash = createHash("sha256").update(
      `${sourceRevision}\n${compilerVersion}\n`,
    );
    for (const name of names)
      sourceHash
        .update(name)
        .update("\0")
        .update(await readFile(join(staging, name)))
        .update("\0");
    const sourceDigest = sourceHash.digest("hex");
    const runtimeVersion = `${sourceRevision.slice(0, 7)}-${sourceDigest.slice(0, 16)}`;
    await writeFile(
      join(staging, "lib/task-reconciler/build-info.js"),
      `export const RUNTIME_VERSION = ${JSON.stringify(runtimeVersion)};\n`,
    );
    /** @type {Record<string, string>} */ const inventory = {};
    for (const name of names) {
      inventory[name] = hash(await readFile(join(staging, name)));
      await chmod(join(staging, name), 0o600);
    }
    /** @type {import('../lib/task-reconciler/runtime-build.js').RuntimeManifest} */
    const manifest = {
      version: 1,
      runtimeVersion,
      sourceRevision,
      sourceDigest,
      entry: "lib/task-reconciler/cli.js",
      files: inventory,
    };
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    const directory = join(cache, runtimeVersion);
    try {
      await rename(staging, directory);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          /** @type {NodeJS.ErrnoException} */ (error).code ?? "",
        )
      )
        throw error;
      const prior = JSON.parse(
        await readFile(join(directory, "manifest.json"), "utf8"),
      );
      if (JSON.stringify(prior) !== JSON.stringify(manifest))
        throw new Error(`build identity collision at ${directory}`);
      for (const [name, digest] of Object.entries(inventory))
        if (hash(await readFile(join(directory, name))) !== digest)
          throw new Error(`existing build is corrupted: ${name}`);
    }
    return { directory, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    const result = await buildReconciler();
    console.log(
      process.argv.includes("--json")
        ? JSON.stringify(result)
        : `Built task reconciler ${result.manifest.runtimeVersion} at ${result.directory}`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "task reconciler build failed",
    );
    process.exitCode = 1;
  }
}
