import { hostname as readHostname } from "node:os";
import {
  allocateWithHooks,
  registerAllocationCapability,
  type AllocationEventBus,
} from "./allocation-hook.js";

import type { PoolListing } from "./pool.js";
import { evaluatePoolCommand } from "./command-policy.js";
import {
  currentOwner,
  loadWorktreePoolRuntime,
  type WorktreePoolRuntime,
} from "./runtime.js";

export { poolGitArguments } from "./runtime.js";
export type { WorktreePoolRuntime } from "./runtime.js";

const ACTIONS = ["list", "acquire", "release", "repair"] as const;
type PoolAction = (typeof ACTIONS)[number];
type PoolParameters = {
  repository?: string;
  branch?: string;
  startPoint?: string;
  claimId?: string;
  slot?: string;
  force?: boolean;
};

const ACTION_FIELDS = {
  list: ["repository"],
  acquire: ["repository", "branch", "startPoint"],
  release: ["repository", "claimId", "force"],
  repair: ["repository", "slot"],
} as const;
const REQUIRED_FIELDS = {
  list: [],
  acquire: ["repository", "branch"],
  release: ["repository", "claimId"],
  repair: ["repository", "slot"],
} as const;
const DESCRIPTIONS: Record<PoolAction, string> = {
  list: "Inspect bounded ephemeral worktree pools, including claim IDs, paths, owners, capacity and observed blockers. Omit repository to list all configured repositories. Does not release or repair anything.",
  acquire:
    "Acquire an isolated ephemeral worktree on a branch. Returns its claim ID and exact worktree_release call. Repository and branch are required. One writer per worktree; release explicitly when work is durable and no child uses it.",
  release:
    "Release one exact managed worktree claim. Required: repository and claimId from worktree_acquire or worktree_list, NOT branch or path. Clean initialized submodules are supported. force deliberately discards local work but never bypasses ownership or safe inspection. Ignored files are removed in either mode.",
  repair:
    "Non-destructively inspect or repair managed worktree metadata. Required: repository and slot (managed path or claim ID). Does not release an existing checkout; use worktree_release for that.",
};

type ExtensionContext = {
  cwd: string;
  sessionManager: { getSessionId(): string };
};
type ToolCallEvent = { toolName?: string; input?: unknown };
type ExtensionAPI = {
  events?: AllocationEventBus;
  on(
    name: string,
    handler: (event: any, ctx: ExtensionContext) => unknown,
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    prepareArguments?(args: unknown): unknown;
    execute(
      id: string,
      params: PoolParameters,
      signal: unknown,
      update: unknown,
      ctx: ExtensionContext,
    ): Promise<unknown>;
  }): void;
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

const properties = {
  repository: {
    type: "string",
    minLength: 1,
    description:
      "Repository name or safe relative path beneath ~/dd. Required except when listing all pools.",
  },
  branch: {
    type: "string",
    minLength: 1,
    description: "Branch to acquire, e.g. jpriverar/my-feature.",
  },
  startPoint: {
    type: "string",
    description:
      "Optional acquisition start point. Recognized remote-tracking refs are fetched first. Omit or use an empty string for the repository default.",
  },
  claimId: {
    type: "string",
    minLength: 1,
    description:
      "Exact opaque claim ID returned by worktree_acquire or worktree_list. Not a branch or path.",
  },
  slot: {
    type: "string",
    minLength: 1,
    description:
      "Managed worktree path or exact claim ID to inspect or repair.",
  },
  force: {
    type: "boolean",
    default: false,
    description:
      "Explicitly discard uncommitted/untracked work and submodule-local commits or stashes. Default false preserves local work. Never bypasses ownership, managed-path, or inspection failures; retrying an inspection failure with force will not help.",
  },
} as const;

