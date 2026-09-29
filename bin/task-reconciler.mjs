#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReconciler } from "../scripts/build-task-reconciler.mjs";
import { ADMIN_SOURCE } from "../lib/task-reconciler/admin-entry.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const usage =
  "task-reconciler <install|start|stop|status|update|uninstall|run> --config <absolute-path> [--rollback (update only)]";
/** @param {string | Buffer} value */
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** @param {string} path @param {boolean} privateFile */
async function read(path, privateFile) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (privateFile &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600))
    )
      throw new Error(`unowned or invalid bootstrap file: ${path}`);
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > 65536) throw new Error(`bootstrap file too large: ${path}`);
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
/** @param {string} path @param {boolean} privateFile */
async function json(path, privateFile) {
  const bytes = await read(path, privateFile);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`invalid bootstrap JSON: ${path}`);
  }
}
/** @param {string} configPath */
async function installedEntry(configPath) {
  const config = await json(await realpath(configPath), false);
  if (
    config?.version !== 1 ||
    typeof config.store !== "string" ||
    !isAbsolute(config.store)
  )
    throw new Error("invalid daemon store configuration");
  const store = await realpath(config.store);
  const key = hash(store).slice(0, 16);
  const root = join(
    await realpath(homedir()),
    ".pi/task-reconciler/services",
    key,
  );
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT")
      return undefined;
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error(`unowned installation: ${root}`);
  for (let parent = dirname(await realpath(root)); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (
      (info.uid !== process.getuid?.() && info.uid !== 0) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    )
      throw new Error(`unsafe installation parent: ${parent}`);
    if (parent === dirname(parent)) break;
  }
  let manifest;
  try {
    manifest = await json(join(root, "service.json"), true);
  } catch (error) {
    if (
      /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" &&
      (await readdir(root)).length === 0
    )
      return undefined;
    throw error;
  }
  if (
    manifest?.version !== 1 ||
    manifest.managedBy !== "pi-config:task-reconciler" ||
    manifest.uid !== process.getuid?.() ||
    manifest.store !== store ||
    manifest.label !== `com.pi.task-reconciler.${key}` ||
    !/^[a-z0-9][a-z0-9-]{0,95}$/.test(manifest.currentDeployment)
  )
    throw new Error("unverifiable installed admin identity");
  const admin = join(root, "admin.mjs");
  const content = await read(admin, true);
  if (
    hash(content) !== manifest.adminHash ||
    content.toString("utf8") !== ADMIN_SOURCE
  )
    throw new Error("installed admin entry point is corrupted");
  return { path: admin, deployment: manifest.currentDeployment };
}
/** @param {readonly string[]} argv */
export async function runLauncher(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(usage);
    return 0;
  }
  const action = argv[0];
  const indexes = argv.flatMap((arg, i) => (arg === "--config" ? [i] : []));
  const configPath = indexes.length === 1 ? argv[indexes[0] + 1] : undefined;
  if (
    ![
      "install",
      "start",
      "stop",
      "status",
      "update",
      "uninstall",
      "run",
    ].includes(action) ||
    !configPath ||
    !isAbsolute(configPath)
  )
    throw new Error(usage);
  const installed = await installedEntry(configPath);
  let entry = installed?.path;
  if (!entry) {
    if (action !== "install")
      throw new Error(
        "No installed admin runtime. Run install explicitly, or build:reconciler and use the printed runtime's lib/task-reconciler/cli.js for foreground tests.",
      );
    console.error("Building the standalone task-reconciler runtime...");
    const build = await buildReconciler({ packageRoot });
    entry = join(build.directory, build.manifest.entry);
  }
  const { runCli } = await import(pathToFileURL(entry).href);
  return runCli(argv, {
    sourceRoot: packageRoot,
    deployment: installed?.deployment,
  });
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runLauncher(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "task reconciler launcher failed",
    );
    process.exitCode = 1;
  }
}
