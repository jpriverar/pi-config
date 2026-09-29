import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { DaemonConfig } from "./config.js";

export const MAX_PRIVATE_BYTES = 64 * 1024;
export class RuntimeBoundaryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface RuntimePaths {
  store: string;
  storeKey: string;
  root: string;
  lockRoot: string;
  socket: string;
  identity: string;
  health: string;
}
export function localPidState(pid: number): "live" | "dead" | "ambiguous" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "ambiguous";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "dead" : code === "EPERM" ? "live" : "ambiguous";
  }
}
function verifyPrivate(
  path: string,
  info: Stats,
  kind: "directory" | "file" | "socket",
): void {
  if (process.getuid === undefined || info.uid !== process.getuid())
    throw new RuntimeBoundaryError(
      "unsafe_owner",
      `private runtime has a foreign owner: ${JSON.stringify(path)}`,
    );
  const correctType =
    kind === "directory"
      ? info.isDirectory()
      : kind === "file"
        ? info.isFile()
        : info.isSocket();
  if (!correctType || info.isSymbolicLink())
    throw new RuntimeBoundaryError(
      "unsafe_type",
      `private runtime ${kind} is invalid or a symlink: ${JSON.stringify(path)}`,
    );
  if ((info.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600))
    throw new RuntimeBoundaryError(
      "unsafe_mode",
      `private runtime has unsafe mode: ${JSON.stringify(path)}`,
    );
}
async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  verifyPrivate(path, await lstat(path), "directory");
}
export async function verifyPrivateSocket(path: string): Promise<void> {
  verifyPrivate(path, await lstat(path), "socket");
}
async function verifyParents(base: string): Promise<void> {
  for (let parent = dirname(base); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (
      (info.uid !== process.getuid?.() && info.uid !== 0) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    )
      throw new RuntimeBoundaryError(
        "unsafe_parent",
        `runtime parent is writable by another owner: ${JSON.stringify(parent)}`,
      );
    if (parent === dirname(parent)) break;
  }
}
export async function resolveDaemonLock(
  store: string,
  create: boolean,
): Promise<string> {
  const canonical = await realpath(store);
  const path = join(canonical, "pi-task-reconciler");
  await verifyParents(path);
  await privateDirectory(path, create);
  return path;
}

export async function resolveRuntimePaths(
  config: DaemonConfig,
  create: boolean,
): Promise<RuntimePaths> {
  if (
    ![config.store, config.runtimeRoot].every(
      (p) => isAbsolute(p) && !/[\u0000-\u001f\u007f]/.test(p),
    )
  )
    throw new RuntimeBoundaryError(
      "invalid_path",
      "store and runtimeRoot require absolute paths",
    );
  const store = await realpath(config.store);
  if (!(await lstat(store)).isDirectory())
    throw new RuntimeBoundaryError(
      "invalid_store",
      `store is not a directory: ${JSON.stringify(store)}`,
    );
  await privateDirectory(config.runtimeRoot, create);
  const base = await realpath(config.runtimeRoot);
  await verifyParents(base);
  const storeKey = createHash("sha256")
    .update(store)
    .digest("hex")
    .slice(0, 16);
  const root = join(base, storeKey);
  const socket = join(root, "rpc.sock");
  const limit =
    process.platform === "darwin"
      ? 103
      : process.platform === "linux"
        ? 107
        : 0;
  if (Buffer.byteLength(socket) > limit)
    throw new RuntimeBoundaryError(
      "socket_path_limit",
      `socket path exceeds platform limit: ${JSON.stringify(socket)}`,
    );
  await privateDirectory(root, create);
  const lockRoot = await resolveDaemonLock(store, create);
  return {
    store,
    storeKey,
    root,
    lockRoot,
    socket,
    identity: join(root, "identity.json"),
    health: join(root, "health.json"),
  };
}

export async function readPrivateJson(path: string): Promise<unknown> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    verifyPrivate(path, info, "file");
    if (info.size > MAX_PRIVATE_BYTES)
      throw new RuntimeBoundaryError(
        "file_too_large",
        `private JSON exceeds limit: ${JSON.stringify(path)}`,
      );
    const buffer = Buffer.alloc(MAX_PRIVATE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_PRIVATE_BYTES)
      throw new RuntimeBoundaryError(
        "file_too_large",
        `private JSON exceeds limit: ${JSON.stringify(path)}`,
      );
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, size),
        ),
      );
    } catch {
      throw new RuntimeBoundaryError(
        "invalid_json",
        `invalid private JSON: ${JSON.stringify(path)}`,
      );
    }
  } finally {
    await handle.close();
  }
}
export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_PRIVATE_BYTES)
    throw new RuntimeBoundaryError(
      "file_too_large",
      `private JSON exceeds limit: ${JSON.stringify(path)}`,
    );
  try {
    verifyPrivate(path, await lstat(path), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
