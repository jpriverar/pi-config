import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { isValidPoolCapacity, POOL_CAPACITY_REQUIREMENT } from "./capacity.js";
import {
  formatClaimReason,
  parseClaimReason,
  type ClaimRecord,
  tryLockWorktree,
  unlockWorktree,
} from "./claim.js";
import {
  createLeaseRecord,
  listRepositoryLeaseRecords,
  removeLeaseRecord,
  replaceLeaseRecord,
  type LeaseRecord,
  type LeaseRecordGate,
} from "./lease-records.js";
import { inspectRepository } from "./git-state.js";
import {
  createManagedWorktree,
  managedWorktreePath,
  removeManagedWorktree,
  verifyManagedWorktree,
} from "./managed-worktree.js";
import {
  withOperationLock,
  type OperationLockDependencies,
  type OwnerIdentity,
} from "./operation-lock.js";
import type {
  GitRunner,
  RegisteredWorktree,
  ResolvedRepository,
} from "./types.js";

export type AcquireRequest = {
  repository: string;
  branch: string;
  startPoint?: string;
};
export type StartPointRelationship =
  | "equal"
  | "contains-start-point"
  | "behind-start-point"
  | "diverged";
export type AcquireResult = {
  claimId: string;
  path: string;
  branch: string;
  reused: boolean;
  head: string;
  startPoint: string;
  startPointHead: string;
  startPointFetched: boolean;
  relationship: StartPointRelationship;
};
type ResolvedStartPoint = { ref: string; head: string; fetched: boolean };
type LeaseObservation = {
  evidence: PoolStateEvidence;
  currentBranch: string | null;
  head: string | null;
  clean: boolean | null;
  branchProtectsHead: boolean | null;
  authorityError?: string;
};
export type ReleaseResult = { path: string; released: boolean };
export type PoolStateEvidence = {
  pathExists: boolean | null;
  registered: boolean | null;
  nativeClaimMatches: boolean | null;
};
export type PoolWorktreeListing = {
  claimId?: string;
  path: string;
  state: string;
  branch?: string;
  currentBranch: string | null;
  head: string | null;
  clean: boolean | null;
  branchProtectsHead: boolean | null;
  reason?: string;
  evidence: PoolStateEvidence;
};
export type PoolListing = {
  repositories: Array<{
    name: string;
    capacity: number;
    used: number;
    worktrees: PoolWorktreeListing[];
  }>;
};
export type RepairReport = {
  claimId?: string;
  path: string;
  repaired: boolean;
  state: string;
  evidence: PoolStateEvidence;
  reason?: string;
};
export type WorktreePoolDependencies = {
  repositories: ResolvedRepository[];
  runGit: GitRunner;
  operationLock: OperationLockDependencies;
  uuid?: () => string;
  afterNativeLock?: (path: string, claimId: string) => Promise<void>;
  replaceLeaseRecord?: (
    root: string,
    expectedClaimId: string,
    record: LeaseRecord,
  ) => Promise<void>;
  removeLeaseRecord?: (root: string, claimId: string) => Promise<void>;
};

export class WorktreePool {
  constructor(private readonly deps: WorktreePoolDependencies) {}

  async list(repository?: string): Promise<PoolListing> {
    const repositories =
      repository === undefined
        ? this.deps.repositories
        : [this.repository(repository)];
    return {
      repositories: await Promise.all(
        repositories.map(async (candidate) => {
          const worktrees = await this.listRecords(candidate);
          return {
            name: candidate.name,
            capacity: candidate.capacity,
            used: worktrees.length,
            worktrees,
          };
        }),
      ),
    };
  }

