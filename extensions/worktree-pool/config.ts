import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { isValidPoolCapacity, POOL_CAPACITY_REQUIREMENT } from "./capacity.js";
import type {
  GitRunner,
  LoadedPoolConfig,
  PoolConfigV2,
  Realpath,
  ResolvedRepository,
} from "./types.js";

const TOP_LEVEL_FIELDS = new Set([
  "version",
  "root",
  "repositoryRoot",
  "defaultCapacity",
  "exclude",
  "repositories",
]);
const REPOSITORY_FIELDS = new Set(["name", "capacity", "defaultStartPoint"]);

export async function loadPoolConfig(
  path: string,
  deps: { home: string; runGit: GitRunner; realpath: Realpath },
): Promise<LoadedPoolConfig> {
  const parsed = validateTopLevelConfig(
    path,
    parseConfig(path, await readConfigFile(path)),
  );
  const root = resolveLogicalPath(parsed.root, deps.home);
  const repositoryRoot = resolveLogicalPath(parsed.repositoryRoot, deps.home);
  let canonicalRoot: string;
  try {
    canonicalRoot = await canonicalizePotentialPath(root, deps.realpath);
  } catch (error) {
    throw invalidConfig(
      path,
      "root",
      parsed.root,
      `could not resolve path: ${errorMessage(error)}`,
    );
  }
  let canonicalRepositoryRoot: string;
  try {
    canonicalRepositoryRoot = await deps.realpath(repositoryRoot);
  } catch (error) {
    throw invalidConfig(
      path,
      "repositoryRoot",
      parsed.repositoryRoot,
      `could not resolve path: ${errorMessage(error)}`,
    );
  }
  if (root === repositoryRoot) {
    throw invalidConfig(
      path,
      "root",
      parsed.root,
      "must be distinct from repositoryRoot",
    );
  }
  return {
    root,
    canonicalRoot,
    repositoryRoot,
    canonicalRepositoryRoot,
    defaultCapacity: parsed.defaultCapacity,
    exclude: parsed.exclude,
    overrides: new Map(
      parsed.repositories.map((repository) => [
        repository.name,
        {
          capacity: repository.capacity ?? parsed.defaultCapacity,
          ...(repository.defaultStartPoint === undefined
            ? {}
            : { defaultStartPoint: repository.defaultStartPoint }),
        },
      ]),
    ),
  };
}

export async function resolveRepository(
  config: LoadedPoolConfig,
  identifier: string,
  purpose: "identity" | "acquire",
  deps: { runGit: GitRunner; realpath: Realpath },
): Promise<ResolvedRepository> {
  const name = normalizeIdentifier(identifier);
  if (config.exclude.includes(name))
    throw repositoryError(
      name,
      resolve(config.repositoryRoot, name),
      "identifier is excluded",
    );
  const path = resolve(config.repositoryRoot, name);
  if (path === config.root)
    throw repositoryError(name, path, "identifier targets the pool root");
  if (!pathContains(config.repositoryRoot, path))
    throw repositoryError(name, path, "identifier escapes repository root");

  let canonicalPath: string;
  try {
    canonicalPath = await deps.realpath(path);
  } catch (error) {
    throw repositoryError(
      name,
      path,
      `could not resolve repository path: ${errorMessage(error)}`,
    );
  }
  const expectedCanonicalPath = resolve(config.canonicalRepositoryRoot, name);
  if (
    canonicalPath !== expectedCanonicalPath ||
    !pathContains(config.canonicalRepositoryRoot, canonicalPath)
  ) {
    throw repositoryError(
      name,
      path,
      `canonical path ${canonicalPath} is not the corresponding primary checkout path ${expectedCanonicalPath}`,
    );
  }
  if (
    pathsOverlap(config.root, path) ||
    pathsOverlap(config.canonicalRoot, canonicalPath)
  ) {
    throw repositoryError(
      name,
      path,
      "repository must be outside the pool root",
    );
  }

  const identity = await resolveGitIdentity(name, path, deps);
  if (identity.canonicalRoot !== canonicalPath) {
    throw repositoryError(
      name,
      path,
      `must resolve to the exact Git worktree root, found ${identity.canonicalRoot}`,
    );
  }
  const expectedCommonDir = resolve(canonicalPath, ".git");
  if (identity.commonDir !== expectedCommonDir) {
    throw repositoryError(
      name,
      path,
      `must be the primary checkout for Git common directory ${identity.commonDir}`,
    );
  }

  const override = config.overrides.get(name);
  let defaultStartPoint = override?.defaultStartPoint;
  if (purpose === "acquire" && defaultStartPoint === undefined) {
    defaultStartPoint = await resolveRemoteHead(name, path, deps.runGit);
  }
  return {
    name,
    path,
    canonicalPath,
    commonDir: identity.commonDir,
    poolRoot: config.root,
    poolDir: resolve(config.root, name),
    capacity: override?.capacity ?? config.defaultCapacity,
    ...(defaultStartPoint === undefined ? {} : { defaultStartPoint }),
  };
}

