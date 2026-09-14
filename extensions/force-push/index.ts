import { realpath } from "node:fs/promises";

import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type ForcePushParams = { reason: string; worktree?: string };

type UpdateKind = "no-op" | "fast-forward" | "rewind" | "divergent";

type RepositoryIdentity =
  | { kind: "session"; root: string }
  | {
      kind: "linked-worktree";
      root: string;
      gitDir: string;
      gitCommonDir: string;
    };

type PushState = {
  root: string;
  branch: string;
  remote: string;
  pushTarget: string;
  destination: string;
  localSha: string;
  remoteSha: string;
  kind: UpdateKind;
  added: number;
  removed: number;
};

type ApprovedAuthority = {
  repository: RepositoryIdentity;
  state: PushState;
  pushUrl: string;
  defaultBranch: string;
};

const parameters = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      description: "Why rewriting the current upstream branch is necessary.",
    },
    worktree: {
      type: "string",
      minLength: 1,
      description:
        "Optional path to a linked worktree whose current branch should be force-pushed instead of Pi's session cwd.",
    },
  },
  required: ["reason"],
  additionalProperties: false,
} as const;

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_CHARS = 4_000;

function denied(
  reason: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    content: [{ type: "text" as const, text }],
    details: { status: "denied", reason, ...extra },
  };
}

function sanitizePushTarget(target: string): string {
  try {
    const parsed = new URL(target);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const scpLike = target.match(/^[^@\s]+@((?:\[[^\]\s]+\])|[^:\s]+):(.+)$/);
    return scpLike ? `${scpLike[1]}:${scpLike[2]}` : target;
  }
}

function sanitizeText(text: string): string {
  return text
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"<>]+/g, (match) =>
      sanitizePushTarget(match),
    )
    .replace(
      /[^\s'"<>@]+@(?:(?:\[[^\]\s]+\])|[^:\s'"<>]+):[^\s'"<>]+/g,
      (match) => sanitizePushTarget(match),
    );
}

function bounded(text: string): string {
  return sanitizeText(text).slice(0, MAX_DIAGNOSTIC_CHARS);
}

function diagnostic(result: ExecResult): string {
  if (result.killed) return "interrupted or timed out";
  return bounded(
    result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`,
  );
}

function sanitizePushArgs(args: string[]): string[] {
  return args.map((arg) => sanitizePushTarget(arg));
}

async function checkedGit(
  pi: ExtensionAPI,
  operation: string,
  args: string[],
  options: ExecOptions,
): Promise<string> {
  const result = await pi.exec("git", args, options);
  if (result.code !== 0 || result.killed)
    throw new Error(`${operation} failed: ${diagnostic(result)}`);
  return result.stdout.trim();
}

async function isAncestor(
  pi: ExtensionAPI,
  operation: string,
  args: string[],
  options: ExecOptions,
): Promise<boolean> {
  const result = await pi.exec("git", args, options);
  if (result.killed)
    throw new Error(`${operation} failed: ${diagnostic(result)}`);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`${operation} failed: ${diagnostic(result)}`);
}

function parseCount(operation: string, value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${operation} failed: expected non-negative integer, got ${JSON.stringify(trimmed)}`,
    );
  }
  const count = Number(trimmed);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      `${operation} failed: expected non-negative integer, got ${JSON.stringify(trimmed)}`,
    );
  }
  return count;
}

