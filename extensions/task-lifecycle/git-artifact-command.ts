import { basename, resolve } from "node:path";

import {
  splitShellCommands,
  unwrapExecutable,
} from "../shared/shell-command.js";

export type GitArtifactObservationIntent =
  | {
      kind: "git-head";
      operation: "commit" | "push";
      cwd: string;
      ref: string;
    }
  | {
      kind: "github-pr";
      operation: "pr-create";
      cwd: string;
      repository?: string;
      head?: string;
    };

export interface GitArtifactCommandClassifier {
  classify(command: string, cwd: string): GitArtifactObservationIntent[];
}

const MAX_COMMAND_LENGTH = 16_384;
const PUSH_FLAGS = new Set([
  "-u",
  "--set-upstream",
  "-f",
  "--force",
  "--force-with-lease",
  "--follow-tags",
  "--atomic",
  "--no-verify",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
]);
const PUSH_OPTIONS_WITH_ARGUMENT = new Set([
  "--receive-pack",
  "--exec",
  "-o",
  "--push-option",
]);
const PR_OPTIONS_WITH_ARGUMENT = new Set([
  "--base",
  "-B",
  "--title",
  "-t",
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--reviewer",
  "-r",
  "--assignee",
  "-a",
  "--label",
  "-l",
  "--milestone",
  "-m",
  "--project",
  "-p",
  "--template",
  "-T",
  "--recover",
]);
const PR_FLAGS = new Set([
  "--draft",
  "--fill",
  "--fill-first",
  "--fill-verbose",
  "--no-maintainer-edit",
]);

export function createDeterministicGitArtifactClassifier(): GitArtifactCommandClassifier {
  return {
    classify(command, cwd) {
      if (
        command.length === 0 ||
        command.length > MAX_COMMAND_LENGTH ||
        containsOpaqueShell(command)
      ) {
        return [];
      }
      const segments = splitShellCommands(command);
      if (segments.length !== 1) return [];
      const executable = unwrapExecutable(segments[0]);
      if (executable === undefined) return [];
      const name = basename(executable.executable);
      if (name === "git") return classifyGit(executable.args, cwd);
      if (name === "gh") return classifyGh(executable.args, cwd);
      return [];
    },
  };
}

function classifyGit(
  args: readonly string[],
  initialCwd: string,
): GitArtifactObservationIntent[] {
  const parsed = parseGit(args, initialCwd);
  if (parsed === null) return [];
  if (parsed.command === "commit") {
    return hasOption(parsed.args, "--dry-run")
      ? []
      : [
          {
            kind: "git-head",
            operation: "commit",
            cwd: parsed.cwd,
            ref: "HEAD",
          },
        ];
  }
  if (parsed.command !== "push") return [];
  const ref = pushedRef(parsed.args);
  return ref === null
    ? []
    : [
        {
          kind: "git-head",
          operation: "push",
          cwd: parsed.cwd,
          ref,
        },
      ];
}

function parseGit(
  args: readonly string[],
  initialCwd: string,
): { command: string; args: string[]; cwd: string } | null {
  let cwd = resolve(initialCwd);
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === "-C") {
      const value = args[index + 1];
      if (!value) return null;
      cwd = resolve(cwd, value);
      index += 2;
      continue;
    }
    if (argument.startsWith("-C") && argument.length > 2) {
      cwd = resolve(cwd, argument.slice(2));
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) return null;
    return { command: argument, args: args.slice(index + 1), cwd };
  }
  return null;
}

function pushedRef(args: readonly string[]): string | null {
  if (
    hasOption(args, "--dry-run") ||
    hasOption(args, "--all") ||
    hasOption(args, "--mirror")
  ) {
    return null;
  }
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      PUSH_FLAGS.has(argument) ||
      argument.startsWith("--force-with-lease=")
    ) {
      continue;
    }
    if (PUSH_OPTIONS_WITH_ARGUMENT.has(argument)) {
      if (args[index + 1] === undefined) return null;
      index += 1;
      continue;
    }
    if (
      argument.startsWith("--receive-pack=") ||
      argument.startsWith("--exec=") ||
      argument.startsWith("--push-option=")
    ) {
      continue;
    }
    if (argument.startsWith("-")) return null;
    positionals.push(argument);
  }
  if (positionals.length <= 1) return "HEAD";
  if (positionals.length !== 2 || !isSimpleRef(positionals[1])) return null;
  return positionals[1];
}

function classifyGh(
  args: readonly string[],
  cwd: string,
): GitArtifactObservationIntent[] {
  if (args[0] !== "pr" || args[1] !== "create") return [];
  let repository: string | undefined;
  let head: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") return [];
    if (argument === "--repo" || argument === "-R") {
      repository = args[index + 1];
      if (!isRepositoryHint(repository)) return [];
      index += 1;
      continue;
    }
    if (argument.startsWith("--repo=")) {
      repository = argument.slice("--repo=".length);
      if (!isRepositoryHint(repository)) return [];
      continue;
    }
    if (argument === "--head") {
      head = args[index + 1];
      if (!isHeadHint(head)) return [];
      index += 1;
      continue;
    }
    if (argument.startsWith("--head=")) {
      head = argument.slice("--head=".length);
      if (!isHeadHint(head)) return [];
      continue;
    }
    if (PR_OPTIONS_WITH_ARGUMENT.has(argument)) {
      if (args[index + 1] === undefined) return [];
      index += 1;
      continue;
    }
    if (PR_FLAGS.has(argument)) continue;
    if (argument.startsWith("-")) return [];
    return [];
  }
  return [
    {
      kind: "github-pr",
      operation: "pr-create",
      cwd: resolve(cwd),
      ...(repository === undefined ? {} : { repository }),
      ...(head === undefined ? {} : { head }),
    },
  ];
}

function containsOpaqueShell(command: string): boolean {
  return (
    command.includes("<<") ||
    command.includes("$(") ||
    command.includes("${") ||
    command.includes("`")
  );
}

function hasOption(args: readonly string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function isSimpleRef(value: string): boolean {
  return (
    value === "HEAD" ||
    (/^[A-Za-z0-9._/-]+$/.test(value) &&
      !value.startsWith("-") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith("/"))
  );
}

function isRepositoryHint(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length <= 256 &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  );
}

function isHeadHint(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length <= 256 &&
    /^(?:[A-Za-z0-9_.-]+:)?[A-Za-z0-9._/-]+$/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{")
  );
}