function normalizeIdentifier(identifier: string): string {
  if (
    typeof identifier !== "string" ||
    identifier.length === 0 ||
    isAbsolute(identifier)
  ) {
    throw new Error(
      `invalid repository identifier ${JSON.stringify(identifier)}: must be a non-empty relative path`,
    );
  }
  const parts = identifier.split("/");
  if (parts.some((part) => !isSafePathComponent(part))) {
    throw new Error(
      `invalid repository identifier ${JSON.stringify(identifier)}: every component must be safe and must not be empty, . or ..`,
    );
  }
  return parts.join("/");
}

async function resolveGitIdentity(
  identifier: string,
  path: string,
  deps: { runGit: GitRunner; realpath: Realpath },
): Promise<{ canonicalRoot: string; commonDir: string }> {
  const args = [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ];
  const result = await deps.runGit(path, args);
  if (result.code !== 0) throw gitError(identifier, path, args, result);
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 2 || lines.some((line) => !isAbsolute(line))) {
    throw repositoryError(
      identifier,
      path,
      `git ${args.join(" ")} returned invalid output ${JSON.stringify(result.stdout.trim())}`,
    );
  }
  try {
    const [canonicalRoot, commonDir] = await Promise.all([
      deps.realpath(lines[0]),
      deps.realpath(lines[1]),
    ]);
    return { canonicalRoot, commonDir };
  } catch (error) {
    throw repositoryError(
      identifier,
      path,
      `could not canonicalize Git identity: ${errorMessage(error)}`,
    );
  }
}

async function resolveRemoteHead(
  identifier: string,
  path: string,
  runGit: GitRunner,
): Promise<string> {
  const symbolicArgs = ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"];
  const symbolic = await runGit(path, symbolicArgs);
  if (symbolic.code === 0) {
    const ref = validateRemoteHeadRef(
      identifier,
      path,
      symbolicArgs,
      symbolic.stdout.trim(),
    );
    await ensureRemoteHeadTarget(identifier, path, ref, runGit);
    return ref;
  }

  const discoverArgs = ["ls-remote", "--symref", "origin", "HEAD"];
  const discovered = await runGit(path, discoverArgs);
  if (discovered.code !== 0)
    throw gitError(identifier, path, discoverArgs, discovered);
  const match = discovered.stdout
    .split(/\r?\n/)
    .map((line) =>
      line.match(/^ref:\s+(refs\/heads\/[A-Za-z0-9._/-]+)\s+HEAD$/),
    )
    .find((candidate) => candidate !== null);
  if (!match) {
    throw repositoryError(
      identifier,
      path,
      `git ${discoverArgs.join(" ")} returned no symbolic HEAD in ${JSON.stringify(discovered.stdout.trim())}`,
    );
  }
  const ref = validateRemoteHeadRef(
    identifier,
    path,
    discoverArgs,
    `refs/remotes/origin/${match[1].slice("refs/heads/".length)}`,
  );
  await ensureRemoteHeadTarget(identifier, path, ref, runGit);
  const restoreArgs = ["symbolic-ref", "refs/remotes/origin/HEAD", ref];
  const restored = await runGit(path, restoreArgs);
  if (restored.code !== 0)
    throw gitError(identifier, path, restoreArgs, restored);
  return ref;
}

function validateRemoteHeadRef(
  identifier: string,
  path: string,
  args: string[],
  ref: string,
): string {
  if (
    !/^refs\/remotes\/origin\/[A-Za-z0-9._/-]+$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//")
  ) {
    throw repositoryError(
      identifier,
      path,
      `git ${args.join(" ")} returned malformed ref ${JSON.stringify(ref)}`,
    );
  }
  return ref;
}

