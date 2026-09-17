import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export type LeaseRecordState = "creating" | "active" | "removing";

export type LeaseRecord = {
  version: 1;
  claimId: string;
  pathId: string;
  repository: string;
  repositoryCommonDir: string;
  path: string;
  branch: string;
  sessionId: string;
  host: string;
  pid: number;
  started: number;
  state: LeaseRecordState;
};

export type LeaseRecordGate =
  | { path: string; state: "valid"; record: LeaseRecord }
  | { path: string; state: "ambiguous"; reason: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,254}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_RECORD_BYTES = 16 * 1024;
const RECORD_FIELDS = [
  "version",
  "claimId",
  "pathId",
  "repository",
  "repositoryCommonDir",
  "path",
  "branch",
  "sessionId",
  "host",
  "pid",
  "started",
  "state",
] as const;
const STATES = new Set<LeaseRecordState>(["creating", "active", "removing"]);

export async function createLeaseRecord(
  root: string,
  data: LeaseRecord,
): Promise<void> {
  const record = validateRecord(root, data);
  const contents = serialize(record);
  await ensureHierarchy(root);
  const path = leasePath(root, record.pathId);
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) === "EEXIST")
      throw new Error(`lease record ${path} already exists`);
    throw contextualError(`create lease record ${path}`, error);
  }
}

export async function replaceLeaseRecord(
  root: string,
  expectedClaimId: string,
  data: LeaseRecord,
): Promise<void> {
  validateClaimId(expectedClaimId);
  const record = validateRecord(root, data);
  const hierarchy = await inspectHierarchy(root);
  if (hierarchy.kind !== "ready") {
    const reason =
      hierarchy.kind === "absent"
        ? "lease hierarchy is absent"
        : hierarchy.reason;
    throw new Error(
      `cannot replace expected claim ${expectedClaimId}: ${reason}`,
    );
  }
  const matches = (await listLeaseRecords(root)).filter(
    (gate) => gate.state === "valid" && gate.record.claimId === expectedClaimId,
  );
  if (matches.length !== 1 || matches[0].state !== "valid") {
    throw new Error(
      `cannot replace expected claim ${expectedClaimId}: found ${matches.length} records`,
    );
  }
  const observed = matches[0];
  if (record.pathId !== observed.record.pathId) {
    throw new Error(
      `cannot replace expected claim ${expectedClaimId}: path identity changed`,
    );
  }
  const oldPath = observed.path;
  const contents = serialize(record);
  const temporary = join(leasesRoot(root), `.replace-${randomUUID()}.tmp`);
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    const current = await inspectLeasePath(
      root,
      oldPath,
      observed.record.pathId,
    );
    if (
      current?.state !== "valid" ||
      current.record.claimId !== expectedClaimId
    ) {
      throw new Error(`lease record ${oldPath} changed before replacement`);
    }
    await rename(temporary, oldPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw contextualError(`replace lease record ${oldPath}`, error);
  }
}

export async function removeLeaseRecord(
  root: string,
  claimId: string,
): Promise<void> {
  validateClaimId(claimId);
  const hierarchy = await inspectHierarchy(root);
  if (hierarchy.kind === "absent") return;
  if (hierarchy.kind === "ambiguous") {
    throw new Error(
      `refusing to remove lease record ${claimId}: ${hierarchy.reason}`,
    );
  }
  const matches = (await listLeaseRecords(root)).filter(
    (gate) => gate.state === "valid" && gate.record.claimId === claimId,
  );
  if (matches.length === 0) return;
  if (matches.length !== 1 || matches[0].state !== "valid")
    throw new Error(`refusing to remove duplicate lease claim ${claimId}`);
  const observed = matches[0];
  const path = observed.path;
  const before = await lstat(path);
  const repeated = await inspectLeasePath(root, path, observed.record.pathId);
  if (repeated?.state !== "valid" || repeated.record.claimId !== claimId) {
    throw new Error(`refusing to remove changed lease record ${path}`);
  }
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(`refusing to remove replaced lease record ${path}`);
  }
  await unlink(path);
}

export async function listLeaseRecords(
  root: string,
): Promise<LeaseRecordGate[]> {
  const hierarchy = await inspectHierarchy(root);
  if (hierarchy.kind === "absent") return [];
  if (hierarchy.kind === "ambiguous") {
    return [
      { path: hierarchy.path, state: "ambiguous", reason: hierarchy.reason },
    ];
  }
  let entries;
  try {
    entries = await readdir(leasesRoot(root), { withFileTypes: true });
  } catch (error) {
    return [
      {
        path: leasesRoot(root),
        state: "ambiguous",
        reason: `lease root is unreadable: ${errorMessage(error)}`,
      },
    ];
  }
  const gates: LeaseRecordGate[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(leasesRoot(root), entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      gates.push({
        path,
        state: "ambiguous",
        reason: "entry is not a regular file",
      });
      continue;
    }
    const pathId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
    if (
      !UUID_PATTERN.test(pathId) ||
      entry.name !== `${pathId.toLowerCase()}.json`
    ) {
      gates.push({
        path,
        state: "ambiguous",
        reason: "entry has an invalid lease filename",
      });
      continue;
    }
    gates.push(
      (await inspectLeasePath(root, path, pathId)) ?? {
        path,
        state: "ambiguous",
        reason: "lease record disappeared during inspection",
      },
    );
  }
  return gates;
}

export async function listRepositoryLeaseRecords(
  root: string,
  repository: string,
): Promise<LeaseRecordGate[]> {
  return (await listLeaseRecords(root)).filter(
    (gate) =>
      gate.state === "ambiguous" || gate.record.repository === repository,
  );
}

