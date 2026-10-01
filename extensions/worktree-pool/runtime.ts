import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir, hostname as readHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPoolConfig, resolveRepository } from "./config.js";
import type {
  OperationLockDependencies,
  OwnerIdentity,
} from "./operation-lock.js";
import { WorktreePool } from "./pool.js";
import type {
  GitResult,
  GitRunner,
  LoadedPoolConfig,
  Realpath,
  ResolvedRepository,
} from "./types.js";

export interface WorktreePoolRuntime {
  root: string;
  pool: WorktreePool;
  repositories: ResolvedRepository[];
}

export interface WorktreePoolRuntimeDependencies {
  configPath: string;
  home: string;
  runGit: GitRunner;
  realpath: Realpath;
  operationLock: OperationLockDependencies;
  uuid(): string;
  loadConfig?: (
    path: string,
    dependencies: { home: string; runGit: GitRunner; realpath: Realpath },
  ) => Promise<LoadedPoolConfig>;
  resolveRepository?: (
    config: LoadedPoolConfig,
    identifier: string,
    purpose: "identity" | "acquire",
    dependencies: { runGit: GitRunner; realpath: Realpath },
  ) => Promise<ResolvedRepository>;
}

export type CurrentOwnerDependencies = {
  pid: number;
  hostname: string;
  now(): number;
};

export async function loadWorktreePoolRuntime(
  repositoryIdentifiers: string[],
  purpose: "identity" | "acquire",
  dependencies: WorktreePoolRuntimeDependencies = productionRuntimeDependencies,
): Promise<WorktreePoolRuntime> {
  const config = await (dependencies.loadConfig ?? loadPoolConfig)(
    dependencies.configPath,
    {
      home: dependencies.home,
      runGit: dependencies.runGit,
      realpath: dependencies.realpath,
    },
  );
  const identifiers =
    repositoryIdentifiers.length === 0
      ? [...config.overrides.keys()]
      : repositoryIdentifiers;
  const resolveConfiguredRepository =
    dependencies.resolveRepository ?? resolveRepository;
  const repositories = await Promise.all(
    [...new Set(identifiers)].map((identifier) =>
      resolveConfiguredRepository(config, identifier, purpose, {
        runGit: dependencies.runGit,
        realpath: dependencies.realpath,
      }),
    ),
  );
  return {
    root: config.root,
    repositories,
    pool: new WorktreePool({
      repositories,
      runGit: dependencies.runGit,
      operationLock: dependencies.operationLock,
      uuid: dependencies.uuid,
    }),
  };
}

export function currentOwner(
  sessionId: string,
  dependencies: CurrentOwnerDependencies = productionOwnerDependencies,
): OwnerIdentity {
  return {
    pid: dependencies.pid,
    sessionId,
    host: dependencies.hostname,
    started: dependencies.now(),
  };
}

export function poolGitArguments(cwd: string, args: string[]): string[] {
  return ["-C", cwd, "-c", "core.fsmonitor=false", ...args];
}

function operationLockPidLiveness(pid: number): "live" | "dead" | "ambiguous" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (code === "EPERM") return "live";
    if (code === "ESRCH") return "dead";
    return "ambiguous";
  }
}

async function run(command: string, args: string[]): Promise<GitResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const runGit = (cwd: string, args: string[]) =>
  run("git", poolGitArguments(cwd, args));

const productionOwnerDependencies: CurrentOwnerDependencies = {
  pid: process.pid,
  hostname: readHostname(),
  now: Date.now,
};

const productionRuntimeDependencies: WorktreePoolRuntimeDependencies = {
  configPath: join(dirname(fileURLToPath(import.meta.url)), "config.json"),
  home: homedir(),
  runGit,
  realpath,
  operationLock: {
    now: Date.now,
    sleep: async (milliseconds) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
    isPidAlive: operationLockPidLiveness,
    hostname: readHostname(),
    timeoutMs: 5_000,
  },
  uuid: randomUUID,
};
