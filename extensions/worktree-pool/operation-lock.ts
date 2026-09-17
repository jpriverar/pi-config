import { join } from "node:path";

import {
  withFileOperationLock,
  type FileOperationLockDependencies,
  type LockOwner,
} from "../../lib/file-operation-lock.js";
import type { ResolvedRepository } from "./types.js";

export type OwnerIdentity = LockOwner;
export type OperationLockDependencies = FileOperationLockDependencies;

export async function withOperationLock<T>(
  repository: ResolvedRepository,
  owner: OwnerIdentity,
  operation: () => Promise<T>,
  dependencies: OperationLockDependencies,
): Promise<T> {
  return withFileOperationLock(
    join(repository.commonDir, "pi-worktree-pool"),
    owner,
    operation,
    dependencies,
  );
}
