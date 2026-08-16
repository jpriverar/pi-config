import { homedir } from "node:os";
import { join } from "node:path";

export type IssueStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "deferred"
  | "closed";
export type Readiness = "in_progress" | "blocked" | "ready" | "waiting";

export interface BeadsIssue {
  id: string;
  title: string;
  status: IssueStatus;
  labels: string[];
  updatedAt?: string;
}

export interface ClassifiedIssue extends BeadsIssue {
  readiness: Readiness;
  workstreams: string[];
  needsJp: boolean;
}

export interface BeadsError {
  operation: string;
  store: string;
  message: string;
}

export type BeadsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BeadsError };

export function resolveBeadsDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.BEADS_DIR || join(home, "beads", ".beads");
}

export interface BeadsExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BeadsExec = (
  command: string,
  args: readonly string[],
) => Promise<BeadsExecResult>;

export interface BeadsClient {
  runBd<T>(
    operation: string,
    args: readonly string[],
    decode: (value: unknown) => T,
  ): Promise<BeadsResult<T>>;

  listIssues(
    statuses?: readonly IssueStatus[],
  ): Promise<BeadsResult<BeadsIssue[]>>;

  listReadyIssueIds(): Promise<BeadsResult<ReadonlySet<string>>>;
}

const issueStatuses: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
]);

function decodeIssue(value: unknown, index: number): BeadsIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`issue at index ${index} must be an object`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") {
    throw new Error(`issue at index ${index} has an invalid id`);
  }
  if (typeof record.title !== "string") {
    throw new Error(`issue at index ${index} has an invalid title`);
  }
  if (typeof record.status !== "string" || !issueStatuses.has(record.status)) {
    throw new Error(`issue at index ${index} has an unsupported status`);
  }
  if (
    record.labels !== undefined &&
    (!Array.isArray(record.labels) ||
      record.labels.some((label) => typeof label !== "string"))
  ) {
    throw new Error(`issue at index ${index} has invalid labels`);
  }
  if (
    record.updated_at !== undefined &&
    typeof record.updated_at !== "string"
  ) {
    throw new Error(`issue at index ${index} has an invalid updated_at`);
  }

  const decoded: BeadsIssue = {
    id: record.id,
    title: record.title,
    status: record.status as IssueStatus,
    labels: (record.labels as string[] | undefined) ?? [],
  };
  if (record.updated_at !== undefined) {
    decoded.updatedAt = record.updated_at;
  }
  return decoded;
}

function decodeIssues(value: unknown): BeadsIssue[] {
  if (!Array.isArray(value)) {
    throw new Error("bd output must be an array of issues");
  }
  return value.map(decodeIssue);
}

function isMissingCliError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function createBeadsClient(
  exec: BeadsExec,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): BeadsClient {
  const store = resolveBeadsDir(options.env, options.home);

  async function runBd<T>(
    operation: string,
    args: readonly string[],
    decode: (value: unknown) => T,
  ): Promise<BeadsResult<T>> {
    let result: BeadsExecResult;
    try {
      result = await exec("bd", [...args, "--db", store]);
    } catch (error) {
      return {
        ok: false,
        error: {
          operation,
          store,
          message: isMissingCliError(error)
            ? "bd CLI is unavailable"
            : "bd execution failed",
        },
      };
    }

    if (result.code !== 0) {
      return {
        ok: false,
        error: {
          operation,
          store,
          message:
            result.code === 127
              ? "bd CLI is unavailable (exit code 127)"
              : `bd exited with code ${result.code}`,
        },
      };
    }

    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      return {
        ok: false,
        error: { operation, store, message: "bd returned malformed JSON" },
      };
    }

    try {
      return { ok: true, value: decode(value) };
    } catch {
      return {
        ok: false,
        error: { operation, store, message: "bd returned an invalid response" },
      };
    }
  }

  return {
    runBd,
    listIssues(statuses = ["open", "in_progress", "blocked"]) {
      return runBd(
        "list issues",
        ["list", "-s", statuses.join(","), "-n", "0", "--json"],
        decodeIssues,
      );
    },
    listReadyIssueIds() {
      return runBd("list ready issues", ["ready", "--json"], (value) => {
        const issues = decodeIssues(value);
        return new Set(issues.map((issue) => issue.id));
      });
    },
  };
}

export function classifyReadiness(
  issues: readonly BeadsIssue[],
  readyIds: ReadonlySet<string>,
): ClassifiedIssue[] {
  return issues.map((issue) => {
    let readiness: Readiness = "waiting";
    if (issue.status === "in_progress") {
      readiness = "in_progress";
    } else if (issue.status === "blocked") {
      readiness = "blocked";
    } else if (issue.status === "open" && readyIds.has(issue.id)) {
      readiness = "ready";
    }

    return {
      ...issue,
      readiness,
      workstreams: issue.labels
        .filter((label) => label.startsWith("workstream:"))
        .map((label) => label.slice("workstream:".length)),
      needsJp: issue.labels.includes("needs:jp"),
    };
  });
}
