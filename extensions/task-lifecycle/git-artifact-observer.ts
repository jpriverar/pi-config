import { isAbsolute, resolve } from "node:path";

import type { ArtifactInput } from "../../lib/task-lifecycle/types.js";
import type { GitArtifactObservationIntent } from "./git-artifact-command.js";

export interface GitArtifactExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitArtifactExecutor {
  run(
    executable: "git" | "gh",
    args: readonly string[],
    cwd: string,
  ): Promise<GitArtifactExecutionResult>;
}

export interface GitArtifactObserver {
  observe(
    intents: readonly GitArtifactObservationIntent[],
  ): Promise<ArtifactInput[]>;
}

const MAX_OUTPUT_LENGTH = 128 * 1024;
const MAX_LINE_LENGTH = 4096;
const KIND_ORDER = new Map([
  ["branch", 0],
  ["commit", 1],
  ["pull_request", 2],
]);

export function createGitArtifactObserver(deps: {
  executor: GitArtifactExecutor;
}): GitArtifactObserver {
  return {
    async observe(intents) {
      const observed: ArtifactInput[] = [];
      try {
        for (const intent of intents) {
          observed.push(
            ...(intent.kind === "git-head"
              ? await observeGit(deps.executor, intent)
              : await observePullRequest(deps.executor, intent)),
          );
        }
      } catch {
        throw new Error("Git artifact observation failed");
      }
      return deduplicateAndSort(observed);
    },
  };
}

async function observeGit(
  executor: GitArtifactExecutor,
  intent: Extract<GitArtifactObservationIntent, { kind: "git-head" }>,
): Promise<ArtifactInput[]> {
  const rootResult = await executor.run(
    "git",
    ["rev-parse", "--show-toplevel"],
    intent.cwd,
  );
  const root = successfulLine(rootResult);
  if (root === null || !isAbsolute(root) || resolve(root) !== root) return [];

  const remoteResult = await executor.run(
    "git",
    ["config", "--get", "remote.origin.url"],
    root,
  );
  const remote = successfulLine(remoteResult);
  const repository = remote === null ? null : repositoryFromRemote(remote);
  if (repository === null) return [];

  const symbolicResult = await executor.run(
    "git",
    ["rev-parse", "--symbolic-full-name", "--verify", intent.ref],
    root,
  );
  const symbolic = successfulLine(symbolicResult);
  if (symbolic === null) return [];
  if (intent.ref === "HEAD" && symbolic !== "HEAD" && !isBranchRef(symbolic)) {
    return [];
  }

  let branchRef: string | null;
  if (intent.ref === "HEAD") {
    const branchResult = await executor.run(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      root,
    );
    const branch = successfulLine(branchResult);
    branchRef = branch === null ? null : branchToFullRef(branch);
  } else {
    branchRef = isBranchRef(symbolic) ? symbolic : null;
    if (branchRef === null) return [];
  }

  const commitResult = await executor.run(
    "git",
    ["rev-parse", "--verify", `${intent.ref}^{commit}`],
    root,
  );
  const commit = successfulLine(commitResult);
  if (commit === null || !isCommitHash(commit)) return [];

  const artifacts: ArtifactInput[] = [];
  if (branchRef !== null) artifacts.push(branchArtifact(repository, branchRef));
  artifacts.push(commitArtifact(repository, commit));
  return artifacts;
}

async function observePullRequest(
  executor: GitArtifactExecutor,
  intent: Extract<GitArtifactObservationIntent, { kind: "github-pr" }>,
): Promise<ArtifactInput[]> {
  const args = ["pr", "view"];
  if (intent.head !== undefined) args.push(intent.head);
  if (intent.repository !== undefined) {
    args.push("--repo", intent.repository);
  }
  args.push("--json", "number,url,headRefName");

  const result = await executor.run("gh", args, intent.cwd);
  if (
    result.code !== 0 ||
    result.stdout.length > MAX_OUTPUT_LENGTH ||
    result.stdout.includes("\0")
  ) {
    return [];
  }
  const decoded = decodePullRequest(result.stdout);
  if (decoded === null) return [];
  const identity = pullRequestIdentity(decoded.url, decoded.number);
  if (identity === null) return [];
  if (
    intent.repository !== undefined &&
    identity.repository.toLowerCase() !== intent.repository.toLowerCase()
  ) {
    return [];
  }
  if (
    intent.head !== undefined &&
    headBranch(intent.head) !== decoded.headRefName
  ) {
    return [];
  }

  return [
    branchArtifact(identity.name, `refs/heads/${decoded.headRefName}`),
    {
      id: `pull_request:${identity.repository}:${decoded.number}`,
      kind: "pull_request",
      uri: decoded.url,
      title: `${identity.repository}#${decoded.number}`,
      role: "evidence",
      sourceArtifactIds: [],
      supersededAt: null,
    },
  ];
}

