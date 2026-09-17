import { describe, expect, test } from "../../tests/expect.js";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { durableRefsForHead, inspectRepository } from "./git-state.js";
import type {
  GitResult,
  RegisteredWorktree,
  ResolvedRepository,
} from "./types.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "worktree-pool-git-state-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(
          new Error(`git ${args.join(" ")} terminated with signal ${signal}`),
        );
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

async function initRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "main"]);
  await git(path, ["config", "user.name", "Pi Test"]);
  await git(path, ["config", "user.email", "pi@example.com"]);
  await writeFile(join(path, "README.md"), "seed\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "seed"]);
}

async function initRepositoryWithOrigin(dir: string): Promise<{
  repository: ResolvedRepository;
  featureTree: string;
  detachedTree: string;
}> {
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const featureTree = join(dir, "feature-tree");
  const detachedTree = join(dir, "detached-tree");
  const poolRoot = join(dir, "pools");

  await mkdir(origin, { recursive: true });
  await git(origin, ["init", "--bare"]);
  await initRepository(repo);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-u", "origin", "main"]);
  await git(repo, ["fetch", "origin"]);
  await git(repo, ["update-ref", "refs/tags/v1", "HEAD"]);
  await git(repo, ["branch", "feature"]);
  await git(repo, ["worktree", "add", featureTree, "feature"]);
  await git(repo, [
    "worktree",
    "lock",
    "--reason",
    "held elsewhere",
    featureTree,
  ]);
  await git(repo, ["worktree", "add", "--detach", detachedTree, "HEAD"]);

  const commonDir = await git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return {
    repository: {
      name: "repo",
      path: repo,
      canonicalPath: repo,
      commonDir,
      poolRoot,
      poolDir: join(poolRoot, "repo"),
      capacity: 3,
      defaultStartPoint: "origin/main",
    },
    featureTree,
    detachedTree,
  };
}

describe("inspectRepository", () => {
  test("parses git worktree porcelain for branches, detached heads, and lock reasons", async () => {
    await withTempDir(async (dir) => {
      const { repository, featureTree, detachedTree } =
        await initRepositoryWithOrigin(dir);
      const mainHead = await git(repository.path, ["rev-parse", "HEAD"]);
      const featureHead = await git(featureTree, ["rev-parse", "HEAD"]);
      const detachedHead = await git(detachedTree, ["rev-parse", "HEAD"]);
      const mainPath = await realpath(repository.path);
      const featurePath = await realpath(featureTree);
      const detachedPath = await realpath(detachedTree);

      const worktrees = await inspectRepository(repository, runGit);
      const byPath = new Map(
        worktrees.map((worktree) => [worktree.path, worktree]),
      );

      expect(worktrees).toHaveLength(3);
      expect(byPath.get(mainPath)).toEqual({
        path: mainPath,
        head: mainHead,
        branch: "refs/heads/main",
        detached: false,
        valid: true,
      });
      expect(byPath.get(featurePath)).toEqual({
        path: featurePath,
        head: featureHead,
        branch: "refs/heads/feature",
        detached: false,
        lockedReason: "held elsewhere",
        valid: true,
      });
      expect(byPath.get(detachedPath)).toEqual({
        path: detachedPath,
        head: detachedHead,
        detached: true,
        valid: true,
      });
    });
  }, 20_000);

  test("preserves Git's prunable worktree evidence", async () => {
    const repository: ResolvedRepository = {
      name: "repo",
      path: "/tmp/repo",
      canonicalPath: "/tmp/repo",
      commonDir: "/tmp/repo/.git",
      poolRoot: "/tmp/pools",
      poolDir: "/tmp/pools/repo",
      capacity: 3,
      defaultStartPoint: "origin/main",
    };

    const worktrees = await inspectRepository(repository, async () => ({
      code: 0,
      stdout: [
        "worktree /tmp/deleted",
        "HEAD abcdef0123456789abcdef0123456789abcdef01",
        "branch refs/heads/stale",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
      stderr: "",
    }));

    expect(worktrees).toEqual([
      {
        path: "/tmp/deleted",
        head: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "refs/heads/stale",
        detached: false,
        prunableReason: "gitdir file points to non-existent location",
        valid: true,
      },
    ] satisfies RegisteredWorktree[]);
  });

  test("preserves malformed porcelain entries as invalid records", async () => {
    const repository: ResolvedRepository = {
      name: "repo",
      path: "/tmp/repo",
      canonicalPath: "/tmp/repo",
      commonDir: "/tmp/repo/.git",
      poolRoot: "/tmp/pools",
      poolDir: "/tmp/pools/repo",
      capacity: 3,
      defaultStartPoint: "origin/main",
    };

    const worktrees = await inspectRepository(repository, async () => ({
      code: 0,
      stdout: [
        "worktree /tmp/repo",
        "HEAD abcdef0123456789abcdef0123456789abcdef01",
        "branch refs/heads/main",
        "",
        "worktree /tmp/broken",
        "branch refs/heads/broken",
        "",
      ].join("\n"),
      stderr: "",
    }));

    expect(worktrees).toEqual([
      {
        path: "/tmp/repo",
        head: "abcdef0123456789abcdef0123456789abcdef01",
        branch: "refs/heads/main",
        detached: false,
        valid: true,
      },
      {
        path: "/tmp/broken",
        head: "",
        branch: "refs/heads/broken",
        detached: false,
        valid: false,
      },
    ] satisfies RegisteredWorktree[]);
  });
});

describe("durableRefsForHead", () => {
  test("returns local, tag, and remote refs that contain HEAD", async () => {
    await withTempDir(async (dir) => {
      const { repository } = await initRepositoryWithOrigin(dir);

      const refs = await durableRefsForHead(repository.path, runGit);

      expect(refs).toEqual(
        expect.arrayContaining([
          "refs/heads/main",
          "refs/tags/v1",
          "refs/remotes/origin/main",
        ]),
      );
    });
  }, 20_000);

  test("returns no durable refs for a detached unique commit", async () => {
    await withTempDir(async (dir) => {
      const { detachedTree } = await initRepositoryWithOrigin(dir);

      await writeFile(join(detachedTree, "unique.txt"), "unique\n");
      await git(detachedTree, ["add", "unique.txt"]);
      await git(detachedTree, ["commit", "-m", "detached"]);

      const refs = await durableRefsForHead(detachedTree, runGit);

      expect(refs).toEqual([]);
    });
  }, 20_000);
});
