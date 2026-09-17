import type { OwnerIdentity } from "./operation-lock.js";
import type { GitRunner, ResolvedRepository } from "./types.js";

export type ClaimRecord = {
  claimId: string;
  pid: number;
  sessionId: string;
  host: string;
  started: number;
};

const CLAIM_PREFIX = "pi-pool/v2";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,254}$/;
const FIELD_NAMES = ["claim", "pid", "session", "host", "started"] as const;

export function formatClaimReason(
  claimId: string,
  owner: OwnerIdentity,
): string {
  if (!UUID_PATTERN.test(claimId))
    throw new Error(`invalid claim ID ${JSON.stringify(claimId)}`);
  validatePositiveInteger(owner.pid, "owner pid");
  validateToken(owner.sessionId, "owner session ID");
  validateToken(owner.host, "owner host");
  if (!Number.isSafeInteger(owner.started) || owner.started < 0) {
    throw new Error(`invalid owner started time ${owner.started}`);
  }
  return `${CLAIM_PREFIX} claim=${claimId} pid=${owner.pid} session=${owner.sessionId} host=${owner.host} started=${owner.started}`;
}

export function parseClaimReason(reason: string): ClaimRecord | undefined {
  const parts = reason.split(" ");
  if (parts.length !== FIELD_NAMES.length + 1 || parts[0] !== CLAIM_PREFIX)
    return undefined;

  const fields = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) return undefined;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (
      !FIELD_NAMES.includes(key as (typeof FIELD_NAMES)[number]) ||
      fields.has(key)
    )
      return undefined;
    fields.set(key, value);
  }
  if (FIELD_NAMES.some((name) => !fields.has(name))) return undefined;

  const claimId = fields.get("claim")!;
  const pidText = fields.get("pid")!;
  const sessionId = fields.get("session")!;
  const host = fields.get("host")!;
  const startedText = fields.get("started")!;
  if (
    !UUID_PATTERN.test(claimId) ||
    !TOKEN_PATTERN.test(sessionId) ||
    !TOKEN_PATTERN.test(host)
  )
    return undefined;
  if (!/^[1-9][0-9]*$/.test(pidText) || !/^(0|[1-9][0-9]*)$/.test(startedText))
    return undefined;
  const pid = Number(pidText);
  const started = Number(startedText);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(started))
    return undefined;
  return { claimId, pid, sessionId, host, started };
}

export async function tryLockWorktree(
  repository: ResolvedRepository,
  slotPath: string,
  claimId: string,
  owner: OwnerIdentity,
  runGit: GitRunner,
): Promise<boolean> {
  const reason = formatClaimReason(claimId, owner);
  const result = await runGit(repository.path, [
    "worktree",
    "lock",
    "--reason",
    reason,
    slotPath,
  ]);
  return result.code === 0;
}

export async function unlockWorktree(
  repository: ResolvedRepository,
  slotPath: string,
  runGit: GitRunner,
): Promise<void> {
  const args = ["worktree", "unlock", slotPath];
  const result = await runGit(repository.path, args);
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "git command failed";
    throw new Error(
      `git ${args.join(" ")} failed in ${repository.path}: ${detail}`,
    );
  }
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`invalid ${field} ${value}`);
}

function validateToken(value: string, field: string): void {
  if (!TOKEN_PATTERN.test(value))
    throw new Error(`invalid ${field} ${JSON.stringify(value)}`);
}
