import { describe, expect, test } from "../../tests/expect.js";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { createLeaseRecord } from "./lease-records.js";
import { WorktreePool } from "./pool.js";
import type { OwnerIdentity } from "./operation-lock.js";
import type { GitRunner, ResolvedRepository } from "./types.js";

const execFileAsync = promisify(execFile);
const UUIDS = [
  "123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174001",
  "323e4567-e89b-42d3-a456-426614174002",
  "423e4567-e89b-42d3-a456-426614174003",
  "523e4567-e89b-42d3-a456-426614174004",
  "623e4567-e89b-42d3-a456-426614174005",
  "723e4567-e89b-42d3-a456-426614174006",
  "823e4567-e89b-42d3-a456-426614174007",
  "923e4567-e89b-42d3-a456-426614174008",
  "a23e4567-e89b-42d3-a456-426614174009",
];

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

function owner(pid: number, sessionId: string): OwnerIdentity {
  return {
    pid,
    sessionId,
    host: "test-host",
    started: 1_788_123_456_000 + pid,
  };
}

async function createHarness(
  options: {
    capacity?: number;
    afterNativeLock?: (path: string) => Promise<void>;
    interceptGit?: (
      args: string[],
    ) => { code: number; stdout: string; stderr: string } | undefined;
    removeLeaseRecord?: (root: string, claimId: string) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ephemeral-pool-"));
  const primary = join(root, "repo");
  const poolRoot = join(root, "pool");
  await mkdir(primary);
  await mkdir(poolRoot);
  await git(primary, ["init", "-b", "main"]);
  await git(primary, ["config", "user.name", "Pi Test"]);
  await git(primary, ["config", "user.email", "pi@example.com"]);
  await writeFile(join(primary, "README.md"), "seed\n");
  await git(primary, ["add", "README.md"]);
  await git(primary, ["commit", "-m", "seed"]);
  const repository: ResolvedRepository = {
    name: "repo",
    path: primary,
    canonicalPath: await realpath(primary),
    commonDir: await git(primary, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    poolRoot,
    poolDir: join(poolRoot, "repo"),
    capacity: options.capacity ?? 3,
    defaultStartPoint: "main",
  };
  let next = 0;
  const poolRunGit: GitRunner = async (cwd, args) =>
    options.interceptGit?.(args) ?? runGit(cwd, args);
  const pool = new WorktreePool({
    repositories: [repository],
    runGit: poolRunGit,
    operationLock: {
      now: Date.now,
      sleep: async () => {},
      isPidAlive: () => "live",
      hostname: "test-host",
      timeoutMs: 1_000,
    },
    uuid: () => UUIDS[next++] ?? crypto.randomUUID(),
    ...(options.removeLeaseRecord
      ? { removeLeaseRecord: options.removeLeaseRecord }
      : {}),
    ...(options.afterNativeLock
      ? {
          afterNativeLock: async (path: string) =>
            options.afterNativeLock!(path),
        }
      : {}),
  });
  return {
    root,
    primary,
    poolRoot,
    repository,
    pool,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function managedRegistrations(primary: string): Promise<string[]> {
  const porcelain = await git(primary, ["worktree", "list", "--porcelain"]);
  return porcelain
    .split("\n")
    .filter(
      (line) => line.startsWith("worktree ") && line.includes("worktree-"),
    )
    .sort();
}

async function leaseFiles(poolRoot: string): Promise<string[]> {
  try {
    return (await readdir(join(poolRoot, ".leases"))).sort();
  } catch {
    return [];
  }
}

describe("bounded allocation", () => {
  test("uses supplied opaque identities and lists complete observations", async () => {
    const h = await createHarness();
    try {
      const identity = { claimId: UUIDS[8], pathId: UUIDS[9] };
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "observed" },
        owner(100, "alice"),
        identity,
      );
      expect(acquired.claimId).toBe(identity.claimId);
      expect(basename(acquired.path)).toBe(`worktree-${identity.pathId}`);

      const [listed] = (await h.pool.list("repo")).repositories[0].worktrees;
      expect(listed).toMatchObject({
        claimId: identity.claimId,
        currentBranch: "observed",
        head: acquired.head,
        clean: true,
        branchProtectsHead: true,
      });
    } finally {
      await h.cleanup();
    }
  });

  test("rejects invalid supplied identities before reserving capacity", async () => {
    const h = await createHarness();
    try {
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "invalid-identity" },
          owner(100, "alice"),
          { claimId: "not-safe", pathId: UUIDS[9] },
        ),
      ).rejects.toThrow("claim ID");
      expect(await leaseFiles(h.poolRoot)).toEqual([]);
      expect(await managedRegistrations(h.primary)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("allows one session to acquire distinct worktrees up to capacity", async () => {
    const h = await createHarness();
    try {
      const alice = owner(101, "alice");
      const first = await h.pool.acquire(
        { repository: "repo", branch: "feature-one" },
        alice,
      );
      const second = await h.pool.acquire(
        { repository: "repo", branch: "feature-two" },
        alice,
      );
      expect(basename(first.path)).toMatch(/^worktree-[0-9a-f-]{36}$/);
      expect(first.path).not.toBe(second.path);
      expect(first.reused).toBe(false);
      expect(second.reused).toBe(false);
      expect(await managedRegistrations(h.primary)).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  test("preserves an existing branch and reports its selected HEAD relationship", async () => {
    const h = await createHarness();
    try {
      await git(h.primary, ["switch", "-c", "existing"]);
      await writeFile(join(h.primary, "existing.txt"), "branch commit\n");
      await git(h.primary, ["add", "existing.txt"]);
      await git(h.primary, ["commit", "-m", "existing branch"]);
      const existingHead = await git(h.primary, ["rev-parse", "HEAD"]);
      await git(h.primary, ["switch", "main"]);
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "existing" },
        owner(102, "alice"),
      );
      expect(acquired.head).toBe(existingHead);
      expect(acquired.relationship).toBe("contains-start-point");
    } finally {
      await h.cleanup();
    }
  });

  test("rejects option-like branches and revisions before reserving capacity", async () => {
    const h = await createHarness();
    try {
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "-bad" },
          owner(103, "alice"),
        ),
      ).rejects.toThrow("invalid branch");
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "feature", startPoint: "--help" },
          owner(103, "alice"),
        ),
      ).rejects.toThrow();
      expect(await managedRegistrations(h.primary)).toEqual([]);
      expect(await leaseFiles(h.poolRoot)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("serializes concurrent owners and creates nothing beyond exact capacity", async () => {
    const h = await createHarness({ capacity: 3 });
    try {
      const results = await Promise.all(
        [1, 2, 3].map((pid) =>
          h.pool.acquire(
            { repository: "repo", branch: `feature-${pid}` },
            owner(200 + pid, `owner-${pid}`),
          ),
        ),
      );
      expect(new Set(results.map((result) => result.path)).size).toBe(3);
      const before = {
        registrations: await managedRegistrations(h.primary),
        leases: await leaseFiles(h.poolRoot),
        branches: await git(h.primary, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads",
        ]),
      };
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "feature-4" },
          owner(204, "owner-4"),
        ),
      ).rejects.toThrow(/capacity.*3.*used/i);
      expect(await managedRegistrations(h.primary)).toEqual(
        before.registrations,
      );
      expect(await leaseFiles(h.poolRoot)).toEqual(before.leases);
      expect(
        await git(h.primary, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads",
        ]),
      ).toBe(before.branches);
      const listing = await h.pool.list("repo");
      expect(listing.repositories[0]).toMatchObject({ capacity: 3, used: 3 });
    } finally {
      await h.cleanup();
    }
  }, 30_000);

  test("preserves post-reservation failures without rollback", async () => {
    let removalCalls = 0;
    const h = await createHarness({
      afterNativeLock: async () => {
        throw new Error("injected invariant failure");
      },
      interceptGit: (args) => {
        if (args[0] === "worktree" && args[1] === "remove") removalCalls += 1;
        return undefined;
      },
    });
    try {
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "feature" },
          owner(300, "alice"),
        ),
      ).rejects.toThrow("claim preserved as needs-attention");
      expect(removalCalls).toBe(0);
      expect(await leaseFiles(h.poolRoot)).toHaveLength(1);
      expect(await managedRegistrations(h.primary)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("clears a reservation only when worktree creation left no path or registration", async () => {
    const h = await createHarness({
      interceptGit: (args) =>
        args[0] === "worktree" && args[1] === "add"
          ? { code: 1, stdout: "", stderr: "injected add failure" }
          : undefined,
    });
    try {
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "feature" },
          owner(301, "alice"),
        ),
      ).rejects.toThrow("new worktree and journal removed");
      expect(await leaseFiles(h.poolRoot)).toEqual([]);
      expect(await managedRegistrations(h.primary)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("preserves the reservation when failed-acquire journal deletion fails", async () => {
    const h = await createHarness({
      interceptGit: (args) =>
        args[0] === "worktree" && args[1] === "add"
          ? { code: 1, stdout: "", stderr: "injected add failure" }
          : undefined,
      removeLeaseRecord: async () => {
        throw new Error("injected journal deletion failure");
      },
    });
    try {
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "feature" },
          owner(302, "alice"),
        ),
      ).rejects.toThrow("claim preserved as needs-attention");
      expect(await leaseFiles(h.poolRoot)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("counts every unindexed registration beneath the managed directory", async () => {
    const h = await createHarness({ capacity: 3 });
    try {
      const rogue = join(h.repository.poolDir, "nested", "rogue");
      await mkdir(join(h.repository.poolDir, "nested"), { recursive: true });
      await git(h.primary, ["worktree", "add", "--detach", rogue, "main"]);
      const listing = await h.pool.list("repo");
      expect(listing.repositories[0]).toMatchObject({ capacity: 3, used: 1 });
      expect(listing.repositories[0].worktrees).toContainEqual(
        expect.objectContaining({
          path: await realpath(rogue),
          state: "needs-attention",
        }),
      );
      await h.pool.acquire(
        { repository: "repo", branch: "first" },
        owner(307, "first"),
      );
      await h.pool.acquire(
        { repository: "repo", branch: "second" },
        owner(308, "second"),
      );
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "blocked" },
          owner(309, "blocked"),
        ),
      ).rejects.toThrow("unindexed managed registration");
    } finally {
      await h.cleanup();
    }
  });

  test("lists, counts, and repairs a reservation whose managed parent is absent", async () => {
    const h = await createHarness({ capacity: 3 });
    try {
      const claimId = UUIDS[6];
      const pathId = UUIDS[7];
      const path = join(h.repository.poolDir, `worktree-${pathId}`);
      const records = [
        { claimId, pathId, path, branch: "reserved" },
        ...["reserved-two", "reserved-three"].map((branch) => {
          const nextClaimId = crypto.randomUUID();
          const nextPathId = crypto.randomUUID();
          return {
            claimId: nextClaimId,
            pathId: nextPathId,
            path: join(h.repository.poolDir, `worktree-${nextPathId}`),
            branch,
          };
        }),
      ];
      for (const record of records)
        await createLeaseRecord(h.poolRoot, {
          version: 1,
          ...record,
          repository: "repo",
          repositoryCommonDir: h.repository.commonDir,
          sessionId: "crashed",
          host: "test-host",
          pid: 999,
          started: 1,
          state: "creating",
        });
      expect(await exists(h.repository.poolDir)).toBe(false);
      const listing = await h.pool.list("repo");
      expect(listing.repositories[0]).toMatchObject({ used: 3 });
      expect(listing.repositories[0].worktrees).toContainEqual(
        expect.objectContaining({ claimId, path, state: "needs-attention" }),
      );
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "blocked" },
          owner(309, "blocked"),
        ),
      ).rejects.toThrow(/capacity.*used/i);
      expect(
        await h.pool.repair("repo", claimId, owner(309, "repair")),
      ).toMatchObject({ repaired: true, state: "available" });
    } finally {
      await h.cleanup();
    }
  });

  test("counts managed Git registrations missing discovery records", async () => {
    const h = await createHarness({ capacity: 3 });
    try {
      await h.pool.acquire(
        { repository: "repo", branch: "orphan" },
        owner(310, "orphan"),
      );
      const [record] = await leaseFiles(h.poolRoot);
      await rm(join(h.poolRoot, ".leases", record));
      await h.pool.acquire(
        { repository: "repo", branch: "second" },
        owner(311, "second"),
      );
      await h.pool.acquire(
        { repository: "repo", branch: "third" },
        owner(312, "third"),
      );
      const listing = await h.pool.list("repo");
      expect(listing.repositories[0]).toMatchObject({ used: 3 });
      expect(listing.repositories[0].worktrees).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: "needs-attention",
            reason: expect.stringContaining("no valid discovery record"),
          }),
        ]),
      );
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "blocked" },
          owner(313, "blocked"),
        ),
      ).rejects.toThrow("unindexed managed registration");
    } finally {
      await h.cleanup();
    }
  });

  test("never automatically reclaims full capacity", async () => {
    const h = await createHarness({ capacity: 3 });
    try {
      const first = await h.pool.acquire(
        { repository: "repo", branch: "stale" },
        owner(320, "stale"),
      );
      await h.pool.acquire(
        { repository: "repo", branch: "second" },
        owner(321, "second"),
      );
      await h.pool.acquire(
        { repository: "repo", branch: "third" },
        owner(322, "third"),
      );
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "blocked" },
          owner(323, "blocked"),
        ),
      ).rejects.toThrow(/capacity.*used/i);
      expect(await exists(first.path)).toBe(true);
      expect(await managedRegistrations(h.primary)).toHaveLength(3);
    } finally {
      await h.cleanup();
    }
  });

  test("keeps malformed records capacity-consuming", async () => {
    const h = await createHarness({ capacity: 3 });
    try {
      await h.pool.acquire(
        { repository: "repo", branch: "first" },
        owner(330, "first"),
      );
      await h.pool.acquire(
        { repository: "repo", branch: "second" },
        owner(331, "second"),
      );
      await writeFile(
        join(h.poolRoot, ".leases", "malformed.json"),
        "not-json\n",
      );
      await expect(
        h.pool.acquire(
          { repository: "repo", branch: "blocked" },
          owner(332, "blocked"),
        ),
      ).rejects.toThrow(/capacity.*used/i);
    } finally {
      await h.cleanup();
    }
  });
});