  async acquire(
    request: AcquireRequest,
    owner: OwnerIdentity,
    identity: { claimId: string; pathId: string } = {
      claimId: this.uuid(),
      pathId: this.uuid(),
    },
  ): Promise<AcquireResult> {
    validateBranch(request.branch);
    const repository = this.repository(request.repository);
    formatClaimReason(identity.claimId, owner);
    const path = managedWorktreePath(repository, identity.pathId);
    if (!isValidPoolCapacity(repository.capacity)) {
      throw new Error(
        `invalid pool capacity ${repository.capacity}: ${POOL_CAPACITY_REQUIREMENT}`,
      );
    }
    return withOperationLock(
      repository,
      owner,
      async () => {
        await this.validateBranchWithGit(repository, request.branch);
        const startPoint = await this.resolveStartPoint(repository, request);
        const gates = await listRepositoryLeaseRecords(
          repository.poolRoot,
          repository.name,
        );
        const unindexed = await this.countUnindexedManagedRegistrations(
          repository,
          gates,
        );
        const used = gates.length + unindexed;
        if (used >= repository.capacity) {
          const states = gates.map((gate) =>
            gate.state === "valid"
              ? `${gate.record.branch}:${gate.record.state}`
              : `ambiguous:${gate.reason}`,
          );
          if (unindexed > 0)
            states.push(
              `${unindexed} unindexed managed registration${unindexed === 1 ? "" : "s"}`,
            );
          throw new Error(
            `pool ${repository.name} capacity ${repository.capacity} is fully used (${used} used): ${states.join(", ")}`,
          );
        }

        const { claimId, pathId } = identity;
        const creating: LeaseRecord = {
          version: 1,
          claimId,
          pathId,
          repository: repository.name,
          repositoryCommonDir: repository.commonDir,
          path,
          branch: request.branch,
          sessionId: owner.sessionId,
          host: owner.host,
          pid: owner.pid,
          started: owner.started,
          state: "creating",
        };
        await createLeaseRecord(repository.poolRoot, creating);
        try {
          const creation = await createManagedWorktree(
            {
              repository,
              pathId,
              branch: request.branch,
              startPointHead: startPoint.head,
            },
            { runGit: this.deps.runGit },
          );
          if (
            !(await tryLockWorktree(
              repository,
              creation.path,
              claimId,
              owner,
              this.deps.runGit,
            ))
          ) {
            throw new Error(`could not apply native claim ${claimId}`);
          }
          await this.deps.afterNativeLock?.(creation.path, claimId);
          const selectedHead = (
            await this.git(creation.path, ["rev-parse", "HEAD"])
          ).trim();
          if (!/^[0-9a-fA-F]{40,64}$/.test(selectedHead))
            throw new Error(
              `created worktree HEAD is invalid: ${JSON.stringify(selectedHead)}`,
            );
          await this.replaceRecord(repository.poolRoot, claimId, {
            ...creating,
            state: "active",
          });
          return this.acquireResult(
            claimId,
            creation.path,
            request.branch,
            false,
            startPoint,
            selectedHead,
          );
        } catch (error) {
          const cleaned = await this.cleanupFailedAcquire(repository, creating);
          const suffix = cleaned
            ? "new worktree and journal removed"
            : "claim preserved as needs-attention";
          throw new Error(
            `could not acquire ${request.branch} in ${path}: ${errorMessage(error)}; ${suffix}`,
          );
        }
      },
      this.deps.operationLock,
    );
  }

  async release(
    repositoryName: string,
    claimId: string,
    owner: OwnerIdentity,
  ): Promise<ReleaseResult> {
    const repository = this.repository(repositoryName);
    return withOperationLock(
      repository,
      owner,
      () => this.releaseLocked(repository, claimId, owner),
      this.deps.operationLock,
    );
  }

  async repair(
    repositoryName: string,
    input: string,
    owner: OwnerIdentity,
  ): Promise<RepairReport> {
    const repository = this.repository(repositoryName);
    return withOperationLock(
      repository,
      owner,
      async () => {
        const gates = await listRepositoryLeaseRecords(
          repository.poolRoot,
          repository.name,
        );
        const gate = gates.find(
          (candidate) =>
            candidate.path === input ||
            (candidate.state === "valid" &&
              (candidate.record.path === input ||
                candidate.record.claimId === input)),
        );
        if (gate === undefined)
          throw new Error(
            `unknown managed worktree or claim ${JSON.stringify(input)} for ${repository.name}`,
          );
        const path = gate.state === "valid" ? gate.record.path : gate.path;
        const unknownEvidence = {
          pathExists: null,
          registered: null,
          nativeClaimMatches: null,
        };
        if (gate.state === "ambiguous") {
          return {
            path,
            repaired: false,
            state: "needs-attention",
            evidence: unknownEvidence,
            reason: gate.reason,
          };
        }

        const record = gate.record;
        const observation = await this.observeRecord(repository, record);
        if (
          observation.evidence.pathExists === false &&
          observation.evidence.registered === false
        ) {
          await removeLeaseRecord(repository.poolRoot, record.claimId);
          return {
            claimId: record.claimId,
            path,
            repaired: true,
            state: "available",
            evidence: observation.evidence,
          };
        }
        const releasable =
          (record.state === "active" || record.state === "removing") &&
          observation.authorityError === undefined &&
          observation.evidence.pathExists === true &&
          observation.evidence.registered === true &&
          observation.evidence.nativeClaimMatches === true &&
          observation.clean === true &&
          observation.branchProtectsHead === true;
        return {
          claimId: record.claimId,
          path,
          repaired: false,
          state: "needs-attention",
          evidence: observation.evidence,
          reason: releasable
            ? `exact clean claim ${record.claimId} still exists; use worktree_pool release with this claim ID`
            : this.observationReason(record, observation),
        };
      },
      this.deps.operationLock,
    );
  }

