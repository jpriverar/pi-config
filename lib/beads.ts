import { homedir } from "node:os";
import { join } from "node:path";

import { decodeLifecycle } from "./task-lifecycle/model.js";
import type {
  LifecycleCheck,
  LifecycleMetadataV1,
  LifecyclePhase,
  NativeDependency,
} from "./task-lifecycle/types.js";
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
  lifecycle?: LifecycleMetadataV1 | null;
  lifecycleWarning?: string;
  blockingDependencies?: NativeDependency[];
}

export interface ClassifiedIssue extends BeadsIssue {
  readiness: Readiness;
  workstreams: string[];
  needsJp: boolean;
  lifecyclePhase?: LifecyclePhase;
  lifecycleStateEnteredAt?: string;
  activeCheck?: LifecycleCheck | null;
  blockingTaskIds: string[];
  warnings: string[];
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

  listBlockingDependencies(
    id: string,
  ): Promise<BeadsResult<NativeDependency[]>>;

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
  if (record.metadata !== undefined) {
    if (
      typeof record.metadata !== "object" ||
      record.metadata === null ||
      Array.isArray(record.metadata)
    ) {
      throw new Error(`issue at index ${index} has invalid metadata`);
    }
    const rawLifecycle = (record.metadata as Record<string, unknown>)
      .piLifecycle;
    if (rawLifecycle !== undefined) {
      const lifecycle = decodeLifecycle(rawLifecycle);
      if (lifecycle.ok) decoded.lifecycle = lifecycle.value;
      else {
        decoded.lifecycle = null;
        decoded.lifecycleWarning = lifecycle.warning;
      }
    }
  }
  if (
    record.dependencies !== undefined &&
    !isDependencyEdgeSummaryList(record.dependencies)
  ) {
    decoded.blockingDependencies = decodeBlockingDependencies(
      record.dependencies,
      `issue at index ${index}`,
    );
  }
  return decoded;
}

function isDependencyEdgeSummaryList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).issue_id === "string" &&
        typeof (item as Record<string, unknown>).depends_on_id === "string" &&
        typeof (item as Record<string, unknown>).type === "string",
    )
  );
}

