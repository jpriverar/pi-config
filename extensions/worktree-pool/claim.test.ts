import { describe, expect, test } from "../../tests/expect.js";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatClaimReason,
  parseClaimReason,
  tryLockWorktree,
  unlockWorktree,
} from "./claim.js";
import type { OwnerIdentity } from "./operation-lock.js";
import type { GitRunner, ResolvedRepository } from "./types.js";

const CLAIM_ID = "123e4567-e89b-42d3-a456-426614174000";
const NEXT_CLAIM_ID = "223e4567-e89b-42d3-a456-426614174001";
const owner: OwnerIdentity = {
  pid: 1234,
  sessionId: "session-1",
  host: "test-host",
  started: 1_723_456_789_987,
};

const runGit: GitRunner = async (cwd, args) =>
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) return reject(new Error(`git terminated with ${signal}`));
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function withRepository<T>(
  fn: (repository: ResolvedRepository, slot: string) => Promise<T>,
) {
  const root = await mkdtemp(join(tmpdir(), "pool-claim-"));
  try {
    const repositoryPath = join(root, "repo");
    const slot = join(root, "slot");
    await mkdir(repositoryPath);
    await git(repositoryPath, ["init", "-b", "main"]);
    await git(repositoryPath, ["config", "user.name", "Pi Test"]);
    await git(repositoryPath, ["config", "user.email", "pi@example.com"]);
    await writeFile(join(repositoryPath, "README.md"), "seed\n");
    await git(repositoryPath, ["add", "README.md"]);
    await git(repositoryPath, ["commit", "-m", "seed"]);
    await git(repositoryPath, ["worktree", "add", "--detach", slot, "main"]);
    const repository: ResolvedRepository = {
      name: "repo",
      path: repositoryPath,
      canonicalPath: await realpath(repositoryPath),
      commonDir: await git(repositoryPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      poolRoot: root,
      poolDir: root,
      capacity: 3,
      defaultStartPoint: "main",
    };
    return await fn(repository, slot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("diagnostic claim reasons", () => {
  test("preserves the schema-2 native lock format", () => {
    const reason = formatClaimReason(CLAIM_ID, owner);
    expect(reason).toBe(
      "pi-pool/v2 claim=123e4567-e89b-42d3-a456-426614174000 pid=1234 session=session-1 host=test-host started=1723456789987",
    );
    expect(parseClaimReason(reason)).toEqual({
      claimId: CLAIM_ID,
      pid: 1234,
      sessionId: "session-1",
      host: "test-host",
      started: 1_723_456_789_987,
    });
  });

  test.each([
    "foreign owner",
    "pi-pool/v1 claim=123e4567-e89b-42d3-a456-426614174000 pid=1 session=s host=h started=1",
    "pi-pool/v2 claim=nope pid=1 session=s host=h started=1",
    "pi-pool/v2 claim=123e4567-e89b-42d3-a456-426614174000 pid=0 session=s host=h started=1",
    "pi-pool/v2 claim=123e4567-e89b-42d3-a456-426614174000 pid=1 session=s host=h started=-1",
    "pi-pool/v2 claim=123e4567-e89b-42d3-a456-426614174000 pid=1 session=s host=h started=1 extra=x",
  ])("rejects malformed or foreign reason %s", (reason) => {
    expect(parseClaimReason(reason)).toBeUndefined();
  });
});

describe("native Git claim primitives", () => {
  test("uses native lock contention and preserves the exact diagnostic reason", async () => {
    await withRepository(async (repository, slot) => {
      expect(
        await tryLockWorktree(repository, slot, CLAIM_ID, owner, runGit),
      ).toBe(true);
      expect(
        await tryLockWorktree(
          repository,
          slot,
          NEXT_CLAIM_ID,
          { ...owner, pid: 2345 },
          runGit,
        ),
      ).toBe(false);
      expect(
        await git(repository.path, ["worktree", "list", "--porcelain"]),
      ).toContain(`locked ${formatClaimReason(CLAIM_ID, owner)}`);
      await unlockWorktree(repository, slot, runGit);
      expect(
        await tryLockWorktree(
          repository,
          slot,
          NEXT_CLAIM_ID,
          { ...owner, pid: 2345 },
          runGit,
        ),
      ).toBe(true);
    });
  }, 20_000);
});