  private async releaseLocked(
    repository: ResolvedRepository,
    claimId: string,
    _caller: OwnerIdentity,
  ): Promise<ReleaseResult> {
    const record = await this.exactRecord(repository, claimId).catch(
      () => undefined,
    );
    if (record === undefined) return { path: "", released: false };
    if (record.state !== "active" && record.state !== "removing")
      return { path: record.path, released: false };
    try {
      await this.verifyLeaseAuthority(repository, record);
    } catch {
      return { path: record.path, released: false };
    }
    if (
      !(await this.isClean(record.path)) ||
      !(await this.branchProtectsHead(record.path, record.branch))
    ) {
      return { path: record.path, released: false };
    }
    if (record.state !== "removing") {
      await this.replaceRecord(repository.poolRoot, claimId, {
        ...record,
        state: "removing",
      });
    }
    await unlockWorktree(repository, record.path, this.deps.runGit);
    try {
      const unlockedWorktree = await verifyManagedWorktree(
        repository,
        record.path,
        { runGit: this.deps.runGit },
      );
      if (
        unlockedWorktree.branch !== `refs/heads/${record.branch}` ||
        !(await this.isClean(record.path)) ||
        !(await this.branchProtectsHead(record.path, record.branch))
      ) {
        throw new Error(
          "worktree branch, HEAD, or cleanliness changed after unlock",
        );
      }
      await removeManagedWorktree(repository, record.path, {
        runGit: this.deps.runGit,
      });
      if (
        (await pathExists(record.path)) ||
        (await this.hasRegistration(repository, record.path))
      ) {
        throw new Error(
          "Git reported removal but path or registration still exists",
        );
      }
    } catch (error) {
      if (
        !(await pathExists(record.path)) &&
        !(await this.hasRegistration(repository, record.path))
      ) {
        await removeLeaseRecord(repository.poolRoot, claimId);
        return { path: record.path, released: true };
      }
      throw new Error(
        `failed to remove managed worktree ${record.path}: ${errorMessage(error)}; claim preserved as removing`,
      );
    }
    await removeLeaseRecord(repository.poolRoot, claimId);
    return { path: record.path, released: true };
  }

