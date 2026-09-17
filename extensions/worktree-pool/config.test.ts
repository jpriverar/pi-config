import { describe, expect, test } from "../../tests/expect.js";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadPoolConfig, resolveRepository } from "./config.js";
import type { GitResult } from "./types.js";

const PRODUCTION_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "config.json",
);

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
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
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
  await git(path, ["remote", "add", "origin", path]);
  await git(path, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(path, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
}
async function withHarness<T>(
  fn: (h: {
    dir: string;
    home: string;
    repositoryRoot: string;
    configPath: string;
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "worktree-pool-config-"));
  const home = join(dir, "home");
  const repositoryRoot = join(home, "src");
  const configPath = join(dir, "config.json");
  await mkdir(repositoryRoot, { recursive: true });
  try {
    return await fn({ dir, home, repositoryRoot, configPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function writeConfig(
  path: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ version: 2, root: "~/src/.worktree-pools", repositoryRoot: "~/src", defaultCapacity: 3, exclude: [], repositories: [], ...overrides }, null, 2)}\n`,
  );
}
const deps = (home: string) => ({ home, runGit, realpath });

describe("loadPoolConfig and resolveRepository", () => {
  test("loads production policy without inspecting repositories", async () => {
    const loaded = await loadPoolConfig(PRODUCTION_CONFIG_PATH, {
      home: "/tmp/test-home",
      runGit,
      realpath: async (path) => path,
    });
    expect(loaded).toMatchObject({
      root: "/tmp/test-home/dd/.worktree-pools",
      repositoryRoot: "/tmp/test-home/dd",
      defaultCapacity: 3,
      exclude: [],
    });
    expect([...loaded.overrides]).toEqual([["dd-source", { capacity: 5 }]]);
  });

  test("resolves a primary checkout lazily and derives origin HEAD only for acquisition", async () =>
    withHarness(async (h) => {
      const repo = join(h.repositoryRoot, "dd-source");
      await initRepository(repo);
      await writeConfig(h.configPath);
      const config = await loadPoolConfig(h.configPath, deps(h.home));
      expect(
        await resolveRepository(config, "dd-source", "acquire", {
          runGit,
          realpath,
        }),
      ).toMatchObject({
        name: "dd-source",
        path: repo,
        poolDir: join(h.repositoryRoot, ".worktree-pools", "dd-source"),
        capacity: 3,
        defaultStartPoint: "refs/remotes/origin/main",
      });
      await git(repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
      const identity = await resolveRepository(
        config,
        "dd-source",
        "identity",
        { runGit, realpath },
      );
      expect(identity).toMatchObject({ name: "dd-source", path: repo });
      expect(identity).not.toHaveProperty("defaultStartPoint");
      expect(
        (
          await runGit(repo, [
            "symbolic-ref",
            "--quiet",
            "refs/remotes/origin/HEAD",
          ])
        ).code,
      ).not.toBe(0);
      expect(
        await resolveRepository(config, "dd-source", "acquire", {
          runGit,
          realpath,
        }),
      ).toMatchObject({
        defaultStartPoint: "refs/remotes/origin/main",
      });
    }));

  test("resolves a bounded per-repository capacity override", async () =>
    withHarness(async (h) => {
      const repo = join(h.repositoryRoot, "dd-source");
      await initRepository(repo);
      await writeConfig(h.configPath, {
        repositories: [{ name: "dd-source", capacity: 5 }],
      });

      const config = await loadPoolConfig(h.configPath, deps(h.home));

      expect(config.defaultCapacity).toBe(3);
      expect(
        await resolveRepository(config, "dd-source", "identity", {
          runGit,
          realpath,
        }),
      ).toMatchObject({
        name: "dd-source",
        path: repo,
        capacity: 5,
      });
    }));

  test("supports nested and dot-prefixed identifiers with explicit start-point overrides", async () =>
    withHarness(async (h) => {
      const nested = join(h.repositoryRoot, "team", "repo");
      await initRepository(nested);
      const dotPrefixed = join(h.repositoryRoot, "..repo");
      await initRepository(dotPrefixed);
      await writeConfig(h.configPath, {
        repositories: [
          { name: "team/repo", defaultStartPoint: "HEAD" },
          { name: "..repo", defaultStartPoint: "HEAD" },
        ],
      });
      const config = await loadPoolConfig(h.configPath, deps(h.home));
      expect(
        await resolveRepository(config, "team/repo", "acquire", {
          runGit,
          realpath,
        }),
      ).toMatchObject({
        name: "team/repo",
        path: nested,
        poolRoot: join(h.repositoryRoot, ".worktree-pools"),
        defaultStartPoint: "HEAD",
      });
      expect(
        await resolveRepository(config, "..repo", "acquire", {
          runGit,
          realpath,
        }),
      ).toMatchObject({
        name: "..repo",
        path: dotPrefixed,
        defaultStartPoint: "HEAD",
      });
    }));

  test("rejects the pool root inside a repository and a repository inside the pool root", async () =>
    withHarness(async (h) => {
      const repository = join(h.repositoryRoot, "repo");
      await initRepository(repository);
      await writeConfig(h.configPath, { root: "~/src/repo/pool" });
      const poolInsideRepository = await loadPoolConfig(
        h.configPath,
        deps(h.home),
      );
      await expect(
        resolveRepository(poolInsideRepository, "repo", "identity", {
          runGit,
          realpath,
        }),
      ).rejects.toThrow("repository must be outside the pool root");

      const nestedInPool = join(
        h.repositoryRoot,
        ".worktree-pools",
        "sources",
        "repo",
      );
      await initRepository(nestedInPool);
      await writeConfig(h.configPath, {
        repositoryRoot: "~/src/.worktree-pools/sources",
      });
      const repositoryInsidePool = await loadPoolConfig(
        h.configPath,
        deps(h.home),
      );
      await expect(
        resolveRepository(repositoryInsidePool, "repo", "identity", {
          runGit,
          realpath,
        }),
      ).rejects.toThrow("repository must be outside the pool root");
    }));

  test("rejects canonical containment in either direction", async () =>
    withHarness(async (h) => {
      const physicalRoot = join(h.dir, "physical-dd");
      const repository = join(physicalRoot, "repo");
      await initRepository(repository);
      await symlink(physicalRoot, join(h.home, "linked-dd"));

      await writeConfig(h.configPath, {
        repositoryRoot: "~/linked-dd",
        root: join(repository, "pool"),
      });
      const poolInsideCanonicalRepository = await loadPoolConfig(
        h.configPath,
        deps(h.home),
      );
      await expect(
        resolveRepository(poolInsideCanonicalRepository, "repo", "identity", {
          runGit,
          realpath,
        }),
      ).rejects.toThrow("repository must be outside the pool root");

      const poolRoot = join(h.dir, "pool");
      const pooledRepositoryRoot = join(poolRoot, "sources");
      const pooledRepository = join(pooledRepositoryRoot, "repo");
      await initRepository(pooledRepository);
      await symlink(pooledRepositoryRoot, join(h.home, "linked-pool-sources"));
      await writeConfig(h.configPath, {
        repositoryRoot: "~/linked-pool-sources",
        root: poolRoot,
      });
      const repositoryInsideCanonicalPool = await loadPoolConfig(
        h.configPath,
        deps(h.home),
      );
      await expect(
        resolveRepository(repositoryInsideCanonicalPool, "repo", "identity", {
          runGit,
          realpath,
        }),
      ).rejects.toThrow("repository must be outside the pool root");
    }));

  test("rejects unsafe identifiers, exact exclusions, and the pool root", async () =>
    withHarness(async (h) => {
      await writeConfig(h.configPath, { exclude: ["team/private"] });
      const config = await loadPoolConfig(h.configPath, deps(h.home));
      for (const identifier of [
        "",
        ".",
        "..",
        "a/../b",
        "a//b",
        "/absolute",
        "team/private",
      ]) {
        await expect(
          resolveRepository(config, identifier, "identity", {
            runGit,
            realpath,
          }),
        ).rejects.toThrow(
          identifier === "team/private" ? "excluded" : "identifier",
        );
      }
      await expect(
        resolveRepository(config, ".worktree-pools", "identity", {
          runGit,
          realpath,
        }),
      ).rejects.toThrow("pool root");
    }));

  test("rejects missing paths, non-Git directories, subdirectories, leaf aliases, canonical escapes, and linked worktrees", async () =>
    withHarness(async (h) => {
      const primary = join(h.repositoryRoot, "primary");
      await initRepository(primary);
      await mkdir(join(primary, "nested"));
      await mkdir(join(h.repositoryRoot, "plain"));
      await symlink(primary, join(h.repositoryRoot, "alias"));
      const outside = join(h.dir, "outside");
      await initRepository(outside);
      await symlink(outside, join(h.repositoryRoot, "escape"));
      await git(primary, ["branch", "linked"]);
      await git(primary, [
        "worktree",
        "add",
        join(h.repositoryRoot, "linked"),
        "linked",
      ]);
      await writeConfig(h.configPath);
      const config = await loadPoolConfig(h.configPath, deps(h.home));
      for (const identifier of [
        "missing",
        "plain",
        "primary/nested",
        "alias",
        "escape",
        "linked",
      ]) {
        await expect(
          resolveRepository(config, identifier, "identity", {
            runGit,
            realpath,
          }),
        ).rejects.toThrow();
      }
    }));

  test("fetches the target of a dangling remote HEAD", async () =>
    withHarness(async (h) => {
      const repo = join(h.repositoryRoot, "repo");
      await initRepository(repo);
      await writeConfig(h.configPath);
      const config = await loadPoolConfig(h.configPath, deps(h.home));
      const head = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);

      expect(
        await resolveRepository(config, "repo", "acquire", {
          runGit,
          realpath,
        }),
      ).toMatchObject({
        defaultStartPoint: "refs/remotes/origin/main",
      });
      expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(
        head,
      );
    }));

  test("discovers and restores a missing remote HEAD", async () =>
    withHarness(async (h) => {
      const repo = join(h.repositoryRoot, "repo");
      await initRepository(repo);
      await writeConfig(h.configPath);
      const config = await loadPoolConfig(h.configPath, deps(h.home));
      const head = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
      await git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);

      expect(
        await resolveRepository(config, "repo", "acquire", {
          runGit,
          realpath,
        }),
      ).toMatchObject({
        defaultStartPoint: "refs/remotes/origin/main",
      });
      expect(
        await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
      ).toBe("refs/remotes/origin/main");
      expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(
        head,
      );
    }));

  test("reports remote HEAD discovery failures", async () =>
    withHarness(async (h) => {
      const repo = join(h.repositoryRoot, "repo");
      await initRepository(repo);
      await writeConfig(h.configPath);
      const config = await loadPoolConfig(h.configPath, deps(h.home));
      await git(repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
      await git(repo, ["remote", "remove", "origin"]);

      await expect(
        resolveRepository(config, "repo", "acquire", { runGit, realpath }),
      ).rejects.toThrow("ls-remote --symref origin HEAD");
    }));

  test("rejects legacy fields, capacities outside the bounded range, and unknown fields", async () =>
    withHarness(async (h) => {
      for (const value of [
        { version: 1 },
        { defaultSlots: 3 },
        { defaultCapacity: 2 },
        { repositories: [{ name: "repo", slots: 3 }] },
        { repositories: [{ name: "repo", capacity: 6 }] },
        { repositories: [{ name: "repo", capacity: 3.5 }] },
        { unexpected: true },
      ]) {
        await writeConfig(h.configPath, value);
        await expect(
          loadPoolConfig(h.configPath, deps(h.home)),
        ).rejects.toThrow();
      }
    }));
});
