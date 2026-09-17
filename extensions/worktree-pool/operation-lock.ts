import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ResolvedRepository } from "./types.js";

export type OwnerIdentity = {
  pid: number;
  sessionId: string;
  host: string;
  started: number;
};

export type OperationLockDependencies = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  isPidAlive: (pid: number) => "live" | "dead" | "ambiguous";
  hostname: string;
  timeoutMs: number;
};

type LockObservation =
  | { kind: "readable"; owner: OwnerIdentity }
  | { kind: "external" }
  | { kind: "unreadable" };

type ReclaimResult = {
  observation: LockObservation;
};

const RETRY_INTERVAL_MS = 25;
const OWNER_PREFIX = "owner-";
const OWNER_SUFFIX = ".json";
const MAX_OWNER_BYTES = 16 * 1024;

export async function withOperationLock<T>(
  repository: ResolvedRepository,
  owner: OwnerIdentity,
  fn: () => Promise<T>,
  deps: OperationLockDependencies,
): Promise<T> {
  const lockRoot = join(repository.commonDir, "pi-worktree-pool");
  const lockPath = join(lockRoot, "operation.lock");
  const heldPath = join(lockPath, "held");
  const ownerEntry = `${OWNER_PREFIX}${randomUUID()}${OWNER_SUFFIX}`;
  const ownerPath = join(heldPath, ownerEntry);
  const ownerContents = JSON.stringify(owner);
  const deadline = deps.now() + Math.max(0, deps.timeoutMs);

  await mkdir(lockRoot, { recursive: true });
  await waitForStableContainer(lockPath, deadline, deps);

  let acquired = false;
  let lastObservation: LockObservation = { kind: "unreadable" };
  while (!acquired) {
    try {
      await mkdir(heldPath);
      try {
        await writeFile(ownerPath, ownerContents, { flag: "wx" });
        acquired = true;
      } catch (error) {
        if (await unlinkExactOwner(ownerPath)) {
          await rmdir(heldPath).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      if (!isLockCollision(error)) {
        throw new Error(
          `failed to create operation lock ${heldPath}: ${errorMessage(error)}`,
        );
      }

      const result = await observeAndReclaimDeadLocalLock(heldPath, deps);
      lastObservation = result.observation;
      await waitOrTimeout(lockPath, lastObservation, deadline, deps);
    }
  }

  try {
    const result = await fn();
    await removeOwnedLock(heldPath, ownerEntry);
    acquired = false;
    return result;
  } catch (error) {
    await removeOwnedLock(heldPath, ownerEntry).catch(() => undefined);
    acquired = false;
    throw error;
  } finally {
    if (acquired)
      await removeOwnedLock(heldPath, ownerEntry).catch(() => undefined);
  }
}

async function waitForStableContainer(
  lockPath: string,
  deadline: number,
  deps: OperationLockDependencies,
): Promise<void> {
  while (true) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw new Error(
          `failed to create operation lock container ${lockPath}: ${errorMessage(error)}`,
        );
      }
    }

    try {
      const metadata = await lstat(lockPath);
      if (metadata.isDirectory()) return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw new Error(
          `failed to inspect operation lock container ${lockPath}: ${errorMessage(error)}`,
        );
      }
    }

    await waitOrTimeout(lockPath, { kind: "external" }, deadline, deps);
  }
}

async function observeAndReclaimDeadLocalLock(
  heldPath: string,
  deps: OperationLockDependencies,
): Promise<ReclaimResult> {
  try {
    if (!(await lstat(heldPath)).isDirectory()) {
      return { observation: { kind: "unreadable" } };
    }
  } catch {
    return { observation: { kind: "unreadable" } };
  }

  let entries: string[];
  try {
    entries = await readdir(heldPath);
  } catch (error) {
    if (hasCode(error, "ENOENT"))
      return { observation: { kind: "unreadable" } };
    return { observation: { kind: "unreadable" } };
  }

  const ownerEntries = entries.filter(isOwnerEntry);
  if (entries.length !== 1 || ownerEntries.length !== 1) {
    return { observation: { kind: "unreadable" } };
  }

  const ownerPath = join(heldPath, ownerEntries[0]);
  const raw = await readRegularOwner(ownerPath);
  if (raw === undefined) return { observation: { kind: "unreadable" } };

  const owner = parseOwner(raw);
  if (owner === undefined) return { observation: { kind: "unreadable" } };

  const observation: LockObservation = { kind: "readable", owner };
  if (owner.host !== deps.hostname || deps.isPidAlive(owner.pid) !== "dead") {
    return { observation };
  }

  try {
    await unlink(ownerPath);
  } catch {
    return { observation };
  }
  try {
    await rmdir(heldPath);
  } catch {
    // A non-empty replacement is not the dead lock this invocation verified.
  }
  return { observation };
}

async function readRegularOwner(
  ownerPath: string,
): Promise<string | undefined> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(ownerPath);
  } catch {
    return undefined;
  }
  if (!pathMetadata.isFile() || pathMetadata.size > MAX_OWNER_BYTES)
    return undefined;

  let handle;
  try {
    handle = await open(
      ownerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }

  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.size > MAX_OWNER_BYTES ||
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      return undefined;
    }
    const bytes = Buffer.alloc(MAX_OWNER_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_OWNER_BYTES) return undefined;
    return bytes.subarray(0, total).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function removeOwnedLock(
  heldPath: string,
  ownerEntry: string,
): Promise<void> {
  if (!(await unlinkExactOwner(join(heldPath, ownerEntry)))) return;

  try {
    await rmdir(heldPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) throw error;
  }
}

async function unlinkExactOwner(ownerPath: string): Promise<boolean> {
  try {
    await unlink(ownerPath);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isOwnerEntry(entry: string): boolean {
  return entry.startsWith(OWNER_PREFIX) && entry.endsWith(OWNER_SUFFIX);
}

function parseOwner(raw: string): OwnerIdentity | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;

  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    typeof record.host !== "string" ||
    record.host.length === 0 ||
    typeof record.started !== "number" ||
    !Number.isFinite(record.started) ||
    record.started < 0
  ) {
    return undefined;
  }

  return {
    pid: record.pid as number,
    sessionId: record.sessionId,
    host: record.host,
    started: record.started,
  };
}

async function waitOrTimeout(
  lockPath: string,
  observation: LockObservation,
  deadline: number,
  deps: OperationLockDependencies,
): Promise<void> {
  if (deps.now() >= deadline) {
    throw timeoutError(lockPath, observation, deps.now());
  }
  await deps.sleep(
    Math.min(RETRY_INTERVAL_MS, Math.max(1, deadline - deps.now())),
  );
}

function timeoutError(
  lockPath: string,
  observation: LockObservation,
  now: number,
): Error {
  if (observation.kind === "external") {
    return new Error(
      `timed out acquiring operation lock ${lockPath}: external or ambiguous lock representation`,
    );
  }
  if (observation.kind === "unreadable") {
    return new Error(
      `timed out acquiring operation lock ${lockPath}: unreadable owner metadata`,
    );
  }
  const age = Math.max(0, now - observation.owner.started);
  return new Error(
    `timed out acquiring operation lock ${lockPath}: held by host ${observation.owner.host}, PID ${observation.owner.pid}, age ${age}ms`,
  );
}

function isLockCollision(error: unknown): boolean {
  return hasCode(error, "EEXIST") || hasCode(error, "ENOTDIR");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
