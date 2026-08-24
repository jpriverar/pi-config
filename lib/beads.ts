import { homedir } from "node:os";
import { join } from "node:path";

import {
  decodeProjectRenameRegistry,
  encodeProjectRenameRegistry,
  PROJECT_RENAMES_CONFIG_KEY,
  type ProjectRenameRegistry,
} from "./project-renames.js";

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

  getProjectRenameRegistry(): Promise<BeadsResult<ProjectRenameRegistry>>;

  setProjectRenameRegistry(
    registry: ProjectRenameRegistry,
  ): Promise<BeadsResult<void>>;

  updateIssueLabels(
    issueIds: readonly string[],
    options: {
      removeLabels?: readonly string[];
      addLabels?: readonly string[];
    },
  ): Promise<BeadsResult<void>>;
}

const issueStatuses: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
]);
const ID_LIMIT = 128;
const TITLE_LIMIT = 500;
const LABEL_LIMIT = 128;
const UPDATED_AT_LIMIT = 128;

function normalizeMetadata(value: string, limit: number): string {
  const withoutTerminalSequences = value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[P^_][\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
  const normalized = withoutTerminalSequences
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...normalized].slice(0, limit).join("");
}

export function normalizeBeadsLabel(value: string): string {
  return normalizeMetadata(value, LABEL_LIMIT);
}

function normalizeId(value: string): string {
  const id = normalizeMetadata(value, ID_LIMIT);
  if (!id) throw new Error("issue id is empty after normalization");
  return id;
}

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
    id: normalizeId(record.id),
    title: normalizeMetadata(record.title, TITLE_LIMIT) || "(untitled task)",
    status: record.status as IssueStatus,
    labels: ((record.labels as string[] | undefined) ?? [])
      .map((label) => normalizeBeadsLabel(label))
      .filter((label) => label.length > 0),
  };
  if (record.updated_at !== undefined) {
    const updatedAt = normalizeMetadata(record.updated_at, UPDATED_AT_LIMIT);
    if (updatedAt) decoded.updatedAt = updatedAt;
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

  async function execBd(
    operation: string,
    args: readonly string[],
  ): Promise<BeadsResult<BeadsExecResult>> {
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

    return { ok: true, value: result };
  }

  async function runBd<T>(
    operation: string,
    args: readonly string[],
    decode: (value: unknown) => T,
  ): Promise<BeadsResult<T>> {
    const executed = await execBd(operation, args);
    if (!executed.ok) return executed;

    let value: unknown;
    try {
      value = JSON.parse(executed.value.stdout);
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
    getProjectRenameRegistry() {
      return runBd(
        "get project rename registry",
        ["config", "get", PROJECT_RENAMES_CONFIG_KEY, "--json"],
        (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            typeof (value as Record<string, unknown>).value !== "string"
          ) {
            throw new Error("invalid project rename registry envelope");
          }
          return decodeProjectRenameRegistry(
            (value as Record<string, unknown>).value,
          );
        },
      );
    },
    async setProjectRenameRegistry(registry) {
      const executed = await execBd("set project rename registry", [
        "config",
        "set",
        PROJECT_RENAMES_CONFIG_KEY,
        encodeProjectRenameRegistry(registry),
        "--json",
      ]);
      if (!executed.ok) return executed;
      return { ok: true, value: undefined };
    },
    async updateIssueLabels(issueIds, options) {
      if (issueIds.length === 0) {
        return {
          ok: false,
          error: {
            operation: "update issues",
            store,
            message: "issue ids are required",
          },
        };
      }

      const args = ["update", ...issueIds];
      for (const label of options.removeLabels ?? []) {
        args.push("--remove-label", label);
      }
      for (const label of options.addLabels ?? []) {
        args.push("--add-label", label);
      }

      const executed = await execBd("update issues", args);
      if (!executed.ok) return executed;
      return { ok: true, value: undefined };
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