export async function listSessionLeaseRecords(
  root: string,
  host: string,
  sessionId: string,
): Promise<LeaseRecordGate[]> {
  return (await listLeaseRecords(root)).filter(
    (gate) =>
      gate.state === "ambiguous" ||
      (gate.record.host === host && gate.record.sessionId === sessionId),
  );
}

function leasesRoot(root: string): string {
  return join(resolve(root), ".leases");
}

function leasePath(root: string, pathId: string): string {
  return join(leasesRoot(root), `${pathId.toLowerCase()}.json`);
}

async function ensureHierarchy(root: string): Promise<void> {
  try {
    await mkdir(resolve(root), { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      throw contextualError(`create pool root ${root}`, error);
  }
  await assertPlainDirectory(resolve(root), "pool root");
  try {
    await mkdir(leasesRoot(root), { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST")
      throw contextualError(`create lease root ${leasesRoot(root)}`, error);
  }
  await assertPlainDirectory(leasesRoot(root), "lease root");
}

type HierarchyObservation =
  | { kind: "ready" }
  | { kind: "absent" }
  | { kind: "ambiguous"; path: string; reason: string };

async function inspectHierarchy(root: string): Promise<HierarchyObservation> {
  for (const [path, label] of [
    [resolve(root), "pool root"],
    [leasesRoot(root), "lease root"],
  ] as const) {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { kind: "absent" };
      return {
        kind: "ambiguous",
        path,
        reason: `${label} is unreadable: ${errorMessage(error)}`,
      };
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return {
        kind: "ambiguous",
        path,
        reason: `${label} ${path} is not a plain directory`,
      };
    }
  }
  return { kind: "ready" };
}

async function inspectLeasePath(
  root: string,
  path: string,
  expectedPathId: string,
): Promise<LeaseRecordGate | undefined> {
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return {
      path,
      state: "ambiguous",
      reason: `record is unreadable: ${errorMessage(error)}`,
    };
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    return { path, state: "ambiguous", reason: "entry is not a regular file" };
  }
  if (initial.size > MAX_RECORD_BYTES) {
    return {
      path,
      state: "ambiguous",
      reason: `record exceeds ${MAX_RECORD_BYTES} bytes`,
    };
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino
    ) {
      return {
        path,
        state: "ambiguous",
        reason: "record changed during inspection",
      };
    }
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_RECORD_BYTES)
      return {
        path,
        state: "ambiguous",
        reason: `record exceeds ${MAX_RECORD_BYTES} bytes`,
      };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    } catch {
      return {
        path,
        state: "ambiguous",
        reason: "record contains malformed JSON",
      };
    }
    try {
      const record = validateRecord(root, parsed);
      if (record.pathId !== expectedPathId)
        throw new Error(
          "lease record path identity does not match its filename",
        );
      return { path, state: "valid", record };
    } catch (error) {
      return { path, state: "ambiguous", reason: errorMessage(error) };
    }
  } catch (error) {
    return {
      path,
      state: "ambiguous",
      reason: `record is unreadable: ${errorMessage(error)}`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateRecord(root: string, value: unknown): LeaseRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("lease record is malformed: expected object");
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter(
    (key) => !RECORD_FIELDS.includes(key as (typeof RECORD_FIELDS)[number]),
  );
  if (unknown.length > 0)
    throw new Error(
      `lease record has unknown field ${JSON.stringify(unknown[0])}`,
    );
  if (RECORD_FIELDS.some((field) => !(field in object)))
    throw new Error("lease record is malformed: missing field");
  if (object.version !== 1)
    throw new Error("lease record is malformed: invalid version");
  validateClaimId(object.claimId);
  validateClaimId(object.pathId);
  if (
    typeof object.repository !== "string" ||
    !REPOSITORY_PATTERN.test(object.repository) ||
    object.repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("lease record is malformed: invalid repository");
  }
  if (
    typeof object.repositoryCommonDir !== "string" ||
    !isAbsolute(object.repositoryCommonDir)
  ) {
    throw new Error("lease record is malformed: invalid repositoryCommonDir");
  }
  if (
    typeof object.path !== "string" ||
    !isAbsolute(object.path) ||
    !pathContains(resolve(root), resolve(object.path))
  ) {
    throw new Error("lease record is malformed: invalid managed path");
  }
  if (
    typeof object.branch !== "string" ||
    object.branch.length === 0 ||
    object.branch.length > 1024 ||
    /[\u0000\r\n]/.test(object.branch)
  ) {
    throw new Error("lease record is malformed: invalid branch");
  }
  for (const field of ["sessionId", "host"] as const) {
    if (
      typeof object[field] !== "string" ||
      !TOKEN_PATTERN.test(object[field])
    ) {
      throw new Error(`lease record is malformed: invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(object.pid) || (object.pid as number) <= 0)
    throw new Error("lease record is malformed: invalid pid");
  if (!Number.isSafeInteger(object.started) || (object.started as number) < 0)
    throw new Error("lease record is malformed: invalid started");
  if (!STATES.has(object.state as LeaseRecordState))
    throw new Error("lease record is malformed: invalid state");
  return object as LeaseRecord;
}

function serialize(record: LeaseRecord): string {
  const contents = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(contents) > MAX_RECORD_BYTES)
    throw new Error(`lease record exceeds ${MAX_RECORD_BYTES} bytes`);
  return contents;
}

function validateClaimId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value))
    throw new Error(
      `lease record is malformed: invalid claim ID ${JSON.stringify(value)}`,
    );
}

function pathContains(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
  );
}

async function assertPlainDirectory(
  path: string,
  label: string,
): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`${label} ${path} is not a plain directory`);
}

function contextualError(action: string, error: unknown): Error {
  return new Error(`failed to ${action}: ${errorMessage(error)}`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
