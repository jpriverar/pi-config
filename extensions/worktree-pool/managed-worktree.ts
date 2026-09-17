import {
  lstat,
  mkdir,
  readFile,
  realpath as nodeRealpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { inspectRepository } from "./git-state.js";
import type {
  GitRunner,
  Realpath,
  RegisteredWorktree,
  ResolvedRepository,
} from "./types.js";

export type ManagedWorktreeDependencies = {
  runGit: GitRunner;
  realpath?: Realpath;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANAGED_NAME_PATTERN =
  /^worktree-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const MARKER_NAME = ".pi-worktree-pool-root.json";

type PoolRootMarker = { version: 2; root: string; layout: "ephemeral" };

export function managedWorktreePath(
  repository: ResolvedRepository,
  pathId: string,
): string {
  if (!UUID_PATTERN.test(pathId))
    throw new Error(
      `invalid managed worktree path ID ${JSON.stringify(pathId)}`,
    );
  return join(repository.poolDir, `worktree-${pathId}`);
}

export async function createManagedWorktree(
  input: {
    repository: ResolvedRepository;
    pathId: string;
    branch: string;
    startPointHead: string;
  },
  deps: ManagedWorktreeDependencies,
): Promise<{ path: string; branchCreated: boolean }> {
  const { repository } = input;
  const path = managedWorktreePath(repository, input.pathId);
  await validateBranch(repository, input.branch, deps.runGit);
  await validateRevision(repository, input.startPointHead, deps.runGit);
  await verifyCommonDirectory(repository, deps);
  await ensurePoolHierarchy(repository, deps);
  await requireAbsentLeaf(path);

  const branchRef = `refs/heads/${input.branch}`;
  const branchProbe = await deps.runGit(repository.path, [
    "show-ref",
    "--verify",
    "--quiet",
    branchRef,
  ]);
  if (branchProbe.code !== 0 && branchProbe.code !== 1) {
    throw gitError(
      repository.path,
      ["show-ref", "--verify", "--quiet", branchRef],
      branchProbe,
    );
  }
  const branchCreated = branchProbe.code === 1;
  const args = branchCreated
    ? ["worktree", "add", "-b", input.branch, path, input.startPointHead]
    : ["worktree", "add", path, input.branch];
  const result = await deps.runGit(repository.path, args);
  if (result.code !== 0) throw gitError(repository.path, args, result);
  await verifyManagedWorktree(repository, path, deps);
  return { path, branchCreated };
}

export async function verifyManagedWorktree(
  repository: ResolvedRepository,
  path: string,
  deps: ManagedWorktreeDependencies,
): Promise<RegisteredWorktree> {
  const logical = resolve(path);
  if (!isManagedPath(repository, logical))
    throw new Error(`invalid managed path ${path}`);
  const entry = await lstat(logical).catch((error) => {
    throw new Error(`invalid managed path ${path}: ${errorMessage(error)}`);
  });
  if (entry.isSymbolicLink())
    throw new Error(`invalid managed path ${path}: leaf is a symbolic link`);
  if (!entry.isDirectory())
    throw new Error(`invalid managed path ${path}: leaf is not a directory`);

  const canonicalize = deps.realpath ?? nodeRealpath;
  const [canonicalPath, canonicalParent] = await Promise.all([
    canonicalize(logical),
    canonicalize(dirname(logical)),
  ]);
  if (canonicalPath !== join(canonicalParent, basename(logical))) {
    throw new Error(
      `invalid managed path ${path}: leaf resolves to ${canonicalPath}`,
    );
  }
  const expectedPoolDir = await canonicalize(repository.poolDir);
  if (canonicalParent !== expectedPoolDir)
    throw new Error(
      `invalid managed path ${path}: parent is outside repository pool`,
    );

  const commonArgs = [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ];
  const common = await deps.runGit(logical, commonArgs);
  if (common.code !== 0) throw gitError(logical, commonArgs, common);
  const [actualCommon, expectedCommon] = await Promise.all([
    canonicalize(common.stdout.trim()),
    canonicalize(repository.commonDir),
  ]);
  if (actualCommon !== expectedCommon)
    throw new Error(
      `invalid managed path ${path}: Git common directory does not match repository`,
    );

  const worktrees = await inspectRepository(repository, deps.runGit);
  const matches: RegisteredWorktree[] = [];
  for (const worktree of worktrees) {
    const candidate = await canonicalize(worktree.path).catch(() =>
      resolve(worktree.path),
    );
    if (candidate === canonicalPath) matches.push(worktree);
  }
  if (
    matches.length !== 1 ||
    !matches[0].valid ||
    matches[0].prunableReason !== undefined
  ) {
    throw new Error(
      `invalid managed path ${path}: expected one exact valid registration, found ${matches.length}`,
    );
  }
  return matches[0];
}

export async function removeManagedWorktree(
  repository: ResolvedRepository,
  path: string,
  deps: ManagedWorktreeDependencies,
): Promise<void> {
  await verifyManagedWorktree(repository, path, deps);
  const args = ["worktree", "remove", path];
  const result = await deps.runGit(repository.path, args);
  if (result.code !== 0) throw gitError(repository.path, args, result);
}

async function ensurePoolHierarchy(
  repository: ResolvedRepository,
  deps: ManagedWorktreeDependencies,
): Promise<void> {
  const canonicalize = deps.realpath ?? nodeRealpath;
  await ensurePlainDirectory(repository.poolRoot);
  const canonicalRoot = await canonicalize(repository.poolRoot);
  const markerPath = join(repository.poolRoot, MARKER_NAME);
  const expected: PoolRootMarker = {
    version: 2,
    root: repository.poolRoot,
    layout: "ephemeral",
  };
  let marker = await readPoolMarker(markerPath);
  if (marker === undefined) {
    try {
      await writeFile(markerPath, `${JSON.stringify(expected, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      marker = expected;
    } catch (writeError) {
      if (!hasCode(writeError, "EEXIST"))
        throw new Error(
          `could not create pool root marker ${markerPath}: ${errorMessage(writeError)}`,
        );
      marker = await readPoolMarker(markerPath);
      if (marker === undefined)
        throw new Error(
          `invalid pool root marker ${markerPath}: disappeared during creation`,
        );
    }
  }
  if (!isExactMarker(marker, expected)) {
    throw new Error(
      `invalid pool root marker ${markerPath}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(marker)}`,
    );
  }

  let current = repository.poolRoot;
  const relativePool = relative(repository.poolRoot, repository.poolDir);
  if (
    relativePool === "" ||
    isAbsolute(relativePool) ||
    relativePool === ".." ||
    relativePool.startsWith("../")
  ) {
    throw new Error(`invalid repository pool directory ${repository.poolDir}`);
  }
  for (const component of relativePool.split("/")) {
    current = join(current, component);
    await ensurePlainDirectory(current);
    const canonical = await canonicalize(current);
    const expectedPath = join(
      canonicalRoot,
      ...relative(repository.poolRoot, current).split("/"),
    );
    if (canonical !== expectedPath)
      throw new Error(
        `invalid repository pool directory ${current}: resolves outside pool root`,
      );
  }
}

async function readPoolMarker(path: string): Promise<unknown | undefined> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error(`invalid pool root marker ${path}: ${errorMessage(error)}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(
      `invalid pool root marker ${path}: must be a plain regular file`,
    );
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid pool root marker ${path}: ${errorMessage(error)}`);
  }
}

async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(
      `invalid pool directory ${path}: must be a plain directory`,
    );
}

async function requireAbsentLeaf(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink())
      throw new Error(`managed worktree path ${path} is a symbolic link`);
    throw new Error(`managed worktree path ${path} already exists`);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}

async function verifyCommonDirectory(
  repository: ResolvedRepository,
  deps: ManagedWorktreeDependencies,
): Promise<void> {
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const result = await deps.runGit(repository.path, args);
  if (result.code !== 0) throw gitError(repository.path, args, result);
  const canonicalize = deps.realpath ?? nodeRealpath;
  const [configured, reported] = await Promise.all([
    canonicalize(repository.commonDir),
    canonicalize(result.stdout.trim()),
  ]);
  if (configured !== reported)
    throw new Error(
      `configured Git common directory does not match repository ${repository.path}`,
    );
}

async function validateBranch(
  repository: ResolvedRepository,
  branch: string,
  runGit: GitRunner,
): Promise<void> {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.startsWith("-") ||
    branch.includes("\0")
  ) {
    throw new Error(`invalid branch ${JSON.stringify(branch)}`);
  }
  const result = await runGit(repository.path, [
    "check-ref-format",
    "--branch",
    branch,
  ]);
  if (result.code !== 0)
    throw new Error(`invalid branch ${JSON.stringify(branch)}`);
}

async function validateRevision(
  repository: ResolvedRepository,
  revision: string,
  runGit: GitRunner,
): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(revision))
    throw new Error(`invalid start point HEAD ${JSON.stringify(revision)}`);
  const args = ["rev-parse", "--verify", `${revision}^{commit}`];
  const result = await runGit(repository.path, args);
  if (result.code !== 0) throw gitError(repository.path, args, result);
}

function isManagedPath(repository: ResolvedRepository, path: string): boolean {
  return (
    dirname(path) === resolve(repository.poolDir) &&
    MANAGED_NAME_PATTERN.test(basename(path))
  );
}

function isExactMarker(value: unknown, expected: PoolRootMarker): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const object = value as Record<string, unknown>;
  return (
    Object.keys(object).sort().join(",") === "layout,root,version" &&
    object.version === expected.version &&
    object.root === expected.root &&
    object.layout === expected.layout
  );
}

function gitError(
  cwd: string,
  args: string[],
  result: { stdout: string; stderr: string },
): Error {
  const detail =
    result.stderr.trim() || result.stdout.trim() || "git command failed";
  return new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
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
