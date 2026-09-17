import { describe, expect, test } from "../../tests/expect.js";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createManagedWorktree,
  managedWorktreePath,
  removeManagedWorktree,
  verifyManagedWorktree,
  type ManagedWorktreeDependencies,
} from "./managed-worktree.js";
import type { GitRunner, ResolvedRepository } from "./types.js";

const execFileAsync = promisify(execFile);
const PATH_ID = "323e4567-e89b-42d3-a456-426614174002";

const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8" },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch {
    return false;
  }
}

async function withRepository<T>(
  fn: (input: {
    repository: ResolvedRepository;
    deps: ManagedWorktreeDependencies;
    base: string;
    commands: string[][];
    root: string;
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "managed-worktree-"));
  try {
    const repositoryPath = join(root, "repo");
    const poolRoot = join(root, "pool");
    await mkdir(repositoryPath);
    await mkdir(poolRoot);
    await git(repositoryPath, ["init", "-b", "main"]);
    await git(repositoryPath, ["config", "user.name", "Pi Test"]);
    await git(repositoryPath, ["config", "user.email", "pi@example.com"]);
    await writeFile(join(repositoryPath, "README.md"), "seed\n");
    await git(repositoryPath, ["add", "README.md"]);
    await git(repositoryPath, ["commit", "-m", "seed"]);
    const commands: string[][] = [];
    const recording: GitRunner = async (cwd, args) => {
      commands.push(args);
      return await runGit(cwd, args);
    };
    const repository: ResolvedRepository = {
      name: "repo",
      path: repositoryPath,
      canonicalPath: await realpath(repositoryPath),
      commonDir: await git(repositoryPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      poolRoot,
      poolDir: join(poolRoot, "repo"),
      capacity: 3,
      defaultStartPoint: "main",
    };
    return await fn({
      repository,
      deps: { runGit: recording, realpath },
      base: await git(repositoryPath, ["rev-parse", "HEAD"]),
      commands,
      root,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("managed ephemeral worktrees", () => {
  test("creates a unique branch worktree and removes it while preserving the branch", async () =>
    withRepository(async ({ repository, deps, base, commands }) => {
      const created = await createManagedWorktree(
        {
          repository,
          pathId: PATH_ID,
          branch: "feature",
          startPointHead: base,
        },
        deps,
      );
      expect(created).toEqual({
        path: join(repository.poolDir, `worktree-${PATH_ID}`),
        branchCreated: true,
      });
      expect(await git(created.path, ["branch", "--show-current"])).toBe(
        "feature",
      );
      expect(
        (await verifyManagedWorktree(repository, created.path, deps)).branch,
      ).toBe("refs/heads/feature");
      await removeManagedWorktree(repository, created.path, deps);
      expect(await exists(created.path)).toBe(false);
      expect(
        await git(repository.path, [
          "show-ref",
          "--verify",
          "refs/heads/feature",
        ]),
      ).not.toBe("");
      expect(
        commands.some(
          (args) =>
            args.includes("--force") ||
            args.includes("reset") ||
            args.includes("clean") ||
            (args.includes("branch") && args.includes("-D")),
        ),
      ).toBe(false);
    }));

  test("uses an existing branch without recreating it", async () =>
    withRepository(async ({ repository, deps, base }) => {
      await git(repository.path, ["branch", "existing", base]);
      const created = await createManagedWorktree(
        {
          repository,
          pathId: PATH_ID,
          branch: "existing",
          startPointHead: base,
        },
        deps,
      );
      expect(created.branchCreated).toBe(false);
      expect(await git(created.path, ["branch", "--show-current"])).toBe(
        "existing",
      );
    }));

  test("rejects invalid IDs, option-like branches, collisions, and symlink leaves", async () =>
    withRepository(async ({ repository, deps, base, root }) => {
      expect(() => managedWorktreePath(repository, "not-a-uuid")).toThrow(
        "path ID",
      );
      await expect(
        createManagedWorktree(
          { repository, pathId: PATH_ID, branch: "-bad", startPointHead: base },
          deps,
        ),
      ).rejects.toThrow("branch");
      await mkdir(repository.poolDir, { recursive: true });
      await mkdir(managedWorktreePath(repository, PATH_ID));
      await expect(
        createManagedWorktree(
          {
            repository,
            pathId: PATH_ID,
            branch: "collision",
            startPointHead: base,
          },
          deps,
        ),
      ).rejects.toThrow("already exists");
      await rm(managedWorktreePath(repository, PATH_ID), { recursive: true });
      await symlink(root, managedWorktreePath(repository, PATH_ID));
      await expect(
        createManagedWorktree(
          {
            repository,
            pathId: PATH_ID,
            branch: "alias",
            startPointHead: base,
          },
          deps,
        ),
      ).rejects.toThrow("symbolic link");
    }));

  test("preserves a symlinked pool marker", async () =>
    withRepository(async ({ repository, deps, base, root }) => {
      const outside = join(root, "outside-marker.json");
      await writeFile(outside, "{}\n");
      await symlink(
        outside,
        join(repository.poolRoot, ".pi-worktree-pool-root.json"),
      );
      await expect(
        createManagedWorktree(
          {
            repository,
            pathId: PATH_ID,
            branch: "feature",
            startPointHead: base,
          },
          deps,
        ),
      ).rejects.toThrow("plain regular file");
      expect(await exists(managedWorktreePath(repository, PATH_ID))).toBe(
        false,
      );
    }));

  test("refuses a branch already checked out elsewhere", async () =>
    withRepository(async ({ repository, deps, base, root }) => {
      const outside = join(root, "outside");
      await git(repository.path, ["branch", "busy", base]);
      await git(repository.path, ["worktree", "add", outside, "busy"]);
      await expect(
        createManagedWorktree(
          { repository, pathId: PATH_ID, branch: "busy", startPointHead: base },
          deps,
        ),
      ).rejects.toThrow(/already (?:checked out|used)/);
    }));

  test("requires one exact valid non-prunable registration", async () =>
    withRepository(async ({ repository, deps, base }) => {
      const created = await createManagedWorktree(
        {
          repository,
          pathId: PATH_ID,
          branch: "feature",
          startPointHead: base,
        },
        deps,
      );
      await expect(
        verifyManagedWorktree(repository, repository.path, deps),
      ).rejects.toThrow("managed path");
      const malformed: ManagedWorktreeDependencies = {
        ...deps,
        runGit: async (cwd, args) => {
          const result = await deps.runGit(cwd, args);
          return args.join(" ") === "worktree list --porcelain"
            ? {
                ...result,
                stdout: result.stdout.replace(
                  "branch refs/heads/feature",
                  "branch refs/heads/feature\nprunable injected",
                ),
              }
            : result;
        },
      };
      await expect(
        verifyManagedWorktree(repository, created.path, malformed),
      ).rejects.toThrow("valid registration");
    }));

  test("ordinary removal refuses dirty and locked worktrees", async () =>
    withRepository(async ({ repository, deps, base }) => {
      const created = await createManagedWorktree(
        {
          repository,
          pathId: PATH_ID,
          branch: "feature",
          startPointHead: base,
        },
        deps,
      );
      await writeFile(join(created.path, "dirty.txt"), "dirty\n");
      await expect(
        removeManagedWorktree(repository, created.path, deps),
      ).rejects.toThrow("contains modified or untracked files");
      await rm(join(created.path, "dirty.txt"));
      await git(repository.path, [
        "worktree",
        "lock",
        "--reason",
        "test",
        created.path,
      ]);
      await expect(
        removeManagedWorktree(repository, created.path, deps),
      ).rejects.toThrow("locked");
      await git(repository.path, ["worktree", "unlock", created.path]);
      await removeManagedWorktree(repository, created.path, deps);
    }));
});