async function ensureRemoteHeadTarget(
  identifier: string,
  path: string,
  ref: string,
  runGit: GitRunner,
): Promise<void> {
  const verifyArgs = [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ];
  if ((await runGit(path, verifyArgs)).code === 0) return;

  const branch = ref.slice("refs/remotes/origin/".length);
  const fetchArgs = [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${branch}:${ref}`,
  ];
  const fetched = await runGit(path, fetchArgs);
  if (fetched.code !== 0) throw gitError(identifier, path, fetchArgs, fetched);
  const verified = await runGit(path, verifyArgs);
  if (verified.code !== 0)
    throw gitError(identifier, path, verifyArgs, verified);
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path} could not be read: ${errorMessage(error)}`);
  }
}
function parseConfig(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} contains invalid JSON: ${errorMessage(error)}`);
  }
}
function validateTopLevelConfig(path: string, value: unknown): PoolConfigV2 {
  if (!isRecord(value))
    throw invalidConfig(path, "config", value, "must be a JSON object");
  rejectUnknownFields(path, value, TOP_LEVEL_FIELDS);
  if (value.version !== 2)
    throw invalidConfig(path, "version", value.version, "must equal 2");
  const root = requireString(path, "root", value.root);
  const repositoryRoot = requireString(
    path,
    "repositoryRoot",
    value.repositoryRoot,
  );
  const defaultCapacity = requireCapacity(
    path,
    "defaultCapacity",
    value.defaultCapacity,
  );
  if (!Array.isArray(value.exclude))
    throw invalidConfig(path, "exclude", value.exclude, "must be an array");
  const exclude = value.exclude.map((entry, index) => {
    const text = requireString(path, `exclude[${index}]`, entry);
    try {
      return normalizeIdentifier(text);
    } catch (error) {
      throw invalidConfig(
        path,
        `exclude[${index}]`,
        entry,
        errorMessage(error),
      );
    }
  });
  if (!Array.isArray(value.repositories))
    throw invalidConfig(
      path,
      "repositories",
      value.repositories,
      "must be an array",
    );
  const seen = new Set<string>();
  const repositories = value.repositories.map((entry, index) => {
    const field = `repositories[${index}]`;
    if (!isRecord(entry))
      throw invalidConfig(path, field, entry, "must be an object");
    rejectUnknownFields(path, entry, REPOSITORY_FIELDS, field);
    const rawName = requireString(path, `${field}.name`, entry.name);
    let name: string;
    try {
      name = normalizeIdentifier(rawName);
    } catch (error) {
      throw invalidConfig(path, `${field}.name`, rawName, errorMessage(error));
    }
    if (seen.has(name))
      throw invalidConfig(path, `${field}.name`, name, "must be unique");
    seen.add(name);
    const capacity =
      entry.capacity === undefined
        ? undefined
        : requireCapacity(path, `${field}.capacity`, entry.capacity);
    const defaultStartPoint =
      entry.defaultStartPoint === undefined
        ? undefined
        : requireString(
            path,
            `${field}.defaultStartPoint`,
            entry.defaultStartPoint,
          );
    return {
      name,
      ...(capacity === undefined ? {} : { capacity }),
      ...(defaultStartPoint === undefined ? {} : { defaultStartPoint }),
    };
  });
  return {
    version: 2,
    root,
    repositoryRoot,
    defaultCapacity,
    exclude,
    repositories,
  };
}
function rejectUnknownFields(
  path: string,
  value: Record<string, unknown>,
  allowed: Set<string>,
  prefix?: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw invalidConfig(
        path,
        prefix ? `${prefix}.${key}` : key,
        value[key],
        "unknown field",
      );
}
function requireString(path: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalidConfig(path, field, value, "must be a non-empty string");
  return value;
}
function requireCapacity(path: string, field: string, value: unknown): number {
  if (!isValidPoolCapacity(value)) {
    throw invalidConfig(path, field, value, POOL_CAPACITY_REQUIREMENT);
  }
  return value;
}
function isSafePathComponent(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}
function resolveLogicalPath(path: string, home: string): string {
  return path === "~"
    ? resolve(home)
    : path.startsWith("~/")
      ? resolve(home, path.slice(2))
      : resolve(path);
}
async function canonicalizePotentialPath(
  path: string,
  realpath: Realpath,
): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(
      await canonicalizePotentialPath(parent, realpath),
      basename(path),
    );
  }
}
function pathContains(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  return rel === "" || (!isParentTraversal(rel) && !isAbsolute(rel));
}
function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}
function isParentTraversal(path: string): boolean {
  return path === ".." || path.startsWith("../");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalidConfig(
  path: string,
  field: string,
  value: unknown,
  detail: string,
): Error {
  return new Error(
    `${path} invalid ${field} (${JSON.stringify(value)}): ${detail}`,
  );
}
function repositoryError(
  identifier: string,
  path: string,
  detail: string,
): Error {
  return new Error(
    `repository ${JSON.stringify(identifier)} at ${path}: ${detail}`,
  );
}
function gitError(
  identifier: string,
  path: string,
  args: string[],
  result: { stdout: string; stderr: string },
): Error {
  return repositoryError(
    identifier,
    path,
    `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "git command failed"}`,
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