function successfulLine(result: GitArtifactExecutionResult): string | null {
  if (
    result.code !== 0 ||
    result.stdout.length === 0 ||
    result.stdout.length > MAX_OUTPUT_LENGTH ||
    result.stdout.includes("\0")
  ) {
    return null;
  }
  const value = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1)
    : result.stdout;
  if (
    value.length === 0 ||
    value.length > MAX_LINE_LENGTH ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return null;
  }
  return value;
}

function repositoryFromRemote(remote: string): string | null {
  if (remote.includes("?") || remote.includes("#")) return null;
  const scp =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote,
    );
  if (scp !== null) return scp[2];

  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  if (url.password !== "") return null;
  if (
    url.username !== "" &&
    !(url.protocol === "ssh:" && url.username === "git")
  ) {
    return null;
  }
  if (!new Set(["https:", "http:", "ssh:", "git:"]).has(url.protocol)) {
    return null;
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    url.pathname,
  );
  return match?.[2] ?? null;
}

function branchToFullRef(branch: string): string | null {
  return isBranchName(branch) ? `refs/heads/${branch}` : null;
}

function isBranchRef(value: string): boolean {
  return value.startsWith("refs/heads/") && isBranchName(value.slice(11));
}

function isBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//")
  );
}

function isCommitHash(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function branchArtifact(repository: string, ref: string): ArtifactInput {
  const branch = ref.slice("refs/heads/".length);
  return {
    id: `branch:${repository}:${ref}`,
    kind: "branch",
    uri: `git://${repository}/${ref}`,
    title: `${repository} ${branch}`,
    role: "evidence",
    sourceArtifactIds: [],
    supersededAt: null,
  };
}

function commitArtifact(repository: string, commit: string): ArtifactInput {
  return {
    id: `commit:${repository}:${commit}`,
    kind: "commit",
    uri: `git://${repository}/commit/${commit}`,
    title: `${repository} ${commit.slice(0, 12)}`,
    role: "evidence",
    sourceArtifactIds: [],
    supersededAt: null,
  };
}

function decodePullRequest(value: string): {
  number: number;
  url: string;
  headRefName: string;
} | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.number) ||
    (record.number as number) <= 0 ||
    typeof record.url !== "string" ||
    record.url.length > MAX_LINE_LENGTH ||
    typeof record.headRefName !== "string" ||
    !isBranchName(record.headRefName)
  ) {
    return null;
  }
  return {
    number: record.number as number,
    url: record.url,
    headRefName: record.headRefName,
  };
}

function pullRequestIdentity(
  uri: string,
  expectedNumber: number,
): { repository: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(
    url.pathname,
  );
  if (match === null || Number(match[3]) !== expectedNumber) return null;
  return { repository: `${match[1]}/${match[2]}`, name: match[2] };
}

function headBranch(value: string): string {
  const separator = value.indexOf(":");
  return separator < 0 ? value : value.slice(separator + 1);
}

function deduplicateAndSort(artifacts: ArtifactInput[]): ArtifactInput[] {
  const unique = new Map<string, ArtifactInput>();
  for (const artifact of artifacts) {
    unique.set(`${artifact.kind}\0${artifact.uri}`, artifact);
  }
  return [...unique.values()].sort((left, right) => {
    const kind =
      (KIND_ORDER.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
      (KIND_ORDER.get(right.kind) ?? Number.MAX_SAFE_INTEGER);
    return kind === 0 ? left.uri.localeCompare(right.uri) : kind;
  });
}
