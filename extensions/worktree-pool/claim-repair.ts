import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { parseClaimReason, tryLockWorktree } from "./claim.js";
import { replaceLeaseRecord, type LeaseRecord } from "./lease-records.js";
import { verifyManagedWorktree } from "./managed-worktree.js";
import type { GitRunner, ResolvedRepository } from "./types.js";

export interface ClaimRepairSnapshot {
  record: LeaseRecord;
  head: string;
  nativeLock: "matching" | "absent";
}

export interface ClaimRepairTransaction {
  inspect(): Promise<ClaimRepairSnapshot[]>;
  restore(snapshot: ClaimRepairSnapshot): Promise<ClaimRepairSnapshot>;
}

export class ClaimRepairError extends Error {
  constructor(claimId: string, reason: string) {
    super(`Cannot repair claim ${claimId}: ${reason}`);
  }
}

export async function inspectRepairClaim(
  repository: ResolvedRepository,
  record: LeaseRecord,
  runGit: GitRunner,
): Promise<ClaimRepairSnapshot> {
  const refuse = (reason: string): never => {
    throw new ClaimRepairError(record.claimId, reason);
  };
  if (record.state !== "active" && record.state !== "removing")
    refuse("unsupported pool state");
  if (
    record.repository !== repository.name ||
    basename(record.path) !== `worktree-${record.pathId}`
  )
    refuse("contradictory path or repository identity");
  if (
    (await realpath(record.repositoryCommonDir)) !==
    (await realpath(repository.commonDir))
  )
    refuse("contradictory Git common directory");
  const worktree = await verifyManagedWorktree(repository, record.path, {
    runGit,
  });
  if (
    worktree.branch !== `refs/heads/${record.branch}` ||
    worktree.head === undefined
  )
    refuse("branch or HEAD changed");
  const status = await runGit(record.path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  if (status.code !== 0) refuse("cleanliness cannot be verified");
  if (status.stdout.trim() !== "") refuse("worktree or submodule is dirty");
  const branchHead = await runGit(record.path, [
    "rev-parse",
    `refs/heads/${record.branch}`,
  ]);
  if (branchHead.code !== 0 || branchHead.stdout.trim() !== worktree.head)
    refuse("recorded branch does not protect HEAD");
  let nativeLock: ClaimRepairSnapshot["nativeLock"] = "absent";
  if (worktree.lockedReason !== undefined) {
    const claim = parseClaimReason(worktree.lockedReason);
    if (
      !isDeepStrictEqual(claim, {
        claimId: record.claimId,
        pid: record.pid,
        sessionId: record.sessionId,
        host: record.host,
        started: record.started,
      })
    )
      refuse("native ownership belongs to another claim or is unverifiable");
    nativeLock = "matching";
  } else if (record.state !== "removing") {
    refuse("an active claim has no matching native owner");
  }
  return { record, head: worktree.head!, nativeLock };
}

export async function restoreRepairClaim(
  repository: ResolvedRepository,
  expected: ClaimRepairSnapshot,
  readRecord: () => Promise<LeaseRecord>,
  runGit: GitRunner,
): Promise<ClaimRepairSnapshot> {
  const current = await inspectRepairClaim(
    repository,
    await readRecord(),
    runGit,
  );
  if (!isDeepStrictEqual(current, expected))
    throw new ClaimRepairError(
      expected.record.claimId,
      "state changed during repair",
    );
  if (current.record.state === "active") return current;
  if (current.nativeLock === "absent") {
    const locked = await tryLockWorktree(
      repository,
      current.record.path,
      current.record.claimId,
      current.record,
      runGit,
    );
    if (!locked)
      throw new ClaimRepairError(
        current.record.claimId,
        "native lock could not be restored; inspect before retrying",
      );
    const lockedState = await inspectRepairClaim(
      repository,
      await readRecord(),
      runGit,
    );
    if (!isDeepStrictEqual(lockedState, { ...current, nativeLock: "matching" }))
      throw new ClaimRepairError(
        current.record.claimId,
        "state changed after native lock restoration",
      );
  }
  await replaceLeaseRecord(repository.poolRoot, current.record.claimId, {
    ...current.record,
    state: "active",
  });
  return inspectRepairClaim(repository, await readRecord(), runGit);
}
