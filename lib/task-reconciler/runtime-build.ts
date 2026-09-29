import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as nativeFs from "node:fs/promises";
import { join } from "node:path";

export interface RuntimeManifest {
  version: 1;
  runtimeVersion: string;
  sourceRevision: string;
  sourceDigest: string;
  entry: "lib/task-reconciler/cli.js";
  files: Record<string, string>;
}
export interface RuntimeBuild {
  directory: string;
  manifest: RuntimeManifest;
}
export type FileSystem = typeof nativeFs;
export const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export const safeVersion = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,95}$/.test(value);
export function safeRelativePath(value: string): boolean {
  return (
    /^[A-Za-z0-9_.\/-]+$/.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== "")
  );
}
export async function readBoundedFile(
  path: string,
  fs: FileSystem = nativeFs,
  uid?: number,
  limit = 64 * 1024,
): Promise<Buffer> {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > limit ||
      (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o777) !== 0o600))
    )
      throw new Error(`unowned or invalid bounded file: ${path}`);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > limit) throw new Error(`file exceeds limit: ${path}`);
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
export async function readJson(
  path: string,
  fs: FileSystem = nativeFs,
  uid?: number,
): Promise<unknown> {
  const data = await readBoundedFile(path, fs, uid);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new Error(`invalid JSON at ${path}`);
  }
}
export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid runtime manifest");
  const m = value as Record<string, unknown>;
  if (
    m.version !== 1 ||
    !safeVersion(m.runtimeVersion) ||
    typeof m.sourceRevision !== "string" ||
    !/^(?:[a-f0-9]{40,64}|unknown)$/.test(m.sourceRevision) ||
    typeof m.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.sourceDigest) ||
    m.entry !== "lib/task-reconciler/cli.js" ||
    m.files === null ||
    typeof m.files !== "object" ||
    Array.isArray(m.files)
  )
    throw new Error("invalid runtime manifest fields");
  const files = m.files as Record<string, unknown>;
  if (
    Object.keys(files).length > 200 ||
    !Object.hasOwn(files, m.entry) ||
    !Object.hasOwn(files, "package.json")
  )
    throw new Error("runtime manifest has invalid inventory");
  for (const [path, hash] of Object.entries(files))
    if (
      !safeRelativePath(path) ||
      path === "manifest.json" ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error("runtime manifest has invalid file digest");
  return m as unknown as RuntimeManifest;
}
export async function listFiles(
  directory: string,
  fs: FileSystem = nativeFs,
): Promise<string[]> {
  const result: string[] = [];
  async function walk(relative: string): Promise<void> {
    const path = join(directory, relative);
    const info = await fs.lstat(path);
    if (info.isSymbolicLink())
      throw new Error(`runtime contains a symlink: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(path)).sort())
        await walk(relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) result.push(relative);
    else throw new Error(`runtime contains an unsupported file: ${path}`);
    if (result.length > 220) throw new Error("runtime contains too many files");
  }
  await walk("");
  return result;
}
export async function verifyRuntimeBuild(
  directory: string,
  fs: FileSystem = nativeFs,
  additional: readonly string[] = [],
): Promise<RuntimeBuild> {
  const manifest = parseRuntimeManifest(
    await readJson(join(directory, "manifest.json"), fs),
  );
  const allowed = new Set([
    "manifest.json",
    ...Object.keys(manifest.files),
    ...additional,
  ]);
  for (const path of await listFiles(directory, fs))
    if (!allowed.has(path)) throw new Error(`unowned runtime file: ${path}`);
  for (const [path, hash] of Object.entries(manifest.files))
    if (
      digest(
        await readBoundedFile(
          join(directory, path),
          fs,
          undefined,
          16 * 1024 * 1024,
        ),
      ) !== hash
    )
      throw new Error(`runtime digest mismatch: ${path}`);
  return { directory, manifest };
}
