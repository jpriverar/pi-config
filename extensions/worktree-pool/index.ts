import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir, hostname as readHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePoolCommand } from "./command-policy.js";
import { loadPoolConfig, resolveRepository } from "./config.js";
import type { OwnerIdentity } from "./operation-lock.js";
import { WorktreePool } from "./pool.js";
import type { GitResult, ResolvedRepository } from "./types.js";

const ACTIONS = ["list", "acquire", "release", "repair"] as const;
type PoolAction = (typeof ACTIONS)[number];
type PoolParameters = {
  action: PoolAction;
  repository?: string;
  branch?: string;
  startPoint?: string;
  claimId?: string;
  slot?: string;
};

type ExtensionContext = {
  cwd: string;
  sessionManager: { getSessionId(): string };
};
type ToolCallEvent = { toolName?: string; input?: unknown };
type ExtensionAPI = {
  on(
    name: string,
    handler: (event: any, ctx: ExtensionContext) => unknown,
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      id: string,
      params: PoolParameters,
      signal: unknown,
      update: unknown,
      ctx: ExtensionContext,
    ): Promise<unknown>;
  }): void;
};

export type WorktreePoolRuntime = {
  root: string;
  pool: WorktreePool;
  repositories: ResolvedRepository[];
};
export type WorktreePoolExtensionDependencies = {
  now(): number;
  pid: number;
  hostname: string;
  loadRuntime(
    repositoryIdentifiers: string[],
    purpose?: "identity" | "acquire",
  ): Promise<WorktreePoolRuntime>;
};

const toolParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ACTIONS },
    repository: {
      type: "string",
      description: "Repository name or safe relative path beneath ~/dd.",
    },
    branch: { type: "string", description: "Branch to acquire." },
    startPoint: {
      type: "string",
      description:
        "Optional start point. Recognized remote-tracking refs are fetched before acquisition.",
    },
    claimId: {
      type: "string",
      description: "Opaque claim ID returned by acquire.",
    },
    slot: {
      type: "string",
      description: "Managed path or claim ID to repair.",
    },
  },
  required: ["action"],
} as const;

export function createWorktreePoolExtension(
  deps: WorktreePoolExtensionDependencies,
) {
  return function worktreePoolExtension(pi: ExtensionAPI): void {
    const ownerFor = (ctx: ExtensionContext): OwnerIdentity => ({
      pid: deps.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      host: deps.hostname,
      started: deps.now(),
    });

    pi.registerTool({
      name: "worktree_pool",
      label: "Worktree pool",
      description:
        "List, acquire, release, or non-destructively repair machine-wide bounded ephemeral worktrees.",
      parameters: toolParameters,
      async execute(_id, params, _signal, _update, ctx) {
        validateActionParameters(params);
        const purpose = params.action === "acquire" ? "acquire" : "identity";
        const repositories =
          params.repository === undefined ? [] : [params.repository];
        const runtime = await deps.loadRuntime(repositories, purpose);
        const owner = ownerFor(ctx);

        if (params.action === "list") {
          const listing = await runtime.pool.list(params.repository);
          return result(`Pool listing: ${summarizeListing(listing)}`, {
            action: "list",
            ...listing,
          });
        }
        if (params.action === "acquire") {
          const acquired = await runtime.pool.acquire(
            {
              repository: params.repository!,
              branch: params.branch!,
              ...(params.startPoint === undefined || params.startPoint === ""
                ? {}
                : { startPoint: params.startPoint }),
            },
            owner,
          );
          return result(
            `${acquired.reused ? "Reused" : "Acquired"} ${acquired.path} on ${acquired.branch} ` +
              `(HEAD ${acquired.head}; ${acquired.relationship} ${acquired.startPoint} at ${acquired.startPointHead} ` +
              `[${acquired.startPointFetched ? "fetched" : "local"}]; claim ${acquired.claimId}).`,
            { action: "acquire", ...acquired },
          );
        }
        if (params.action === "release") {
          const released = await runtime.pool.release(
            params.repository!,
            params.claimId!,
            owner,
          );
          return result(
            released.released
              ? `Released ${released.path}.`
              : `Claim ${params.claimId} was not released.`,
            { action: "release", ...released },
          );
        }

        const report = await runtime.pool.repair(
          params.repository!,
          params.slot!,
          owner,
        );
        return result(
          `${report.repaired ? "Repaired" : "Inspected"} ${report.path}: ${report.state}${report.reason ? ` (${report.reason})` : ""}.`,
          { action: "repair", ...report },
        );
      },
    });

    pi.on("tool_call", async (event: ToolCallEvent) => {
      if (
        event.toolName !== "bash" ||
        !isRecord(event.input) ||
        typeof event.input.command !== "string"
      )
        return undefined;
      const decision = evaluatePoolCommand(
        event.input.command,
        subagentDepth(),
      );
      return decision.allowed
        ? undefined
        : { block: true, reason: decision.reason };
    });
  };
}

function validateActionParameters(params: PoolParameters): void {
  if (!ACTIONS.includes(params.action))
    throw new Error(
      `unknown worktree_pool action ${JSON.stringify(params.action)}`,
    );
  if (params.action !== "list" || params.repository !== undefined)
    requireText(params.repository, `${params.action}.repository`);
  if (params.action === "acquire") requireText(params.branch, "acquire.branch");
  if (params.action === "release")
    requireText(params.claimId, "release.claimId");
  if (params.action === "repair") requireText(params.slot, "repair.slot");
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`worktree_pool ${field} must be a non-empty string`);
}

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function summarizeListing(listing: {
  repositories: Array<{ name: string; worktrees: Array<{ state: string }> }>;
}): string {
  if (listing.repositories.length === 0) return "no configured repositories";
  return listing.repositories
    .map((repository) => {
      const states =
        repository.worktrees.map((worktree) => worktree.state).join(", ") ||
        "no managed worktrees";
      return `${repository.name}: ${states}`;
    })
    .join("; ");
}

function subagentDepth(): number {
  const value = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function poolGitArguments(cwd: string, args: string[]): string[] {
  return ["-C", cwd, "-c", "core.fsmonitor=false", ...args];
}

const runGit = (cwd: string, args: string[]) =>
  run("git", poolGitArguments(cwd, args));

const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "config.json",
);
const productionDependencies: WorktreePoolExtensionDependencies = {
  now: Date.now,
  pid: process.pid,
  hostname: readHostname(),
  async loadRuntime(repositoryIdentifiers, purpose = "identity") {
    const config = await loadPoolConfig(CONFIG_PATH, {
      home: homedir(),
      runGit,
      realpath,
    });
    const identifiers =
      repositoryIdentifiers.length === 0
        ? [...config.overrides.keys()]
        : repositoryIdentifiers;
    const repositories = await Promise.all(
      [...new Set(identifiers)].map((identifier) =>
        resolveRepository(config, identifier, purpose, { runGit, realpath }),
      ),
    );
    return {
      root: config.root,
      repositories,
      pool: new WorktreePool({
        repositories,
        runGit,
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
      }),
    };
  },
};

export default createWorktreePoolExtension(productionDependencies);
