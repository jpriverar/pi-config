import type { Stats } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { inspectRepository } from "./git-state.js";
import type { LeaseRecord } from "./lease-records.js";
import { managedWorktreePath } from "./managed-worktree.js";
import type { GitRunner, ResolvedRepository } from "./types.js";

const COOKIE_NAME = /^\.watchman-cookie-[A-Za-z0-9_.-]+-\d+-\d+$/;
type Remnants = {
  path: string;
  directory?: Stats;
  cookies: Map<string, Stats>;
};

export async function inspectRemovalRemnants(
  repository: ResolvedRepository,
  record: LeaseRecord,
  runGit: GitRunner,
): Promise<Remnants> {
  if (
    record.state !== "removing" ||
    record.repository !== repository.name ||
    record.path !== managedWorktreePath(repository, record.pathId)
  )
    throw new Error(`claim ${record.claimId} is not an exact removing journal`);

  const common = await runGit(repository.path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (common.code !== 0)
    throw new Error(
      `cannot inspect Git common directory: ${common.stderr || common.stdout}`,
    );
  const expectedCommon = await realpath(repository.commonDir);
  if (
    (await realpath(record.repositoryCommonDir)) !== expectedCommon ||
    (await realpath(common.stdout.trim())) !== expectedCommon
  ) {
    throw new Error(
      `claim ${record.claimId} Git common directory contradicts discovery`,
    );
  }

  const canonicalRoot = await realpath(repository.poolRoot);
  await plainDirectory(repository.poolRoot);
  const marker = join(repository.poolRoot, ".pi-worktree-pool-root.json");
  const markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink())
    throw new Error(`invalid pool root marker ${marker}`);
  const value = JSON.parse(await readFile(marker, "utf8"));
  if (
    value?.version !== 2 ||
    value?.root !== repository.poolRoot ||
    value?.layout !== "ephemeral"
  ) {
    throw new Error(`invalid pool root marker ${marker}`);
  }
  const poolRelative = relative(repository.poolRoot, repository.poolDir);
  if (
    !poolRelative ||
    poolRelative.split(sep).includes("..") ||
    resolve(repository.poolRoot, poolRelative) !== repository.poolDir
  ) {
    throw new Error(`invalid repository pool directory ${repository.poolDir}`);
  }
  let parent = repository.poolRoot;
  for (const component of poolRelative.split(sep)) {
    parent = join(parent, component);
    await plainDirectory(parent);
    if (
      (await realpath(parent)) !==
      join(canonicalRoot, relative(repository.poolRoot, parent))
    ) {
      throw new Error(`repository pool directory changed: ${parent}`);
    }
  }
  const path = join(
    await realpath(repository.poolDir),
    `worktree-${record.pathId}`,
  );
  const registrations = await inspectRepository(repository, runGit);
  if (
    registrations.length === 0 ||
    registrations.some((entry) => !entry.valid)
  ) {
    throw new Error(
      `Git registration inspection is ambiguous for ${record.path}`,
    );
  }
  for (const worktree of registrations) {
    const candidate = await realpath(worktree.path).catch((error) => {
      if (hasCode(error, "ENOENT")) return resolve(worktree.path);
      throw error;
    });
    if (candidate === path || candidate.startsWith(path + sep)) {
      throw new Error(`Git registration still exists at ${worktree.path}`);
    }
  }
  let directory: Stats;
  try {
    directory = await plainDirectory(record.path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { path, cookies: new Map() };
    throw error;
  }
  if ((await realpath(record.path)) !== path)
    throw new Error(`managed directory changed: ${record.path}`);
  const cookies = new Map<string, Stats>();
  for (const name of await readdir(path)) {
    const stats = await lstat(join(path, name));
    requireCookie(name, stats, path);
    cookies.set(name, stats);
  }
  return { path, directory, cookies };
}

export async function removeRemovalRemnants(
  repository: ResolvedRepository,
  record: LeaseRecord,
  runGit: GitRunner,
  stopWatch: ((path: string) => Promise<void>) | undefined,
): Promise<void> {
  const before = await inspectRemovalRemnants(repository, record, runGit);
  if (!before.directory) return;
  if (!stopWatch)
    throw new Error(`Watchman inspection is unavailable for ${record.path}`);
  await stopWatch(before.path);
  const after = await inspectRemovalRemnants(repository, record, runGit);
  if (!after.directory || !sameIdentity(before.directory, after.directory)) {
    throw new Error(
      `managed directory changed while stopping Watchman: ${record.path}`,
    );
  }
  for (const [name, stats] of before.cookies) {
    const current = after.cookies.get(name);
    if (current && !sameCookie(stats, current))
      throw new Error(`Watchman cookie changed: ${join(after.path, name)}`);
  }
  for (const [name, expected] of after.cookies) {
    await requireSameDirectory(after);
    const file = join(after.path, name);
    const current = await lstat(file);
    requireCookie(name, current, after.path);
    if (!sameCookie(expected, current))
      throw new Error(`Watchman cookie changed: ${file}`);
    await unlink(file);
  }
  const final = await inspectRemovalRemnants(repository, record, runGit);
  if (!final.directory || !sameIdentity(after.directory, final.directory)) {
    throw new Error(`managed directory changed during cleanup: ${record.path}`);
  }
  // A concurrent writer must make removal fail, never expand the deletion set.
  await rmdir(after.path);
}

async function plainDirectory(path: string): Promise<Stats> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`not a plain managed directory: ${path}`);
  return stats;
}
async function requireSameDirectory(expected: Remnants): Promise<void> {
  const actual = await plainDirectory(expected.path);
  if (!expected.directory || !sameIdentity(expected.directory, actual))
    throw new Error(`managed directory changed: ${expected.path}`);
}
function requireCookie(name: string, stats: Stats, path: string): void {
  if (
    !COOKIE_NAME.test(name) ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size !== 0 ||
    stats.nlink !== 1
  ) {
    throw new Error(
      `unknown removal remnant ${join(path, name)}; only empty regular Watchman cookies are safe`,
    );
  }
}
function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameCookie(a: Stats, b: Stats): boolean {
  return (
    sameIdentity(a, b) && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs
  );
}
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
