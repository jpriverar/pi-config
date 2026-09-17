export type GitResult = { code: number; stdout: string; stderr: string };
export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;
export type Realpath = (path: string) => Promise<string>;

export type RegisteredWorktree = {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  lockedReason?: string;
  prunableReason?: string;
  valid: boolean;
};

export type PoolConfigV2 = {
  version: 2;
  root: string;
  repositoryRoot: string;
  defaultCapacity: number;
  exclude: string[];
  repositories: Array<{
    name: string;
    capacity?: number;
    defaultStartPoint?: string;
  }>;
};

export type LoadedPoolConfig = {
  root: string;
  canonicalRoot: string;
  repositoryRoot: string;
  canonicalRepositoryRoot: string;
  defaultCapacity: number;
  exclude: string[];
  overrides: Map<string, { capacity: number; defaultStartPoint?: string }>;
};

export type ResolvedRepository = {
  name: string;
  path: string;
  canonicalPath: string;
  commonDir: string;
  poolRoot: string;
  poolDir: string;
  capacity: number;
  defaultStartPoint?: string;
};