export function createWorktreePoolExtension(
  deps: WorktreePoolExtensionDependencies,
) {
  return function worktreePoolExtension(pi: ExtensionAPI): void {
    registerAllocationCapability(pi.events);
    const ownerFor = (ctx: ExtensionContext) =>
      currentOwner(ctx.sessionManager.getSessionId(), {
        pid: deps.pid,
        hostname: deps.hostname,
        now: deps.now,
      });

    for (const action of ACTIONS)
      pi.registerTool({
        name: `worktree_${action}`,
        label: `Worktree ${action}`,
        description: DESCRIPTIONS[action],
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ACTION_FIELDS[action].map((field) => [
              field,
              action === "list"
                ? {
                    ...properties.repository,
                    minLength: 0,
                    description:
                      "Optional repository name or safe relative path beneath ~/dd. Omit or use an empty string to list all pools.",
                  }
                : properties[field],
            ]),
          ),
          required: REQUIRED_FIELDS[action],
        },
        prepareArguments(value) {
          if (action !== "list" || !isRecord(value) || value.repository !== "")
            return value;
          const { repository: _repository, ...params } = value;
          return params;
        },
        async execute(_id, params, _signal, _update, ctx) {
          validateParameters(action, params);
          const owner = ownerFor(ctx);
          if (action === "acquire") {
            const request = {
              repository: params.repository!,
              branch: params.branch!,
              ...(params.startPoint === undefined || params.startPoint === ""
                ? {}
                : { startPoint: params.startPoint }),
            };
            const acquired = await allocateWithHooks(
              pi.events,
              _id,
              request,
              owner,
              async (identity) => {
                const runtime = await deps.loadRuntime(
                  [request.repository],
                  "acquire",
                );
                return runtime.pool.acquire(request, owner, identity);
              },
            );
            return result(
              `${acquired.reused ? "Reused" : "Acquired"} ${acquired.path} on ${acquired.branch} ` +
                `(HEAD ${acquired.head}; ${acquired.relationship} ${acquired.startPoint} at ${acquired.startPointHead} ` +
                `[${acquired.startPointFetched ? "fetched" : "local"}]; claim ${acquired.claimId}).\n` +
                `When work is durable and no child uses it, release with worktree_release(${JSON.stringify({ repository: params.repository, claimId: acquired.claimId })}).`,
              { action: "acquire", ...acquired },
            );
          }

          const repositories =
            params.repository === undefined ? [] : [params.repository];
          const runtime = await deps.loadRuntime(repositories, "identity");

          if (action === "list") {
            const listing = await runtime.pool.list(params.repository);
            return result(formatListing(listing), {
              action: "list",
              ...listing,
            });
          }
          if (action === "release") {
            const released = await runtime.pool.release(
              params.repository!,
              params.claimId!,
              owner,
              undefined,
              { force: params.force === true },
            );
            return result(
              released.released
                ? `Released ${released.path}.`
                : `Claim ${params.claimId} was not released.${released.reason ? `\n${released.reason}` : " Ownership or worktree identity checks did not pass; inspect this claim with worktree_list or worktree_repair."}`,
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

function validateParameters(action: PoolAction, params: PoolParameters): void {
  const fields: readonly string[] = ACTION_FIELDS[action];
  for (const field of Object.keys(params)) {
    if (!fields.includes(field)) {
      throw new Error(
        `worktree_${action} does not accept ${field}. Allowed inputs: ${fields.join(", ")}. Required: ${REQUIRED_FIELDS[action].join(", ") || "none"}.`,
      );
    }
  }
  for (const field of REQUIRED_FIELDS[action])
    requireText(params[field], `worktree_${action}.${field}`);
  if (action === "list" && params.repository !== undefined)
    requireText(params.repository, "worktree_list.repository");
  if (params.startPoint !== undefined && typeof params.startPoint !== "string")
    throw new Error("worktree_acquire.startPoint must be a string");
  if (params.force !== undefined && typeof params.force !== "boolean")
    throw new Error("worktree_release.force must be a boolean");
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} must be a non-empty string`);
}

function result(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function formatListing(listing: PoolListing): string {
  if (listing.repositories.length === 0)
    return "No configured worktree repositories.";
  return listing.repositories
    .map((repository) =>
      [
        `${repository.name}: ${repository.used}/${repository.capacity} slots used`,
        ...repository.worktrees.map((worktree) =>
          [
            `  ${worktree.path} — ${worktree.state}`,
            `    claimId: ${worktree.claimId ?? "unknown"}; branch: ${worktree.branch ?? worktree.currentBranch ?? "unknown"}`,
            `    owner: ${worktree.owner ? `${worktree.owner.sessionId} (${worktree.owner.host}, pid ${worktree.owner.pid})` : "unknown"}`,
            ...(worktree.reason ? [`    blocker: ${worktree.reason}`] : []),
          ].join("\n"),
        ),
      ].join("\n"),
    )
    .join("\n");
}

function subagentDepth(): number {
  const value = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const productionDependencies: WorktreePoolExtensionDependencies = {
  now: Date.now,
  pid: process.pid,
  hostname: readHostname(),
  loadRuntime(repositoryIdentifiers, purpose = "identity") {
    return loadWorktreePoolRuntime(repositoryIdentifiers, purpose);
  },
};

export default createWorktreePoolExtension(productionDependencies);
