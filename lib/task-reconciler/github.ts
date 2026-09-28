import {
  createCheckAdapterRegistry,
  type CheckAdapterRegistry,
} from "../task-lifecycle/checks.js";
import { loadLifecycleConfig } from "../task-lifecycle/config.js";
import { CommandExecutionError, runBoundedCommand } from "./commands.js";
import { daemonEnvironment, type DaemonConfig } from "./config.js";

class GitHubCheckError extends Error {}

function targetOwner(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubCheckError("invalid GitHub pull request target");
  }
  const match =
    /^\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(
      url.pathname,
    );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    match === null
  ) {
    throw new GitHubCheckError("invalid GitHub pull request target");
  }
  return match[1].toLowerCase();
}

export function createDaemonCheckAdapters(
  config: DaemonConfig,
): CheckAdapterRegistry {
  const policy = loadLifecycleConfig(config.lifecycleConfigPath);
  const registry = createCheckAdapterRegistry({
    now: Date.now,
    prPollIntervalMs: policy.prPollIntervalMs,
    execGh: async (args, options) => {
      if (
        args.length !== 5 ||
        args[0] !== "pr" ||
        args[1] !== "view" ||
        args[3] !== "--json" ||
        args[4] !== "state,reviewDecision,mergeStateStatus,mergedAt"
      )
        throw new GitHubCheckError("unsupported GitHub check command");
      const owner = targetOwner(args[2]);
      const account = Object.hasOwn(config.githubAccounts, owner)
        ? config.githubAccounts[owner]
        : undefined;
      if (account === undefined)
        throw new GitHubCheckError(
          `GitHub account is not configured for owner ${owner}`,
        );
      const env = daemonEnvironment(config);
      const commandOptions = {
        env,
        signal: options?.signal,
        timeoutMs: config.limits.commandTimeoutMs,
        maxOutputBytes: config.limits.maxOutputBytes,
      };
      const auth = await runBoundedCommand(
        config.executables.gh,
        ["auth", "token", "--hostname", "github.com", "--user", account],
        commandOptions,
      );
      const token = auth.stdout.trim();
      if (
        auth.code !== 0 ||
        token.length === 0 ||
        token.length > 4096 ||
        /[\u0000-\u0020\u007f]/.test(token)
      )
        throw new GitHubCheckError(
          `GitHub credentials unavailable for owner ${owner}; authenticate the configured account outside the daemon`,
        );
      return runBoundedCommand(config.executables.gh, args, {
        ...commandOptions,
        env: { ...env, GH_TOKEN: token },
      });
    },
  });
  return {
    async observe(check, artifacts, input = {}) {
      try {
        return await registry.observe(check, artifacts, input);
      } catch (error) {
        return {
          outcome: "error",
          observation:
            error instanceof GitHubCheckError
              ? error.message
              : error instanceof CommandExecutionError
                ? `GitHub check command failed (${error.reason}); verify authentication and command availability outside the daemon`
                : "GitHub check failed; inspect daemon health",
        };
      }
    },
  };
}
