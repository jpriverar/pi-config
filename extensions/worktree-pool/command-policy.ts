import { basename } from "node:path";

import {
  splitShellCommands,
  unwrapExecutable,
} from "../shared/shell-command.js";

export type PoolCommandDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

type ParsedGit = { command?: string; args: string[] };

const WORKTREE_MUTATIONS = new Set([
  "add",
  "remove",
  "move",
  "lock",
  "unlock",
  "repair",
  "prune",
]);
const GIT_OPTIONS_WITH_ARGUMENT = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const GIT_OPTIONS_WITH_ATTACHED_ARGUMENT = [
  "-C",
  "-c",
  "--config-env=",
  "--exec-path=",
  "--git-dir=",
  "--namespace=",
  "--super-prefix=",
  "--work-tree=",
];

export function evaluatePoolCommand(
  command: string,
  subagentDepth: number,
): PoolCommandDecision {
  if (hasHeredoc(command)) return { allowed: true };

  for (const segment of splitShellCommands(command)) {
    const executable = unwrapExecutable(segment);
    if (!executable || basename(executable.executable) !== "git") continue;

    const git = parseGit(executable.args);
    if (git.command !== "worktree") continue;
    const verb = worktreeVerb(git.args);
    if (verb && WORKTREE_MUTATIONS.has(verb))
      return block(subagentDepth, actionFor(verb), verb);
  }
  return { allowed: true };
}

function parseGit(args: string[]): ParsedGit {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (GIT_OPTIONS_WITH_ARGUMENT.has(token)) {
      index += 2;
      continue;
    }
    if (
      GIT_OPTIONS_WITH_ATTACHED_ARGUMENT.some(
        (option) => token.startsWith(option) && token.length > option.length,
      )
    ) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return { command: token, args: args.slice(index + 1) };
  }
  return { args: [] };
}

function worktreeVerb(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}
function actionFor(verb: string): "acquire" | "release" | "repair" {
  if (verb === "add" || verb === "lock") return "acquire";
  if (verb === "remove" || verb === "unlock") return "release";
  return "repair";
}
function block(
  depth: number,
  action: string,
  verb: string,
): PoolCommandDecision {
  const detail = `direct git worktree ${verb} is blocked`;
  return {
    allowed: false,
    reason:
      depth > 0
        ? `${detail}. Ask the parent session to use worktree_pool ${action}.`
        : `${detail}. Use worktree_pool ${action}.`,
  };
}
function hasHeredoc(command: string): boolean {
  return /(?:^|[\s;|&])\d*<<-?(?!<)/.test(command);
}