function decodeBlockingDependencies(
  value: unknown,
  context: string,
): NativeDependency[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} has invalid dependencies`);
  }
  return value
    .map((item, index): NativeDependency => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`${context} dependency ${index} is invalid`);
      }
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string") {
        throw new Error(`${context} dependency ${index} has invalid id`);
      }
      if (
        typeof record.status !== "string" ||
        !issueStatuses.has(record.status)
      ) {
        throw new Error(`${context} dependency ${index} has invalid status`);
      }
      if (typeof record.dependency_type !== "string") {
        throw new Error(
          `${context} dependency ${index} has invalid dependency_type`,
        );
      }
      return {
        id: normalizeId(record.id),
        status: record.status as IssueStatus,
        dependencyType: normalizeMetadata(record.dependency_type, LABEL_LIMIT),
      };
    })
    .filter(
      (dependency) =>
        dependency.dependencyType === "blocks" &&
        dependency.status !== "closed",
    );
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
    listBlockingDependencies(id) {
      return runBd(
        `list blocking dependencies for ${normalizeId(id)}`,
        ["dep", "list", id, "--json"],
        (value) =>
          decodeBlockingDependencies(value, `issue ${normalizeId(id)}`),
      );
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
      let encoded: string;
      try {
        encoded = encodeProjectRenameRegistry(registry);
      } catch {
        return {
          ok: false,
          error: {
            operation: "set project rename registry",
            store,
            message: "project rename registry is invalid",
          },
        };
      }

      const executed = await execBd("set project rename registry", [
        "config",
        "set",
        PROJECT_RENAMES_CONFIG_KEY,
        encoded,
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
    const blockingTaskIds = (issue.blockingDependencies ?? []).map(
      (dependency) => dependency.id,
    );
    const warnings = issue.lifecycleWarning ? [issue.lifecycleWarning] : [];
    let readiness: Readiness = "waiting";

    if (issue.lifecycle !== undefined && issue.lifecycle !== null) {
      if (issue.lifecycle.phase === "active") {
        readiness = "in_progress";
      } else if (issue.lifecycle.phase === "actionable") {
        if (blockingTaskIds.length > 0) {
          warnings.push(
            `actionable lifecycle has unresolved blocker ${blockingTaskIds.join(", ")}`,
          );
        }
        readiness =
          issue.status === "open" &&
          readyIds.has(issue.id) &&
          blockingTaskIds.length === 0
            ? "ready"
            : "waiting";
      } else if (issue.lifecycle.phase === "waiting") {
        readiness = "waiting";
        if (
          issue.lifecycle.waiting?.kind === "dependency" &&
          blockingTaskIds.length === 0
        ) {
          warnings.push("dependency wait has no unresolved blocker");
        }
      }
      for (const resource of issue.lifecycle.resources) {
        if (
          issue.lifecycle.phase === "waiting" &&
          resource.cleanupState === "active"
        ) {
          warnings.push(`retained worktree ${resource.claimId}`);
        } else if (
          resource.cleanupState === "acquiring" ||
          resource.cleanupState === "release_pending" ||
          resource.cleanupState === "needs_attention"
        ) {
          warnings.push(
            `worktree ${resource.claimId} is ${resource.cleanupState.replace("_", " ")}`,
          );
        }
      }
      if (
        issue.lifecycle.activeCheck?.state === "error" &&
        issue.lifecycle.activeCheck.errorCount > 0
      ) {
        warnings.push(
          `check error ×${issue.lifecycle.activeCheck.errorCount}: ${issue.lifecycle.activeCheck.lastObservation ?? "observation unavailable"}`,
        );
      }
    } else if (issue.status === "in_progress") {
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
      ...(issue.lifecycle === undefined || issue.lifecycle === null
        ? {}
        : {
            lifecyclePhase: issue.lifecycle.phase,
            lifecycleStateEnteredAt: issue.lifecycle.stateEnteredAt,
            activeCheck: issue.lifecycle.activeCheck,
          }),
      blockingTaskIds,
      warnings,
    };
  });
}

export function lifecycleAnnotation(
  issue: ClassifiedIssue,
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  if (issue.blockingTaskIds.length > 0) {
    parts.push(`blocked by ${issue.blockingTaskIds.join(", ")}`);
  } else if (issue.activeCheck !== undefined && issue.activeCheck !== null) {
    const observation = issue.activeCheck.lastObservation;
    parts.push(
      observation === null || observation === "open"
        ? issue.activeCheck.kind === "github_pull_request"
          ? "PR open"
          : "check pending"
        : observation,
    );
    if (issue.activeCheck.nextCheckAt !== null) {
      parts.push(
        Date.parse(issue.activeCheck.nextCheckAt) < now
          ? `check overdue since ${issue.activeCheck.nextCheckAt.slice(11, 16)}`
          : `next check ${issue.activeCheck.nextCheckAt.slice(11, 16)}`,
      );
    }
  }
  if (
    issue.readiness === "waiting" &&
    issue.lifecycleStateEnteredAt !== undefined
  ) {
    const elapsed = Math.max(
      0,
      now - Date.parse(issue.lifecycleStateEnteredAt),
    );
    parts.push(`waiting ${Math.floor(elapsed / 86_400_000)}d`);
  }
  parts.push(...issue.warnings);
  const annotation = normalizeMetadata(parts.join(" · "), 2_000);
  return annotation.length === 0 ? "" : ` · ${annotation}`;
}

export async function listClassifiedIssues(
  client: BeadsClient,
  statuses?: readonly IssueStatus[],
): Promise<BeadsResult<ClassifiedIssue[]>> {
  const listed = await client.listIssues(statuses);
  if (!listed.ok) return listed;
  const ready = await client.listReadyIssueIds();
  if (!ready.ok) return ready;

  const enriched: BeadsIssue[] = [];
  for (const issue of listed.value) {
    const needsBlockers =
      issue.lifecycle?.phase === "actionable" ||
      (issue.lifecycle?.phase === "waiting" &&
        issue.lifecycle.waiting?.kind === "dependency");
    if (!needsBlockers) {
      enriched.push(issue);
      continue;
    }
    const dependencies = await client.listBlockingDependencies(issue.id);
    if (!dependencies.ok) return dependencies;
    enriched.push({ ...issue, blockingDependencies: dependencies.value });
  }
  return { ok: true, value: classifyReadiness(enriched, ready.value) };
}
