import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname as readHostname } from "node:os";

import { resolveBeadsDir, type BeadsExec } from "../../lib/beads.js";
import { loadWorktreePoolRuntime } from "../worktree-pool/runtime.js";
import { createLifecycleStore } from "../../lib/task-lifecycle/beads-store.js";
import { createCheckAdapterRegistry } from "../../lib/task-lifecycle/checks.js";
import { classifyTaskToolRequirement } from "../../lib/task-lifecycle/tool-guard.js";
import {
  TaskLifecycleService,
  type CloseDispositionInput,
  type TaskLifecyclePoolPort,
} from "../../lib/task-lifecycle/service.js";
import type {
  ArtifactInput,
  LifecycleCheck,
  LifecycleIssue,
  LockOwner,
} from "../../lib/task-lifecycle/types.js";

export interface TaskLifecycleToolService {
  claim(
    taskId: string,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  attachArtifact(
    taskId: string,
    artifact: ArtifactInput,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  waitForDependencies(
    taskId: string,
    blockerIds: readonly string[],
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  waitForCheck(
    taskId: string,
    check: LifecycleCheck,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  close(
    taskId: string,
    disposition: CloseDispositionInput,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  reopen(
    taskId: string,
    reason: string,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  reconcileExecutionTimeout(
    taskId: string,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  reconcileTask(
    taskId: string,
    owner: LockOwner,
    input?: { manualOutcome?: "satisfied" | "action_required" },
  ): Promise<LifecycleIssue>;
  reconcileDue(
    owner: LockOwner,
    limits: { taskLimit: number; checkLimit: number },
  ): Promise<LifecycleIssue[]>;
  refreshSessionActivity(owner: LockOwner): Promise<LifecycleIssue[]>;
  interruptSession(owner: LockOwner, reason: string): Promise<LifecycleIssue[]>;
  acquireWorktree(
    request: {
      taskId: string;
      repository: string;
      branch: string;
      startPoint?: string;
    },
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  releaseWorktree(
    taskId: string,
    claimId: string,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]>;
  hasActiveTask(sessionId: string): Promise<boolean>;
  isClaimAssociated(claimId: string): Promise<boolean>;
}

interface ExtensionContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    id: string,
    params: any,
    signal: unknown,
    update: unknown,
    context: ExtensionContext,
  ): Promise<unknown>;
}

interface ExtensionApi {
  on(
    event: string,
    handler: (event: any, context: ExtensionContext) => unknown,
  ): void;
  registerTool(tool: ToolDefinition): void;
  exec?: BeadsExec;
}

export interface TaskLifecycleExtensionDependencies {
  service: TaskLifecycleToolService;
  now(): number;
  pid: number;
  hostname: string;
  activityWriteIntervalMs: number;
  sessionReconcileLimit: number;
  sessionPrCheckLimit: number;
}

interface LifecycleConfig {
  version: 1;
  executionTimeoutMs: number;
  activityWriteIntervalMs: number;
  sessionReconcileLimit: number;
  sessionPrCheckLimit: number;
  prPollIntervalMs: number;
  maxBackoffMs: number;
  warningErrorCount: number;
}

const taskIdProperty = {
  type: "string",
  minLength: 1,
  description: "Beads task ID, for example jp-abc.",
} as const;
const operationIdProperty = {
  type: "string",
  minLength: 1,
  description: "Stable idempotency key. Defaults to the Pi tool-call ID.",
} as const;
const artifactKinds = [
  "branch",
  "commit",
  "pull_request",
  "document",
  "dashboard",
  "deployment",
  "report",
  "other",
] as const;
const artifactRoles = ["deliverable", "evidence", "supporting"] as const;
const checkKinds = ["github_pull_request", "time", "manual"] as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  } as const;
}

const checkSchema = objectSchema(
  {
    id: { type: "string", minLength: 1 },
    kind: { type: "string", enum: checkKinds },
    targetArtifactIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    predicate: { type: "object", additionalProperties: true },
    onSatisfied: { type: "string", enum: ["close", "actionable"] },
    wakeOn: { type: "array", items: { type: "string", minLength: 1 } },
    state: {
      type: "string",
      enum: ["pending", "satisfied", "action_required", "error"],
    },
    createdAt: { type: "string", minLength: 1 },
    lastCheckedAt: { type: ["string", "null"] },
    nextCheckAt: { type: ["string", "null"] },
    lastObservation: { type: ["string", "null"] },
    errorCount: { type: "integer", minimum: 0 },
  },
  [
    "id",
    "kind",
    "targetArtifactIds",
    "predicate",
    "onSatisfied",
    "wakeOn",
    "state",
    "createdAt",
    "lastCheckedAt",
    "nextCheckAt",
    "lastObservation",
    "errorCount",
  ],
);

export function createTaskLifecycleExtension(
  deps: TaskLifecycleExtensionDependencies,
) {
  return function taskLifecycleExtension(pi: ExtensionApi): void {
    const ownerFor = (context: ExtensionContext): LockOwner => ({
      pid: deps.pid,
      sessionId: context.sessionManager.getSessionId(),
      host: deps.hostname,
      started: deps.now(),
    });
    const operationFor = (id: string, params: { operationId?: string }) =>
      params.operationId ?? id;
    const block = (reason: string) => ({ block: true, reason });

    pi.registerTool({
      name: "task_claim",
      label: "Claim task",
      description:
        "Claim one actionable task for the current Pi session under an expiring execution lease.",
      parameters: objectSchema(
        { taskId: taskIdProperty, operationId: operationIdProperty },
        ["taskId"],
      ),
      async execute(id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.claim(
            params.taskId,
            ownerFor(context),
            operationFor(id, params),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_attach_artifact",
      label: "Attach artifact",
      description:
        "Attach a durable branch, commit, pull request, document, dashboard, deployment, report, or other artifact to an active task.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          operationId: operationIdProperty,
          artifactId: { type: "string", minLength: 1 },
          kind: { type: "string", enum: artifactKinds },
          uri: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          role: { type: "string", enum: artifactRoles },
          sourceArtifactIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        ["taskId", "kind", "uri", "title", "role"],
      ),
      async execute(id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.attachArtifact(
            params.taskId,
            {
              id: params.artifactId ?? `artifact:${id}`,
              kind: params.kind,
              uri: params.uri,
              title: params.title,
              role: params.role,
              ...(params.sourceArtifactIds === undefined
                ? {}
                : { sourceArtifactIds: params.sourceArtifactIds }),
            },
            ownerFor(context),
            operationFor(id, params),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_wait",
      label: "Wait on task",
      description:
        "Relinquish active ownership and wait on native task dependencies or exactly one typed external check.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          operationId: operationIdProperty,
          kind: { type: "string", enum: ["dependency", "check"] },
          blockerIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          check: checkSchema,
        },
        ["taskId", "kind"],
      ),
      async execute(id, params, _signal, _update, context) {
        const owner = ownerFor(context);
        const operationId = operationFor(id, params);
        if (params.kind === "dependency") {
          if (!Array.isArray(params.blockerIds) || params.check !== undefined) {
            throw new Error(
              "dependency wait requires blockerIds and must not include check",
            );
          }
          return toolResult(
            await deps.service.waitForDependencies(
              params.taskId,
              params.blockerIds,
              owner,
              operationId,
            ),
          );
        }
        if (params.check === undefined || params.blockerIds !== undefined) {
          throw new Error(
            "check wait requires check and must not include blockerIds",
          );
        }
        return toolResult(
          await deps.service.waitForCheck(
            params.taskId,
            params.check,
            owner,
            operationId,
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_reconcile",
      label: "Reconcile task",
      description:
        "Reconcile deterministic lifecycle state such as an expired active execution lease.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          manualOutcome: {
            type: "string",
            enum: ["satisfied", "action_required"],
          },
        },
        ["taskId"],
      ),
      async execute(_id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.reconcileTask(
            params.taskId,
            ownerFor(context),
            params.manualOutcome === undefined
              ? {}
              : { manualOutcome: params.manualOutcome },
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_close",
      label: "Close task",
      description:
        "Close a lifecycle task with an explicit completed, cancelled, or superseded disposition.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          operationId: operationIdProperty,
          kind: {
            type: "string",
            enum: ["completed", "cancelled", "superseded"],
          },
          reason: { type: "string", minLength: 1 },
          evidenceArtifactIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          supersedingTaskId: { type: "string", minLength: 1 },
        },
        ["taskId", "kind", "reason"],
      ),
      async execute(id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.close(
            params.taskId,
            {
              kind: params.kind,
              reason: params.reason,
              evidenceArtifactIds: params.evidenceArtifactIds ?? [],
              ...(params.supersedingTaskId === undefined
                ? {}
                : { supersedingTaskId: params.supersedingTaskId }),
            },
            ownerFor(context),
            operationFor(id, params),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_reopen",
      label: "Reopen task",
      description:
        "Reopen a done lifecycle task, returning it to dependency waiting or actionable state.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          operationId: operationIdProperty,
          reason: { type: "string", minLength: 1 },
        },
        ["taskId", "reason"],
      ),
      async execute(id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.reopen(
            params.taskId,
            params.reason,
            ownerFor(context),
            operationFor(id, params),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_worktree_acquire",
      label: "Acquire task worktree",
      description:
        "Acquire a bounded worktree while persisting its exact task association and deterministic pool identities.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          repository: { type: "string", minLength: 1 },
          branch: { type: "string", minLength: 1 },
          startPoint: { type: "string", minLength: 1 },
          operationId: operationIdProperty,
        },
        ["taskId", "repository", "branch"],
      ),
      async execute(id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.acquireWorktree(
            {
              taskId: params.taskId,
              repository: params.repository,
              branch: params.branch,
              ...(params.startPoint === undefined
                ? {}
                : { startPoint: params.startPoint }),
            },
            ownerFor(context),
            operationFor(id, params),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_worktree_release",
      label: "Release task worktree",
      description:
        "Release one task-associated worktree by exact claim ID using a persisted two-phase handoff.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          claimId: { type: "string", minLength: 1 },
          operationId: operationIdProperty,
        },
        ["taskId", "claimId"],
      ),
      async execute(id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.releaseWorktree(
            params.taskId,
            params.claimId,
            ownerFor(context),
            operationFor(id, params),
          ),
        );
      },
    });

    pi.on("session_start", async (_event, context) => {
      await deps.service.reconcileDue(ownerFor(context), {
        taskLimit: deps.sessionReconcileLimit,
        checkLimit: deps.sessionPrCheckLimit,
      });
    });
    pi.on("session_shutdown", async (event, context) => {
      if (event?.reason === "reload" || typeof event?.reason !== "string") {
        return;
      }
      await deps.service.interruptSession(ownerFor(context), event.reason);
    });
    const refreshActivity = async (
      _event: unknown,
      context: ExtensionContext,
    ) => {
      await deps.service.refreshSessionActivity(ownerFor(context));
    };
    pi.on("turn_start", refreshActivity);
    pi.on("tool_execution_start", refreshActivity);
    pi.on("tool_execution_end", refreshActivity);
    pi.on("before_agent_start", () => undefined);
    pi.on("tool_call", async (event, context) => {
      if (event?.toolName === "worktree_pool" && isRecord(event.input)) {
        if (event.input.action === "acquire") {
          if (
            await deps.service.hasActiveTask(
              context.sessionManager.getSessionId(),
            )
          ) {
            return block(
              "An Active lifecycle task must use task_worktree_acquire so task/resource state stays coordinated.",
            );
          }
          return undefined;
        }
        if (
          event.input.action === "release" &&
          typeof event.input.claimId === "string" &&
          (await deps.service.isClaimAssociated(event.input.claimId))
        ) {
          return block(
            "This claim is lifecycle-associated; use task_worktree_release so release intent and completion are persisted.",
          );
        }
      }

      const toolName =
        typeof event?.toolName === "string" ? event.toolName : "";
      const requirement = classifyTaskToolRequirement(toolName, event?.input);
      if (requirement.kind === "none") return undefined;

      let activeTasks: LifecycleIssue[];
      try {
        activeTasks = await deps.service.activeTasksForSession(
          context.sessionManager.getSessionId(),
        );
      } catch {
        return block(`unable to verify Active task ownership for ${toolName}`);
      }

      if (activeTasks.length > 1) {
        const taskIds = activeTasks
          .map((issue) => issue.id)
          .sort((left, right) => left.localeCompare(right));
        return block(
          `session owns multiple Active tasks: ${taskIds.join(", ")}; repair lifecycle state before retrying`,
        );
      }

      const activeTask = activeTasks[0] ?? null;
      if (requirement.kind === "active-task") {
        return activeTask === null
          ? block(
              `${toolName} execution requires an Active task; claim a task before retrying`,
            )
          : undefined;
      }
      if (requirement.kind === "same-task") {
        if (activeTask === null) {
          return block(
            `${toolName} requires active task ${requirement.taskId}; claim it before retrying`,
          );
        }
        return activeTask.id === requirement.taskId
          ? undefined
          : block(
              `session owns active task ${activeTask.id}, not ${requirement.taskId}`,
            );
      }
      if (activeTask === null || activeTask.id === requirement.taskId) {
        return undefined;
      }
      return block(
        `session already owns active task ${activeTask.id}; wait, close, or relinquish it before claiming ${requirement.taskId}`,
      );
    });
  };
}

function toolResult(issue: LifecycleIssue) {
  const phase = issue.lifecycle?.phase ?? "legacy";
  return {
    content: [
      {
        type: "text" as const,
        text: `${issue.id}: ${phase} (${issue.status})`,
      },
    ],
    details: issue,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadConfig(): LifecycleConfig {
  const value: unknown = JSON.parse(
    readFileSync(new URL("./config.json", import.meta.url), "utf8"),
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task lifecycle config must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys: Array<keyof LifecycleConfig> = [
    "version",
    "executionTimeoutMs",
    "activityWriteIntervalMs",
    "sessionReconcileLimit",
    "sessionPrCheckLimit",
    "prPollIntervalMs",
    "maxBackoffMs",
    "warningErrorCount",
  ];
  if (record.version !== 1) {
    throw new Error("task lifecycle config version must be 1");
  }
  for (const key of keys.slice(1)) {
    if (!Number.isInteger(record[key]) || (record[key] as number) <= 0) {
      throw new Error(
        `task lifecycle config ${key} must be a positive integer`,
      );
    }
  }
  for (const key of Object.keys(record)) {
    if (!keys.includes(key as keyof LifecycleConfig)) {
      throw new Error(`task lifecycle config has unknown field ${key}`);
    }
  }
  return record as unknown as LifecycleConfig;
}

export default function taskLifecycle(pi: ExtensionApi): void {
  if (pi.exec === undefined) {
    throw new Error("task lifecycle requires Pi command execution");
  }
  const config = loadConfig();
  const store = createLifecycleStore(pi.exec.bind(pi), {
    store: resolveBeadsDir(),
  });
  const pool = {
    async list(repository?: string) {
      const runtime = await loadWorktreePoolRuntime(
        repository === undefined ? [] : [repository],
        "identity",
      );
      return runtime.pool.list(repository);
    },
    async acquire(
      request: Parameters<TaskLifecyclePoolPort["acquire"]>[0],
      owner: Parameters<TaskLifecyclePoolPort["acquire"]>[1],
      identity: Parameters<TaskLifecyclePoolPort["acquire"]>[2],
    ) {
      const runtime = await loadWorktreePoolRuntime(
        [request.repository],
        "acquire",
      );
      return runtime.pool.acquire(request, owner, identity);
    },
    async release(repository: string, claimId: string, owner: LockOwner) {
      const runtime = await loadWorktreePoolRuntime([repository], "identity");
      return runtime.pool.release(repository, claimId, owner);
    },
  };
  const checkAdapters = createCheckAdapterRegistry({
    execGh: async (args) => pi.exec!("gh", [...args]),
    now: Date.now,
    prPollIntervalMs: config.prPollIntervalMs,
  });
  const service = new TaskLifecycleService({
    store,
    now: Date.now,
    uuid: randomUUID,
    executionTimeoutMs: config.executionTimeoutMs,
    activityWriteIntervalMs: config.activityWriteIntervalMs,
    prPollIntervalMs: config.prPollIntervalMs,
    maxBackoffMs: config.maxBackoffMs,
    pool,
    checkAdapters,
  });
  createTaskLifecycleExtension({
    service,
    now: Date.now,
    pid: process.pid,
    hostname: readHostname(),
    activityWriteIntervalMs: config.activityWriteIntervalMs,
    sessionReconcileLimit: config.sessionReconcileLimit,
    sessionPrCheckLimit: config.sessionPrCheckLimit,
  })(pi);
}
