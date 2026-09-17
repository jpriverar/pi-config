import type {
  GitRunner,
  RegisteredWorktree,
  ResolvedRepository,
} from "./types.js";

export async function inspectRepository(
  repository: ResolvedRepository,
  runGit: GitRunner,
): Promise<RegisteredWorktree[]> {
  const stdout = await runGitOrThrow(
    repository.path,
    ["worktree", "list", "--porcelain"],
    runGit,
  );
  return splitRecords(stdout).map(parseRecord);
}

export async function durableRefsForHead(
  worktreePath: string,
  runGit: GitRunner,
): Promise<string[]> {
  const stdout = await runGitOrThrow(
    worktreePath,
    [
      "for-each-ref",
      "--format=%(refname)",
      "--contains",
      "HEAD",
      "refs/heads",
      "refs/tags",
      "refs/remotes",
    ],
    runGit,
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runGitOrThrow(
  cwd: string,
  args: string[],
  runGit: GitRunner,
): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "git command failed";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
  return result.stdout;
}

function splitRecords(stdout: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];

  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      if (current.length > 0) {
        records.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) {
    records.push(current);
  }

  return records;
}

function parseRecord(lines: string[]): RegisteredWorktree {
  let path = "";
  let head = "";
  let branch: string | undefined;
  let detached = false;
  let lockedReason: string | undefined;
  let prunableReason: string | undefined;
  let valid = true;

  for (const line of lines) {
    if (line === "detached") {
      if (branch !== undefined) valid = false;
      detached = true;
      continue;
    }
    if (line === "locked") {
      lockedReason = "";
      continue;
    }
    if (line === "bare") {
      continue;
    }
    if (line === "prunable") {
      prunableReason = "";
      continue;
    }
    if (line.startsWith("locked ")) {
      lockedReason = line.slice("locked ".length);
      continue;
    }
    if (line.startsWith("prunable ")) {
      prunableReason = line.slice("prunable ".length);
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (path.length > 0) valid = false;
      path = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("HEAD ")) {
      if (head.length > 0) valid = false;
      head = line.slice("HEAD ".length);
      continue;
    }
    if (line.startsWith("branch ")) {
      if (branch !== undefined || detached) valid = false;
      branch = line.slice("branch ".length);
      continue;
    }
    valid = false;
  }

  if (path.length === 0 || head.length === 0) {
    valid = false;
  }
  if (!detached && branch === undefined) {
    valid = false;
  }

  return {
    path,
    head,
    ...(branch === undefined ? {} : { branch }),
    detached,
    ...(lockedReason === undefined ? {} : { lockedReason }),
    ...(prunableReason === undefined ? {} : { prunableReason }),
    valid,
  };
}