async function resolvePushUrl(
  pi: ExtensionAPI,
  root: string,
  remote: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const output = await checkedGit(
    pi,
    "resolve upstream push target",
    ["-C", root, "remote", "get-url", "--push", "--all", "--", remote],
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  const urls = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (urls.length !== 1) {
    throw new Error(
      `resolve upstream push target failed: expected exactly one push URL, got ${urls.length}`,
    );
  }
  return urls[0]!;
}

function sameRepositoryIdentity(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  if (left.kind !== right.kind || left.root !== right.root) return false;
  return (
    left.kind !== "linked-worktree" ||
    (right.kind === "linked-worktree" &&
      left.gitDir === right.gitDir &&
      left.gitCommonDir === right.gitCommonDir)
  );
}

function stateChangedDenial(state: PushState) {
  return denied(
    "state-changed",
    "Force push denied: approved repository state changed before push.",
    { state },
  );
}

async function resolveApprovedAuthority(
  pi: ExtensionAPI,
  params: ForcePushParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ApprovedAuthority | ReturnType<typeof denied>> {
  const repository = await resolveRepositoryIdentity(pi, params, signal, ctx);
  const root = repository.root;
  const atRoot = (args: string[]) => ["-C", root, ...args];
  const branch = await checkedGit(
    pi,
    "resolve current branch",
    atRoot(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  const remote = await checkedGit(
    pi,
    "resolve upstream remote",
    atRoot(["config", "--get", `branch.${branch}.remote`]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  const pushUrl = await resolvePushUrl(pi, root, remote, signal);
  const destination = await checkedGit(
    pi,
    "resolve upstream destination",
    atRoot(["config", "--get", `branch.${branch}.merge`]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  await checkedGit(
    pi,
    "validate upstream destination",
    atRoot(["check-ref-format", destination]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  if (!destination.startsWith("refs/heads/")) {
    throw new Error(
      `validate upstream destination failed: ${destination} is not a branch ref`,
    );
  }
  const localSha = await checkedGit(
    pi,
    "resolve local commit",
    atRoot(["rev-parse", "--verify", "HEAD^{commit}"]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  const remoteHead = await checkedGit(
    pi,
    "resolve remote default branch",
    atRoot(["ls-remote", "--symref", "--", pushUrl, "HEAD"]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  const defaultMatch = remoteHead.match(
    /^ref:\s+(refs\/heads\/[^\t\n]+)\s+HEAD$/m,
  );
  if (!defaultMatch)
    throw new Error(
      "resolve remote default branch failed: remote HEAD is not symbolic",
    );
  const defaultBranch = defaultMatch[1]!;
  if (destination === defaultBranch) {
    return denied(
      "default-branch",
      `Force push denied: ${destination} is the remote default branch.`,
    );
  }

  await checkedGit(
    pi,
    "fetch upstream destination",
    atRoot(["fetch", "--no-tags", "--quiet", "--", pushUrl, destination]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  const remoteSha = await checkedGit(
    pi,
    "resolve fetched destination",
    atRoot(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]),
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );

  let kind: UpdateKind;
  if (localSha === remoteSha) {
    kind = "no-op";
  } else if (
    await isAncestor(
      pi,
      "check whether remote commit is ancestor",
      atRoot(["merge-base", "--is-ancestor", remoteSha, localSha]),
      { signal, timeout: GIT_TIMEOUT_MS },
    )
  ) {
    kind = "fast-forward";
  } else if (
    await isAncestor(
      pi,
      "check whether local commit is ancestor",
      atRoot(["merge-base", "--is-ancestor", localSha, remoteSha]),
      { signal, timeout: GIT_TIMEOUT_MS },
    )
  ) {
    kind = "rewind";
  } else {
    kind = "divergent";
  }

  const added = parseCount(
    "count added commits",
    await checkedGit(
      pi,
      "count added commits",
      atRoot(["rev-list", "--count", `${remoteSha}..${localSha}`]),
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    ),
  );
  const removed = parseCount(
    "count removed commits",
    await checkedGit(
      pi,
      "count removed commits",
      atRoot(["rev-list", "--count", `${localSha}..${remoteSha}`]),
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    ),
  );

  return {
    repository,
    pushUrl,
    defaultBranch,
    state: {
      root,
      branch,
      remote,
      pushTarget: sanitizePushTarget(pushUrl),
      destination,
      localSha,
      remoteSha,
      kind,
      added,
      removed,
    },
  };
}

async function resolveRepositoryIdentity(
  pi: ExtensionAPI,
  params: ForcePushParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<RepositoryIdentity> {
  const selectedCwd = params.worktree ?? ctx.cwd;
  const resolvedRoot = await checkedGit(
    pi,
    "resolve repository root",
    ["rev-parse", "--show-toplevel"],
    {
      cwd: selectedCwd,
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  if (!params.worktree) return { kind: "session", root: resolvedRoot };

  await realpath(params.worktree);
  const root = await realpath(resolvedRoot);
  const superproject = await checkedGit(
    pi,
    "validate explicit target is not a submodule",
    ["-C", root, "rev-parse", "--show-superproject-working-tree"],
    {
      signal,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  if (superproject.trim().length > 0) {
    throw new Error("explicit target is a submodule");
  }
  const gitDir = await realpath(
    await checkedGit(
      pi,
      "resolve explicit target git dir",
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir"],
      { signal, timeout: GIT_TIMEOUT_MS },
    ),
  );
  const gitCommonDir = await realpath(
    await checkedGit(
      pi,
      "resolve explicit target git common dir",
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal, timeout: GIT_TIMEOUT_MS },
    ),
  );
  if (gitDir === gitCommonDir) {
    throw new Error("explicit target is not a linked worktree");
  }
  return { kind: "linked-worktree", root, gitDir, gitCommonDir };
}

export default function forcePush(pi: ExtensionAPI) {
  let active = false;

  async function runForcePush(
    params: ForcePushParams,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) {
    const approved = await resolveApprovedAuthority(pi, params, signal, ctx);
    if ("content" in approved) return approved;

    const { state } = approved;
    const reason = params.reason.trim();
    pi.events.emit("force-push:blocked", { active: true });
    let confirmed: boolean;
    try {
      confirmed = await (
        ctx as ExtensionContext & {
          ui: { confirm(title: string, message: string): Promise<boolean> };
        }
      ).ui.confirm(
        "Authorize one force push?",
        [
          `Repository: ${state.root}`,
          `Upstream: ${state.remote} ${state.destination}`,
          `Push target: ${state.pushTarget}`,
          `Remote: ${state.remoteSha}`,
          `Local:  ${state.localSha}`,
          `Update: ${state.kind} (${state.added} added, ${state.removed} removed)`,
          `Reason: ${reason}`,
          "",
          "This will attempt exactly the displayed SHA-bound force-with-lease update and rewrite the remote ref.",
        ].join("\n"),
      );
    } finally {
      pi.events.emit("force-push:blocked", { active: false });
    }
    if (!confirmed) {
      return denied("user-declined", "Force push denied by user.", { state });
    }

    const revalidatedRepository = await resolveRepositoryIdentity(
      pi,
      params,
      signal,
      ctx,
    );
    if (!sameRepositoryIdentity(approved.repository, revalidatedRepository)) {
      return stateChangedDenial(state);
    }
    const root = revalidatedRepository.root;
    const atRoot = (args: string[]) => ["-C", root, ...args];
    const branch = await checkedGit(
      pi,
      "resolve current branch",
      atRoot(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const remote = await checkedGit(
      pi,
      "resolve upstream remote",
      atRoot(["config", "--get", `branch.${branch}.remote`]),
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const pushUrl = await resolvePushUrl(pi, root, remote, signal);
    const destination = await checkedGit(
      pi,
      "resolve upstream destination",
      atRoot(["config", "--get", `branch.${branch}.merge`]),
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const localSha = await checkedGit(
      pi,
      "resolve local commit",
      atRoot(["rev-parse", "--verify", "HEAD^{commit}"]),
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const remoteHead = await checkedGit(
      pi,
      "resolve remote default branch",
      atRoot(["ls-remote", "--symref", "--", pushUrl, "HEAD"]),
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    const defaultMatch = remoteHead.match(
      /^ref:\s+(refs\/heads\/[^\t\n]+)\s+HEAD$/m,
    );
    if (!defaultMatch)
      throw new Error(
        "resolve remote default branch failed: remote HEAD is not symbolic",
      );
    const defaultBranch = defaultMatch[1]!;
    if (destination === defaultBranch) {
      return denied(
        "default-branch",
        `Force push denied: ${destination} is the remote default branch.`,
      );
    }
    if (
      branch !== approved.state.branch ||
      remote !== approved.state.remote ||
      pushUrl !== approved.pushUrl ||
      destination !== approved.state.destination ||
      localSha !== approved.state.localSha ||
      defaultBranch !== approved.defaultBranch
    ) {
      return stateChangedDenial(state);
    }

    const pushArgs = [
      "-C",
      state.root,
      "push",
      `--force-with-lease=${state.destination}:${state.remoteSha}`,
      "--",
      approved.pushUrl,
      `${state.localSha}:${state.destination}`,
    ];
    const push = await pi.exec("git", pushArgs, {
      signal,
      timeout: PUSH_TIMEOUT_MS,
    });
    const stdout = bounded(push.stdout);
    const stderr = bounded(push.stderr);

    if (push.code === 0 && !push.killed) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Force push succeeded: ${state.remote} ${state.destination} now points to ${state.localSha}.`,
          },
        ],
        details: {
          status: "succeeded",
          state,
          pushArgs: sanitizePushArgs(pushArgs),
          code: push.code,
          killed: push.killed,
          stdout,
          stderr,
        },
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Force push failed: ${diagnostic(push)}`,
        },
      ],
      details: {
        status: "failed",
        state,
        pushArgs: sanitizePushArgs(pushArgs),
        code: push.code,
        killed: push.killed,
        stdout,
        stderr,
      },
    };
  }

  pi.registerTool({
    name: "force_push_current_branch",
    label: "Force push current branch",
    description:
      "Request terminal confirmation and perform one exact force-with-lease push of the current branch to its configured upstream. " +
      "Use when completing the requested work requires updating rewritten branch history; ordinary Bash force pushes remain blocked.",
    promptSnippet:
      "Request a terminal-confirmed, exact leased update of rewritten history on the current upstream branch.",
    promptGuidelines: [
      "Use force_push_current_branch instead of Bash when completing the requested work requires updating rewritten history, " +
        "such as after a rebase, amend, squash, commit re-signing, or history cleanup. The tool obtains one-shot user confirmation; " +
        "never retry a denial or failed push, and never fall back to Bash.",
    ],
    parameters: parameters as never,
    executionMode: "sequential",
    async execute(_id, params: ForcePushParams, signal, _update, ctx) {
      if (ctx.mode !== "tui") {
        return denied(
          "terminal-ui-required",
          "Force push denied: direct confirmation in Pi's terminal UI is required.",
        );
      }
      if (active) {
        return denied(
          "invocation-active",
          "Force push denied: another authorization prompt is already active.",
        );
      }
      active = true;
      try {
        return await runForcePush(params, signal, ctx);
      } finally {
        active = false;
      }
    },
  });
}