  private async cleanupFailedAcquire(
    repository: ResolvedRepository,
    record: LeaseRecord,
  ): Promise<boolean> {
    const pathPresent = await pathExists(record.path).catch(() => true);
    const registrationPresent = await this.hasRegistration(
      repository,
      record.path,
    ).catch(() => true);
    if (pathPresent || registrationPresent) return false;
    try {
      await (this.deps.removeLeaseRecord ?? removeLeaseRecord)(
        repository.poolRoot,
        record.claimId,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async listRecords(
    repository: ResolvedRepository,
  ): Promise<PoolWorktreeListing[]> {
    const gates = await listRepositoryLeaseRecords(
      repository.poolRoot,
      repository.name,
    );
    const indexed = await Promise.all(
      gates.map(async (gate): Promise<PoolWorktreeListing> => {
        if (gate.state === "ambiguous") {
          return {
            path: gate.path,
            state: "needs-attention",
            reason: gate.reason,
            currentBranch: null,
            head: null,
            clean: null,
            branchProtectsHead: null,
            evidence: {
              pathExists: null,
              registered: null,
              nativeClaimMatches: null,
            },
          };
        }
        const record = gate.record;
        const observation = await this.observeRecord(repository, record);
        const healthy =
          record.state === "active" &&
          observation.authorityError === undefined &&
          observation.evidence.pathExists === true &&
          observation.evidence.registered === true &&
          observation.evidence.nativeClaimMatches === true &&
          observation.clean === true &&
          observation.branchProtectsHead === true;
        return {
          claimId: record.claimId,
          path: record.path,
          state: healthy ? "active" : "needs-attention",
          branch: record.branch,
          currentBranch: observation.currentBranch,
          head: observation.head,
          clean: observation.clean,
          branchProtectsHead: observation.branchProtectsHead,
          ...(!healthy
            ? { reason: this.observationReason(record, observation) }
            : {}),
          evidence: observation.evidence,
        };
      }),
    );
    const unindexed = await this.unindexedManagedRegistrations(
      repository,
      gates,
    );
    return [
      ...indexed,
      ...(await Promise.all(
        unindexed.map(async (worktree): Promise<PoolWorktreeListing> => {
          const exists = await pathExists(worktree.path).catch(() => null);
          const branch = worktree.branch?.replace(/^refs\/heads\//, "");
          const clean =
            exists === true
              ? await this.isClean(worktree.path).catch(() => null)
              : null;
          const branchProtectsHead =
            exists === true && branch !== undefined
              ? await this.branchProtectsHead(worktree.path, branch).catch(
                  () => null,
                )
              : null;
          return {
            path: worktree.path,
            state: "needs-attention",
            ...(branch === undefined ? {} : { branch }),
            currentBranch: branch ?? null,
            head: worktree.head,
            clean,
            branchProtectsHead,
            reason:
              "managed Git registration has no valid discovery record and consumes capacity",
            evidence: {
              pathExists: exists,
              registered: true,
              nativeClaimMatches: null,
            },
          };
        }),
      )),
    ];
  }

  private async observeRecord(
    repository: ResolvedRepository,
    record: LeaseRecord,
  ): Promise<LeaseObservation> {
    const observedPath = await pathExists(record.path).catch(() => null);
    let registration: RegisteredWorktree | undefined;
    let registered: boolean | null = null;
    try {
      registration = await this.registrationFor(repository, record.path);
      registered = registration !== undefined;
    } catch {
      registered = null;
    }
    const nativeClaimMatches =
      registered === null
        ? null
        : registration === undefined
          ? false
          : nativeClaimMatchesRecord(registration, record);
    let clean: boolean | null = null;
    let branchProtectsHead: boolean | null = null;
    if (observedPath === true) {
      clean = await this.isClean(record.path).catch(() => null);
      branchProtectsHead = await this.branchProtectsHead(
        record.path,
        record.branch,
      ).catch(() => null);
    }
    let authorityError: string | undefined;
    try {
      await this.verifyLeaseAuthority(repository, record);
    } catch (error) {
      authorityError = errorMessage(error);
    }
    return {
      evidence: { pathExists: observedPath, registered, nativeClaimMatches },
      currentBranch:
        registration?.branch?.replace(/^refs\/heads\//, "") ?? null,
      head: registration?.head ?? null,
      clean,
      branchProtectsHead,
      ...(authorityError === undefined ? {} : { authorityError }),
    };
  }

  private observationReason(
    record: LeaseRecord,
    observation: LeaseObservation,
  ): string {
    if (record.state !== "active")
      return `${record.state} journal consumes capacity`;
    if (observation.evidence.pathExists === null)
      return "worktree path existence is unreadable";
    if (observation.evidence.pathExists === false)
      return "worktree path is absent";
    if (observation.evidence.registered === null)
      return "Git registration state is unreadable";
    if (observation.evidence.registered === false)
      return "Git registration is absent";
    if (observation.evidence.nativeClaimMatches !== true)
      return "native claim contradicts the discovery record";
    if (observation.authorityError !== undefined)
      return observation.authorityError;
    if (observation.currentBranch !== record.branch)
      return `worktree branch ${observation.currentBranch ?? "detached"} contradicts ${record.branch}`;
    if (observation.clean !== true)
      return observation.clean === false
        ? "worktree is dirty"
        : "worktree cleanliness is unreadable";
    if (observation.branchProtectsHead !== true)
      return observation.branchProtectsHead === false
        ? "recorded branch does not protect HEAD"
        : "branch protection is unreadable";
    return "worktree state needs explicit inspection";
  }

  private async countUnindexedManagedRegistrations(
    repository: ResolvedRepository,
    gates: LeaseRecordGate[],
  ): Promise<number> {
    return (await this.unindexedManagedRegistrations(repository, gates)).length;
  }

  private async unindexedManagedRegistrations(
    repository: ResolvedRepository,
    gates: LeaseRecordGate[],
  ): Promise<RegisteredWorktree[]> {
    const indexed = new Set<string>();
    for (const gate of gates) {
      if (gate.state !== "valid") continue;
      indexed.add(await canonicalPotentialPath(gate.record.path));
    }
    const canonicalPoolDir = await canonicalPotentialPath(repository.poolDir);
    const unindexed: RegisteredWorktree[] = [];
    for (const worktree of await inspectRepository(
      repository,
      this.deps.runGit,
    )) {
      const path = await canonicalPotentialPath(worktree.path);
      if (
        path !== canonicalPoolDir &&
        pathContains(canonicalPoolDir, path) &&
        !indexed.has(path)
      )
        unindexed.push(worktree);
    }
    return unindexed;
  }

  private async exactRecord(
    repository: ResolvedRepository,
    claimId: string,
  ): Promise<LeaseRecord> {
    const matches = (
      await listRepositoryLeaseRecords(repository.poolRoot, repository.name)
    ).filter(
      (gate): gate is LeaseRecordGate & { state: "valid" } =>
        gate.state === "valid" && gate.record.claimId === claimId,
    );
    if (matches.length !== 1)
      throw new Error(
        `claim ${claimId} is not an exact discovery record in ${repository.name}`,
      );
    return matches[0].record;
  }

  private async resolveStartPoint(
    repository: ResolvedRepository,
    request: AcquireRequest,
  ): Promise<ResolvedStartPoint> {
    const ref = request.startPoint ?? repository.defaultStartPoint;
    if (ref === undefined)
      throw new Error(
        `repository ${repository.name} has no acquisition start point`,
      );
    const fetched = await this.fetchRemoteTrackingStartPoint(repository, ref);
    const head = (
      await this.git(repository.path, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).trim();
    if (!/^[0-9a-fA-F]{40,64}$/.test(head))
      throw new Error(
        `start point ${JSON.stringify(ref)} did not resolve to one commit`,
      );
    return { ref, head, fetched };
  }

  private async fetchRemoteTrackingStartPoint(
    repository: ResolvedRepository,
    ref: string,
  ): Promise<boolean> {
    const remotes = (await this.git(repository.path, ["remote"]))
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const remote of remotes) {
      const prefix = [`refs/remotes/${remote}/`, `${remote}/`].find(
        (candidate) => ref.startsWith(candidate),
      );
      if (prefix === undefined) continue;
      const branch = ref.slice(prefix.length);
      if (
        (
          await this.deps.runGit(repository.path, [
            "check-ref-format",
            `refs/heads/${branch}`,
          ])
        ).code !== 0
      )
        return false;
      await this.git(repository.path, [
        "fetch",
        "--no-tags",
        remote,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
      ]);
      return true;
    }
    return false;
  }

  private async acquireResult(
    claimId: string,
    path: string,
    branch: string,
    reused: boolean,
    startPoint: ResolvedStartPoint,
    knownHead?: string,
  ): Promise<AcquireResult> {
    const head =
      knownHead ?? (await this.git(path, ["rev-parse", "HEAD"])).trim();
    return {
      claimId,
      path,
      branch,
      reused,
      head,
      startPoint: startPoint.ref,
      startPointHead: startPoint.head,
      startPointFetched: startPoint.fetched,
      relationship: await this.startPointRelationship(
        path,
        head,
        startPoint.head,
      ),
    };
  }

  private async startPointRelationship(
    path: string,
    head: string,
    startPointHead: string,
  ): Promise<StartPointRelationship> {
    if (head === startPointHead) return "equal";
    const startIsAncestor = await this.deps.runGit(path, [
      "merge-base",
      "--is-ancestor",
      startPointHead,
      head,
    ]);
    if (startIsAncestor.code === 0) return "contains-start-point";
    if (startIsAncestor.code !== 1)
      throw new Error(
        `could not compare HEAD ${head} with start point ${startPointHead}`,
      );
    const headIsAncestor = await this.deps.runGit(path, [
      "merge-base",
      "--is-ancestor",
      head,
      startPointHead,
    ]);
    if (headIsAncestor.code === 0) return "behind-start-point";
    if (headIsAncestor.code !== 1)
      throw new Error(
        `could not compare HEAD ${head} with start point ${startPointHead}`,
      );
    return "diverged";
  }

  private async validateBranchWithGit(
    repository: ResolvedRepository,
    branch: string,
  ): Promise<void> {
    if (
      (
        await this.deps.runGit(repository.path, [
          "check-ref-format",
          "--branch",
          branch,
        ])
      ).code !== 0
    )
      throw new Error(`invalid branch ${JSON.stringify(branch)}`);
  }

  private async verifyLeaseAuthority(
    repository: ResolvedRepository,
    record: LeaseRecord,
  ): Promise<{
    worktree: Awaited<ReturnType<typeof verifyManagedWorktree>>;
    claim: ClaimRecord;
  }> {
    if (record.repository !== repository.name)
      throw new Error(
        `claim ${record.claimId} repository does not match resolved repository`,
      );
    const [recordCommon, repositoryCommon] = await Promise.all([
      realpath(record.repositoryCommonDir),
      realpath(repository.commonDir),
    ]);
    if (recordCommon !== repositoryCommon)
      throw new Error(
        `claim ${record.claimId} Git common directory contradicts discovery`,
      );
    if (basename(record.path) !== `worktree-${record.pathId}`)
      throw new Error(
        `claim ${record.claimId} path identity contradicts discovery`,
      );
    const worktree = await verifyManagedWorktree(repository, record.path, {
      runGit: this.deps.runGit,
    });
    if (worktree.branch !== `refs/heads/${record.branch}`)
      throw new Error(`claim ${record.claimId} branch contradicts discovery`);
    const claim = parseClaimReason(worktree.lockedReason ?? "");
    if (
      claim === undefined ||
      claim.claimId !== record.claimId ||
      claim.pid !== record.pid ||
      claim.sessionId !== record.sessionId ||
      claim.host !== record.host ||
      claim.started !== record.started
    ) {
      throw new Error(
        `claim ${record.claimId} native owner contradicts discovery`,
      );
    }
    return { worktree, claim };
  }

  private async branchProtectsHead(
    path: string,
    branch: string,
  ): Promise<boolean> {
    const [head, branchHead] = await Promise.all([
      this.git(path, ["rev-parse", "HEAD"]),
      this.git(path, ["rev-parse", `refs/heads/${branch}`]),
    ]);
    return head.trim() === branchHead.trim();
  }

  private async registrationFor(
    repository: ResolvedRepository,
    path: string,
  ): Promise<RegisteredWorktree | undefined> {
    const target = await canonicalPotentialPath(path);
    const matches: RegisteredWorktree[] = [];
    for (const worktree of await inspectRepository(
      repository,
      this.deps.runGit,
    )) {
      if ((await canonicalPotentialPath(worktree.path)) === target)
        matches.push(worktree);
    }
    if (matches.length > 1)
      throw new Error(`multiple Git worktree registrations match ${path}`);
    return matches[0];
  }

  private async hasRegistration(
    repository: ResolvedRepository,
    path: string,
  ): Promise<boolean> {
    return (await this.registrationFor(repository, path)) !== undefined;
  }

  private async isClean(path: string): Promise<boolean> {
    return (await this.git(path, ["status", "--porcelain"])).length === 0;
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.deps.runGit(cwd, args);
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || "git command failed";
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
    }
    return result.stdout;
  }

  private async replaceRecord(
    root: string,
    expectedClaimId: string,
    record: LeaseRecord,
  ): Promise<void> {
    await (this.deps.replaceLeaseRecord ?? replaceLeaseRecord)(
      root,
      expectedClaimId,
      record,
    );
  }

  private uuid(): string {
    return (this.deps.uuid ?? randomUUID)();
  }
  private repository(name: string): ResolvedRepository {
    const repository = this.deps.repositories.find(
      (candidate) => candidate.name === name,
    );
    if (repository === undefined)
      throw new Error(
        `unknown configured pool repository ${JSON.stringify(name)}`,
      );
    return repository;
  }
}

function nativeClaimMatchesRecord(
  worktree: RegisteredWorktree,
  record: LeaseRecord,
): boolean {
  const claim = parseClaimReason(worktree.lockedReason ?? "");
  return (
    claim !== undefined &&
    claim.claimId === record.claimId &&
    claim.pid === record.pid &&
    claim.sessionId === record.sessionId &&
    claim.host === record.host &&
    claim.started === record.started
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      ? Promise.reject(error)
      : false;
  }
}

async function canonicalPotentialPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    return join(await canonicalPotentialPath(parent), basename(path));
  }
}

function pathContains(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return (
    nested === "" ||
    (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

function validateBranch(branch: string): void {
  if (branch.length === 0 || branch.startsWith("-") || branch.includes("\0"))
    throw new Error(`invalid branch ${JSON.stringify(branch)}`);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