describe("bearer-capability lifecycle", () => {
  test("releases a clean exact claim from another session and preserves the branch", async () => {
    const h = await createHarness();
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "clean" },
        owner(401, "alice"),
      );
      expect(
        (await h.pool.release("repo", acquired.claimId, owner(999, "other")))
          .released,
      ).toBe(true);
      expect(
        await git(h.primary, ["show-ref", "--verify", "refs/heads/clean"]),
      ).not.toBe("");
      expect(await leaseFiles(h.poolRoot)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  test("preserves dirty files", async () => {
    const h = await createHarness();
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "dirty" },
        owner(402, "alice"),
      );
      await writeFile(join(acquired.path, "keep.txt"), "preserve\n");
      expect(
        (await h.pool.release("repo", acquired.claimId, owner(999, "other")))
          .released,
      ).toBe(false);
      expect(await readFile(join(acquired.path, "keep.txt"), "utf8")).toBe(
        "preserve\n",
      );
    } finally {
      await h.cleanup();
    }
  });

  test("preserves a worktree whose branch contradicts the claim", async () => {
    const h = await createHarness();
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "expected" },
        owner(403, "alice"),
      );
      await git(acquired.path, ["switch", "-c", "other"]);
      expect(
        (await h.pool.release("repo", acquired.claimId, owner(999, "other")))
          .released,
      ).toBe(false);
      expect(await git(acquired.path, ["branch", "--show-current"])).toBe(
        "other",
      );
      expect(await leaseFiles(h.poolRoot)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("preserves a worktree whose native lock contradicts the claim", async () => {
    const h = await createHarness();
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "expected" },
        owner(404, "alice"),
      );
      await git(h.primary, ["worktree", "unlock", acquired.path]);
      await git(h.primary, [
        "worktree",
        "lock",
        "--reason",
        `pi-pool/v2 claim=${UUIDS[7]} pid=404 session=alice host=test-host started=1788123456404`,
        acquired.path,
      ]);
      expect(
        (await h.pool.release("repo", acquired.claimId, owner(999, "other")))
          .released,
      ).toBe(false);
      expect(await managedRegistrations(h.primary)).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  test("preserves an unlocked removing claim without compensation when ordinary removal fails", async () => {
    let failRemoval = false;
    const h = await createHarness({
      interceptGit: (args) =>
        failRemoval && args[0] === "worktree" && args[1] === "remove"
          ? { code: 1, stdout: "", stderr: "injected remove failure" }
          : undefined,
    });
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "feature" },
        owner(405, "alice"),
      );
      failRemoval = true;
      await expect(
        h.pool.release("repo", acquired.claimId, owner(999, "other")),
      ).rejects.toThrow(
        /injected remove failure.*claim preserved as removing/s,
      );
      const gitListing = await git(h.primary, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      expect(gitListing).not.toContain(
        `locked pi-pool/v2 claim=${acquired.claimId}`,
      );
      const [record] = await leaseFiles(h.poolRoot);
      expect(
        JSON.parse(await readFile(join(h.poolRoot, ".leases", record), "utf8")),
      ).toMatchObject({
        claimId: acquired.claimId,
        state: "removing",
      });
    } finally {
      await h.cleanup();
    }
  });

  test("list and repair expose exact recovery evidence and bearer claim ID", async () => {
    const h = await createHarness();
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "inspect" },
        owner(406, "alice"),
      );
      const listing = await h.pool.list("repo");
      expect(listing.repositories[0].worktrees[0]).toMatchObject({
        claimId: acquired.claimId,
        path: acquired.path,
        branch: "inspect",
        state: "active",
        evidence: {
          pathExists: true,
          registered: true,
          nativeClaimMatches: true,
        },
      });
      const report = await h.pool.repair(
        "repo",
        acquired.claimId,
        owner(999, "other"),
      );
      expect(report).toMatchObject({
        claimId: acquired.claimId,
        repaired: false,
        evidence: {
          pathExists: true,
          registered: true,
          nativeClaimMatches: true,
        },
      });
      expect(report.reason).toContain("worktree_pool release");
    } finally {
      await h.cleanup();
    }
  });

  test("shows the record claim ID when the native claim contradicts it", async () => {
    const h = await createHarness();
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "inspect" },
        owner(407, "alice"),
      );
      await git(h.primary, ["worktree", "unlock", acquired.path]);
      const listing = await h.pool.list("repo");
      expect(listing.repositories[0].worktrees[0]).toMatchObject({
        claimId: acquired.claimId,
        evidence: {
          pathExists: true,
          registered: true,
          nativeClaimMatches: false,
        },
      });
    } finally {
      await h.cleanup();
    }
  });

  test("repairs only metadata whose path and registration are absent", async () => {
    const h = await createHarness();
    try {
      const acquired = await h.pool.acquire(
        { repository: "repo", branch: "repair" },
        owner(406, "alice"),
      );
      await git(h.primary, ["worktree", "unlock", acquired.path]);
      await git(h.primary, ["worktree", "remove", acquired.path]);
      expect(
        await h.pool.repair("repo", acquired.claimId, owner(999, "other")),
      ).toMatchObject({ repaired: true, state: "available" });
      expect(await leaseFiles(h.poolRoot)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
});
