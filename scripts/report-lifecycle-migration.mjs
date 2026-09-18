#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACTIVE_STATUSES = "open,in_progress,blocked,deferred,closed";
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;
const REPORT_KEYS = [
  "legacy_actionable",
  "dependency_waiting",
  "manually_blocked",
  "stale_in_progress",
  "deferred",
  "done",
  "retained_resource_candidates",
];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} issue */
function lifecycleOf(issue) {
  if (!isRecord(issue.metadata)) return undefined;
  const lifecycle = issue.metadata.piLifecycle;
  return isRecord(lifecycle) && lifecycle.version === 1 ? lifecycle : undefined;
}

/** @param {Record<string, unknown>} issue */
function unresolvedNativeBlocker(issue) {
  if (!Array.isArray(issue.dependencies)) return false;
  return issue.dependencies.some((dependency) => {
    if (!isRecord(dependency)) return false;
    const type = dependency.dependency_type ?? dependency.type;
    return type === "blocks" && dependency.status !== "closed";
  });
}

/**
 * @param {Record<string, unknown> | undefined} lifecycle
 * @param {Set<string>} poolClaimIds
 */
function hasRetainedResource(lifecycle, poolClaimIds) {
  if (!Array.isArray(lifecycle?.resources)) return false;
  return lifecycle.resources.some((resource) => {
    if (!isRecord(resource) || resource.cleanupState === "released") {
      return false;
    }
    return (
      typeof resource.claimId === "string" &&
      (poolClaimIds.size === 0 || poolClaimIds.has(resource.claimId))
    );
  });
}

/**
 * @param {unknown[]} issues
 * @param {(issue: Record<string, unknown>) => boolean} predicate
 */
function sortedIds(issues, predicate) {
  const records = issues
    .filter(isRecord)
    .filter((issue) => typeof issue.id === "string");
  return records
    .filter(predicate)
    .map((issue) => /** @type {string} */ (issue.id))
    .sort();
}

/**
 * @param {unknown[]} issues
 * @param {Set<string>} readyIds
 * @param {Set<string>} poolClaimIds
 * @param {number} now
 */
export function classifyMigrationCandidates(
  issues,
  readyIds,
  poolClaimIds,
  now = Date.now(),
) {
  const lifecycle = lifecycleOf;
  return {
    legacy_actionable: sortedIds(
      issues,
      (issue) =>
        lifecycle(issue) === undefined &&
        issue.status === "open" &&
        readyIds.has(/** @type {string} */ (issue.id)),
    ),
    dependency_waiting: sortedIds(issues, (issue) => {
      const state = lifecycle(issue);
      return (
        (state?.phase === "waiting" &&
          isRecord(state.waiting) &&
          state.waiting.kind === "dependency") ||
        (issue.status === "open" && unresolvedNativeBlocker(issue))
      );
    }),
    manually_blocked: sortedIds(
      issues,
      (issue) => lifecycle(issue) === undefined && issue.status === "blocked",
    ),
    stale_in_progress: sortedIds(issues, (issue) => {
      if (issue.status !== "in_progress") return false;
      const state = lifecycle(issue);
      const timestamp =
        typeof state?.lastProgressAt === "string"
          ? state.lastProgressAt
          : issue.updated_at;
      return (
        typeof timestamp === "string" &&
        Number.isFinite(Date.parse(timestamp)) &&
        now - Date.parse(timestamp) > STALE_AFTER_MS
      );
    }),
    deferred: sortedIds(issues, (issue) => issue.status === "deferred"),
    done: sortedIds(issues, (issue) => issue.status === "closed"),
    retained_resource_candidates: sortedIds(issues, (issue) =>
      hasRetainedResource(lifecycle(issue), poolClaimIds),
    ),
  };
}

/** @param {Record<string, string[]>} report */
export function formatMigrationReport(report) {
  return [
    "Task lifecycle migration report (read-only)",
    ...REPORT_KEYS.map((key) => {
      const ids = report[key] ?? [];
      return `${key} count=${ids.length} ids=${ids.length === 0 ? "-" : ids.join(",")}`;
    }),
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--db" && flag !== "--pool-config") || !value) {
      throw new Error(
        "usage: report-lifecycle-migration.mjs [--db PATH] [--pool-config PATH]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

/** @param {string} command @param {string[]} args @param {string} cwd @returns {unknown} */
function runJson(command, args, cwd) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${command} read failed`);
  }
}

/** @param {string} value */
function resolveHomePath(value) {
  return value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? join(homedir(), value.slice(2))
      : resolve(value);
}

/** @param {string} configPath @returns {Set<string>} */
function readPoolClaimIds(configPath) {
  /** @type {unknown} */
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error(`pool config read failed: ${configPath}`);
  }
  if (
    !isRecord(config) ||
    typeof config.repositoryRoot !== "string" ||
    !Array.isArray(config.repositories)
  ) {
    throw new Error(`pool config is invalid: ${configPath}`);
  }
  const repositoryRoot = resolveHomePath(config.repositoryRoot);
  const claims = new Set();
  for (const repository of config.repositories) {
    if (!isRecord(repository) || typeof repository.name !== "string") continue;
    let porcelain;
    try {
      porcelain = execFileSync(
        "git",
        [
          "-C",
          join(repositoryRoot, repository.name),
          "-c",
          "core.fsmonitor=false",
          "worktree",
          "list",
          "--porcelain",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      throw new Error(`pool listing failed for ${repository.name}`);
    }
    for (const match of porcelain.matchAll(
      /(?:^|\n)locked pi-pool\/v2 claim=([^ ]+)/g,
    )) {
      claims.add(match[1]);
    }
  }
  return claims;
}

function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const root = dirname(fileURLToPath(import.meta.url));
  const db = resolve(
    arguments_.db ??
      process.env.BEADS_DIR ??
      join(homedir(), "beads", ".beads"),
  );
  const poolConfig = resolve(
    arguments_["pool-config"] ??
      join(root, "..", "extensions", "worktree-pool", "config.json"),
  );
  const issues = runJson(
    "bd",
    ["list", "-s", ACTIVE_STATUSES, "-n", "0", "--json", "--db", db],
    root,
  );
  const ready = runJson("bd", ["ready", "--json", "--db", db], root);
  if (!Array.isArray(issues) || !Array.isArray(ready)) {
    throw new Error("bd read returned an invalid response");
  }
  const report = classifyMigrationCandidates(
    issues,
    new Set(
      ready
        .filter((issue) => isRecord(issue) && typeof issue.id === "string")
        .map((issue) => issue.id),
    ),
    readPoolClaimIds(poolConfig),
  );
  console.log(formatMigrationReport(report));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "report failed");
    process.exitCode = 1;
  }
}
