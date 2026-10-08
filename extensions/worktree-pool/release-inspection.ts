import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const RELEASE_STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
  "--ignore-submodules=none",
];

type Git = (cwd: string, args: string[]) => Promise<string>;

export async function inspectRelease(
  path: string,
  git: Git,
  discard: boolean,
): Promise<{ requiresForce: boolean; warning?: string }> {
  const checkout = await realpath(path);
  const gitDir = await realpath(
    (await git(path, ["rev-parse", "--absolute-git-dir"])).trim(),
  );
  const gitDirs = new Map<string, string>();
  const retained = await collectGitDirs(
    join(gitDir, "modules"),
    gitDirs,
    gitDir,
  );
  const initialized = (
    await git(path, [
      "submodule",
      "foreach",
      "--quiet",
      "--recursive",
      'printf "%s\\0" "$toplevel/$sm_path"',
    ])
  )
    .split("\0")
    .filter(Boolean);
  const checkouts = new Map<string, string>([[path, "."]]);
  for (const child of initialized) {
    const canonical = await realpath(child);
    if (!isWithin(checkout, canonical))
      throw new Error(
        `cannot release ${path}: submodule checkout ${child} is outside the managed worktree`,
      );
    const childGitDir = await realpath(
      (await git(child, ["rev-parse", "--absolute-git-dir"])).trim(),
    );
    if (!isWithin(gitDir, childGitDir) && !isWithin(checkout, childGitDir))
      throw new Error(
        `cannot release ${path}: submodule Git directory ${childGitDir} is outside this worktree's ownership`,
      );
    const label = relative(checkout, canonical);
    checkouts.set(child, label);
    gitDirs.set(childGitDir, label);
  }
  for (const [directory, label] of gitDirs) {
    const registered = await git(path, [
      `--git-dir=${directory}`,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    for (const field of registered.split("\0")) {
      if (!field.startsWith("worktree ")) continue;
      const registeredPath = field.slice("worktree ".length);
      const canonical = await realpath(registeredPath).catch((error) => {
        if (error?.code === "ENOENT") return registeredPath;
        throw error;
      });
      // Git reports the submodule gitdir itself as its main worktree.
      if (canonical !== directory && !isWithin(checkout, canonical))
        throw new Error(
          `cannot release ${path}: submodule ${label} Git data is used by another worktree at ${registeredPath}`,
        );
    }
  }
  const warnings: string[] = [];
  if (!discard) {
    for (const [child, label] of checkouts) {
      const status = await git(child, RELEASE_STATUS_ARGS);
      if (status.length > 0) warnings.push(`${label}:\n${status.trimEnd()}`);
    }
    for (const [directory, label] of gitDirs) {
      // Removing this worktree also deletes these submodule object databases.
      const local = (
        await git(path, [
          `--git-dir=${directory}`,
          "rev-list",
          "--max-count=1",
          "HEAD",
          "--all",
          "--not",
          "--remotes",
        ])
      ).trim();
      if (local)
        warnings.push(
          `${label}: submodule commits or stashes not reachable from remote-tracking refs (${local})`,
        );
    }
  }
  const summary = warnings.join("\n");
  return {
    requiresForce: retained || initialized.length > 0,
    ...(summary
      ? {
          warning:
            summary.length > 4000
              ? `${summary.slice(0, 4000)}\n[truncated; inspect Git status and submodule refs for the full list]`
              : summary,
        }
      : {}),
  };
}

async function collectGitDirs(
  path: string,
  found: Map<string, string>,
  root: string,
): Promise<boolean> {
  const entry = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (entry === undefined) return false;
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error(
      `cannot inspect retained submodule Git directory ${path}: expected a plain directory`,
    );
  const head = await lstat(join(path, "HEAD")).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (head !== undefined) {
    found.set(await realpath(path), relative(root, path));
    await collectGitDirs(join(path, "modules"), found, root);
  } else {
    for (const child of await readdir(path, { withFileTypes: true })) {
      if (child.isDirectory() || child.isSymbolicLink())
        await collectGitDirs(join(path, child.name), found, root);
    }
  }
  return true;
}

function isWithin(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix !== "" &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix)
  );
}
