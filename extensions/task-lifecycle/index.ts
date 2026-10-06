import { randomUUID } from "node:crypto";
import {
  fingerprintCheck,
  type ReconcileRequest,
} from "../../lib/task-lifecycle/reconciliation.js";
import {
  ReconciliationClientError,
  ReconciliationUnknownResultError,
} from "../../lib/task-reconciler/client.js";
import type { ReconcileReply } from "../../lib/task-reconciler/protocol.js";
import {
  piReconcilerConfigPath,
  reconcilerSetupGuidance,
  requestPiReconciliation,
} from "../../lib/task-reconciler/pi-client.js";
import { fileURLToPath } from "node:url";

import { loadLifecycleConfig } from "../../lib/task-lifecycle/config.js";
import { hostname as readHostname } from "node:os";

import { resolveBeadsDir, type BeadsExec } from "../../lib/beads.js";
import type {
  AcquireResult,
  ClaimObservationTransaction,
} from "../worktree-pool/pool.js";
import { loadWorktreePoolRuntime } from "../worktree-pool/runtime.js";
import { registerTaskWorkState, type TaskWorkStateApi } from "./work-state.js";
import { createDeterministicGitArtifactClassifier } from "./git-artifact-command.js";
import { registerGitArtifactHooks } from "./git-artifact-hooks.js";
import { createGitArtifactObserver } from "./git-artifact-observer.js";
import { createLifecycleStore } from "../../lib/task-lifecycle/beads-store.js";
import { createCheckAdapterRegistry } from "../../lib/task-lifecycle/checks.js";
import { classifyTaskToolRequirement } from "../../lib/task-lifecycle/tool-guard.js";
import {
  TaskLifecycleService,
  WorktreeAssociationError,
  type CloseDispositionInput,
  type TaskLifecyclePoolPort,
  type TaskWorktreeAcquireRequest,
} from "../../lib/task-lifecycle/service.js";
import type {
  ArtifactInput,
  CreateTaskInput,
  LifecycleCheck,
  LifecycleIssue,
  LockOwner,
  PreparedWorktreeOperation,
  UpdateTaskLabelsInput,
} from "../../lib/task-lifecycle/types.js";

export interface TaskLifecycleToolService {
  create(input: CreateTaskInput, owner: LockOwner): Promise<LifecycleIssue>;
  updateLabels(
    taskId: string,
    input: UpdateTaskLabelsInput,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  log(
    taskId: string,
    message: string,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  defer(
    taskId: string,
    reason: string,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  waitOnExistingCondition(
    taskId: string,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
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
  preflightWorktreeAcquire(
    request: TaskWorktreeAcquireRequest,
    owner: LockOwner,
  ): Promise<void>;
  recordWorktreeAcquire(
    request: TaskWorktreeAcquireRequest,
    acquired: AcquireResult,
    owner: LockOwner,
    operationId?: string,
  ): Promise<LifecycleIssue>;
  associatedTasksForClaim(claimId: string): Promise<LifecycleIssue[]>;
  prepareWorktreeRelease(
    taskId: string,
    claimId: string,
    owner: LockOwner,
    operationId?: string,
  ): Promise<Extract<PreparedWorktreeOperation, { mode: "release" }>>;
  finalizeWorktreeRelease(
    context: Extract<PreparedWorktreeOperation, { mode: "release" }>,
    owner: LockOwner,
  ): Promise<LifecycleIssue>;
  activeTasksForSession(sessionId: string): Promise<LifecycleIssue[]>;
  recordObservedArtifacts(
    taskId: string,
    artifacts: readonly ArtifactInput[],
    owner: LockOwner,
    operationId: string,
  ): Promise<LifecycleIssue>;
}

interface ExtensionContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui?: { notify(message: string, level: "info" | "warning"): void };
}

type PendingPoolOperation =
  | {
      mode: "acquire";
      taskId: string;
      operationId: string;
      request: TaskWorktreeAcquireRequest;
    }
  | Extract<PreparedWorktreeOperation, { mode: "release" }>;

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
  registerCommand?(
    name: string,
    command: {
      description: string;
      handler(args: string, context: ExtensionContext): Promise<void>;
    },
  ): void;
  exec?: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeout?: number },
  ) => ReturnType<BeadsExec>;
}

export interface TaskLifecycleExtensionDependencies {
  service: TaskLifecycleToolService;
  reconciliation?: {
    issue(taskId: string): Promise<LifecycleIssue>;
    request(
      request: ReconcileRequest,
      signal?: AbortSignal,
    ): Promise<ReconcileReply>;
  };
  now(): number;
  pid: number;
  hostname: string;
  activityWriteIntervalMs: number;
  sessionReconcileLimit: number;
  sessionPrCheckLimit: number;
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
  return function taskLifecycleExtension(
    pi: ExtensionApi & TaskWorkStateApi,
  ): void {
    const ownerFor = (
      context: Pick<ExtensionContext, "sessionManager">,
    ): LockOwner => ({
      pid: deps.pid,
      sessionId: context.sessionManager.getSessionId(),
      host: deps.hostname,
      started: deps.now(),
    });
    const operationFor = (id: string, params: { operationId?: string }) =>
      params.operationId ?? id;
    const block = (reason: string) => ({ block: true, reason });
    const pendingPoolOperations = new Map<string, PendingPoolOperation>();

    pi.registerTool({
      name: "task_create",
      label: "Create task",
      description:
        "Create an explicitly approved lifecycle-managed work item in the Beads store.",
      parameters: objectSchema(
        {
          title: { type: "string", minLength: 1 },
          why: { type: "string", minLength: 1 },
          workstream: { type: "string", minLength: 1 },
          needs_jp: { type: "boolean" },
        },
        ["title", "why", "needs_jp"],
      ),
      async execute(_id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.create(
            {
              title: params.title,
              why: params.why,
              ...(params.workstream === undefined
                ? {}
                : { workstream: params.workstream }),
              needsJp: params.needs_jp,
            },
            ownerFor(context),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_update",
      label: "Update task labels",
      description:
        "Add or remove task labels without changing lifecycle state or ownership.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          add_labels: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
          remove_labels: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        ["taskId"],
      ),
      async execute(_id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.updateLabels(
            params.taskId,
            {
              addLabels: params.add_labels ?? [],
              removeLabels: params.remove_labels ?? [],
            },
            ownerFor(context),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_log",
      label: "Log task progress",
      description:
        "Append one plain-text progress entry to the active task's native comment journal.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          message: { type: "string", minLength: 1 },
        },
        ["taskId", "message"],
      ),
      async execute(_id, params, _signal, _update, context) {
        return toolResult(
          await deps.service.log(
            params.taskId,
            params.message,
            ownerFor(context),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_claim",
      label: "Claim task",
      description:
        "Claim one actionable task for the current Pi session. Ownership persists through inactivity and session shutdown.",
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
        "Wait on dependencies or one typed check after explicitly releasing all task worktrees with worktree_pool.",
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
        ["taskId"],
      ),
      async execute(id, params, _signal, _update, context) {
        const owner = ownerFor(context);
        const operationId = operationFor(id, params);
        if (params.kind === undefined) {
          if (params.blockerIds !== undefined || params.check !== undefined) {
            throw new Error(
              "task_wait kind is required when providing blockerIds or check",
            );
          }
          return toolResult(
            await deps.service.waitOnExistingCondition(
              params.taskId,
              owner,
              operationId,
            ),
          );
        }
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
      name: "task_defer",
      label: "Defer task",
      description:
        "Defer the current session's active task after explicitly releasing all task worktrees with worktree_pool.",
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
          await deps.service.defer(
            params.taskId,
            params.reason,
            ownerFor(context),
            operationFor(id, params),
          ),
        );
      },
    });

    pi.registerTool({
      name: "task_reconcile",
      label: "Reconcile task",
      description:
        "Ask the local daemon to reconcile a task. For ordinary reconciliation, supply taskId and omit or null the other fields. Manual outcomes apply only to a current manual check. Unknown outcomes include the exact binding to reuse on retry.",
      parameters: objectSchema(
        {
          taskId: taskIdProperty,
          manualOutcome: {
            type: ["string", "null"],
            enum: ["satisfied", "action_required", null],
          },
          requestId: { type: ["string", "null"], minLength: 1, maxLength: 256 },
          expectedCheckFingerprint: {
            type: ["string", "null"],
            pattern: "^[a-f0-9]{64}$",
          },
        },
        ["taskId"],
      ),
      async execute(id, params, signal) {
        const manualOutcome = params.manualOutcome ?? undefined;
        const requestId = params.requestId ?? undefined;
        const expectedCheckFingerprint =
          params.expectedCheckFingerprint ?? undefined;
        try {
          const request: ReconcileRequest = {
            taskId: params.taskId,
            requestId: requestId ?? id,
          };
          if (manualOutcome !== undefined) {
            request.manualOutcome = manualOutcome;
            if (requestId !== undefined) {
              if (expectedCheckFingerprint === undefined)
                throw new ReconciliationClientError(
                  "invalid_request",
                  "Manual retry requires the original request ID and fingerprint binding.",
                );
              request.expectedCheckFingerprint = expectedCheckFingerprint;
            } else {
              if (expectedCheckFingerprint !== undefined)
                throw new ReconciliationClientError(
                  "invalid_request",
                  "Retry fingerprint requires its original request ID.",
                );
              if (!deps.reconciliation)
                throw new ReconciliationClientError(
                  "unavailable",
                  reconcilerSetupGuidance,
                );
              const issue = await deps.reconciliation.issue(params.taskId);
              if (issue.lifecycle?.activeCheck?.kind !== "manual")
                throw new ReconciliationClientError(
                  "manual_check_required",
                  "Task has no current manual check.",
                );
              request.expectedCheckFingerprint = fingerprintCheck(issue)!;
            }
          } else if (expectedCheckFingerprint !== undefined)
            request.expectedCheckFingerprint = expectedCheckFingerprint;
          if (!deps.reconciliation)
            throw new ReconciliationClientError(
              "unavailable",
              reconcilerSetupGuidance,
            );
          const reply = await deps.reconciliation.request(
            request,
            signal instanceof AbortSignal ? signal : undefined,
          );
          return {
            content: [
              {
                type: "text",
                text: `${reply.task.id}: ${reply.outcome} (${reply.task.phase ?? reply.task.status})`,
              },
            ],
            details: reply,
          };
        } catch (error) {
          if (error instanceof ReconciliationUnknownResultError)
            throw new Error(
              `Reconciliation result unknown; retry this exact binding: ${JSON.stringify(error.request)}`,
            );
          const code =
            error instanceof ReconciliationClientError
              ? error.code
              : "request_failed";
          const message =
            code === "manual_check_required"
              ? "Task has no current manual check. For ordinary reconciliation, omit manualOutcome and expectedCheckFingerprint."
              : error instanceof ReconciliationClientError
                ? error.message
                : "Reconciliation request could not be prepared.";
          const guidance =
            code === "unavailable" || code === "incompatible"
              ? ` ${reconcilerSetupGuidance}`
              : "";
          throw new Error(
            `Reconciliation failed (${code}): ${message}${guidance}`,
          );
        }
      },
    });

    pi.registerTool({
      name: "task_close",
      label: "Close task",
      description:
        "Close a lifecycle task with an explicit disposition after releasing all task worktrees with worktree_pool.",
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
              ...(params.kind === "superseded" &&
              params.supersedingTaskId !== undefined
                ? { supersedingTaskId: params.supersedingTaskId }
                : {}),
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
        "Reopen a done or deferred lifecycle task, returning it to dependency waiting or actionable state.",
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

    pi.registerCommand?.("task-reconciler", {
      description:
        "Explicitly administer the opt-in local reconciliation daemon.",
      async handler(args, context) {
        const parts = args.trim() ? args.trim().split(/\s+/) : ["status"];
        const action = parts[0];
        if (
          ![
            "install",
            "start",
            "stop",
            "status",
            "update",
            "uninstall",
          ].includes(action) ||
          (parts.length > 1 &&
            !(
              parts.length === 2 &&
              action === "update" &&
              parts[1] === "--rollback"
            ))
        ) {
          context.ui?.notify(
            "Use /task-reconciler install|start|stop|status|update|uninstall; only update accepts --rollback.",
            "warning",
          );
          return;
        }
        if (!pi.exec) {
          context.ui?.notify("Pi command execution is unavailable.", "warning");
          return;
        }
        const launcher = fileURLToPath(
          new URL("../../bin/task-reconciler.mjs", import.meta.url),
        );
        context.ui?.notify(
          `Task reconciler: ${action}. No other service operation will be performed implicitly.`,
          "info",
        );
        try {
          const result = await pi.exec(
            process.execPath,
            [
              launcher,
              action,
              "--config",
              piReconcilerConfigPath(),
              ...parts.slice(1),
            ],
            {
              timeout:
                action === "install" || action === "update" ? 180_000 : 90_000,
            },
          );
          context.ui?.notify(
            (
              result.stdout ||
              result.stderr ||
              `task-reconciler exited ${result.code}`
            ).slice(0, 4000),
            result.code === 0 ? "info" : "warning",
          );
        } catch {
          context.ui?.notify(
            "Administration result unknown; inspect /task-reconciler status before retrying.",
            "warning",
          );
        }
      },
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
      const toolName =
        typeof event?.toolName === "string" ? event.toolName : "";
      if (
        toolName === "worktree_pool" &&
        isRecord(event.input) &&
        event.input.action === "release"
      ) {
        const prepared = await preparePoolRelease(
          event,
          context,
          ownerFor(context),
          deps.service,
        );
        if (prepared !== undefined && "operation" in prepared) {
          pendingPoolOperations.set(event.toolCallId, prepared.operation);
          return undefined;
        }
        return prepared;
      }

      const requirement = classifyTaskToolRequirement(toolName, event?.input);
      if (requirement.kind === "none") return undefined;

      const active = await activeTaskForProtectedCall(
        toolName,
        context,
        deps.service,
      );
      if ("block" in active) return active;
      const activeTask = active.task;

      if (requirement.kind === "active-task") {
        if (activeTask === null) {
          return block(
            toolName === "worktree_pool"
              ? "worktree_pool acquire requires an Active task; claim a task before retrying"
              : `${toolName} execution requires an Active task; claim a task before retrying`,
          );
        }
        if (
          toolName !== "worktree_pool" ||
          !isRecord(event.input) ||
          typeof event.toolCallId !== "string"
        ) {
          return undefined;
        }
        const repository = readNonEmptyString(event.input.repository);
        const branch = readNonEmptyString(event.input.branch);
        if (repository === null || branch === null) return undefined;
        const request: TaskWorktreeAcquireRequest = {
          taskId: activeTask.id,
          repository,
          branch,
          ...(readNonEmptyString(event.input.startPoint) === null
            ? {}
            : { startPoint: event.input.startPoint as string }),
        };
        try {
          await deps.service.preflightWorktreeAcquire(
            request,
            ownerFor(context),
          );
        } catch (error) {
          const reason =
            error instanceof WorktreeAssociationError
              ? `${error.message}; inspect the exact claim with worktree_pool list or repair before retrying`
              : "unable to verify worktree_pool acquire lifecycle state";
          return block(`${reason}; no worktree was allocated`);
        }
        pendingPoolOperations.set(event.toolCallId, {
          mode: "acquire",
          taskId: activeTask.id,
          operationId: event.toolCallId,
          request,
        });
        return undefined;
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

    pi.on("tool_result", async (event, context) => {
      if (
        event?.toolName !== "worktree_pool" ||
        typeof event.toolCallId !== "string"
      ) {
        return undefined;
      }
      const operation = pendingPoolOperations.get(event.toolCallId);
      if (operation === undefined) return undefined;
      pendingPoolOperations.delete(event.toolCallId);
      if (event.isError === true) return undefined;
      if (!isRecord(event.input) || event.input.action !== operation.mode) {
        return lifecycleFinalizationError(operation.mode);
      }

      if (operation.mode === "acquire") {
        const receipt = readAcquireReceipt(event.details);
        if (receipt === null) return lifecycleFinalizationError("acquire");
        try {
          await deps.service.recordWorktreeAcquire(
            operation.request,
            receipt,
            ownerFor(context),
            operation.operationId,
          );
          return undefined;
        } catch (error) {
          return lifecycleFinalizationError(
            "acquire",
            {
              taskId: operation.taskId,
              claimId: receipt.claimId,
            },
            error,
          );
        }
      }

      const released = readReleased(event.details);
      if (released === null) return lifecycleFinalizationError("release");
      if (!released) return undefined;
      try {
        await deps.service.finalizeWorktreeRelease(
          operation,
          ownerFor(context),
        );
        return undefined;
      } catch {
        return lifecycleFinalizationError("release", operation);
      }
    });

    if (pi.exec !== undefined) {
      const exec = pi.exec.bind(pi);
      registerGitArtifactHooks(pi, {
        service: deps.service,
        classifier: createDeterministicGitArtifactClassifier(),
        observer: createGitArtifactObserver({
          executor: {
            async run(executable, args, cwd) {
              const result = await exec(executable, args, {
                cwd,
                timeout: 10_000,
              });
              return {
                code: result.code,
                stdout: result.stdout,
                stderr: result.stderr,
              };
            },
          },
        }),
      });
    }

    registerTaskWorkState(pi);
  };
}

type BlockResult = { block: true; reason: string };

async function activeTaskForProtectedCall(
  toolName: string,
  context: ExtensionContext,
  service: TaskLifecycleToolService,
): Promise<{ task: LifecycleIssue | null } | BlockResult> {
  let activeTasks: LifecycleIssue[];
  try {
    activeTasks = await service.activeTasksForSession(
      context.sessionManager.getSessionId(),
    );
  } catch {
    return {
      block: true,
      reason: `unable to verify Active task ownership for ${toolName}`,
    };
  }
  if (activeTasks.length > 1) {
    const taskIds = activeTasks
      .map((issue) => issue.id)
      .sort((left, right) => left.localeCompare(right));
    return {
      block: true,
      reason: `session owns multiple Active tasks: ${taskIds.join(", ")}; repair lifecycle state before retrying`,
    };
  }
  return { task: activeTasks[0] ?? null };
}

async function preparePoolRelease(
  event: any,
  context: ExtensionContext,
  owner: LockOwner,
  service: TaskLifecycleToolService,
): Promise<
  | BlockResult
  | {
      operation: Extract<PreparedWorktreeOperation, { mode: "release" }>;
    }
  | undefined
> {
  const claimId = readNonEmptyString(event.input.claimId);
  if (claimId === null || typeof event.toolCallId !== "string") {
    return undefined;
  }

  let associated: LifecycleIssue[];
  try {
    associated = await service.associatedTasksForClaim(claimId);
  } catch {
    return {
      block: true,
      reason: "unable to verify worktree lifecycle association for release",
    };
  }
  if (associated.length === 0) return undefined;
  if (associated.length > 1) {
    const ids = associated
      .map((issue) => issue.id)
      .sort((left, right) => left.localeCompare(right));
    return {
      block: true,
      reason: `worktree claim ${claimId} is associated with multiple lifecycle tasks: ${ids.join(", ")}; repair lifecycle state before retrying`,
    };
  }

  const active = await activeTaskForProtectedCall(
    "worktree_pool",
    context,
    service,
  );
  if ("block" in active) return active;
  const task = associated[0];
  if (active.task === null) {
    return {
      block: true,
      reason: `worktree_pool release requires active task ${task.id}; claim it before retrying`,
    };
  }
  if (active.task.id !== task.id) {
    return {
      block: true,
      reason: `session owns active task ${active.task.id}, not ${task.id}`,
    };
  }

  try {
    const prepared = await service.prepareWorktreeRelease(
      task.id,
      claimId,
      owner,
      event.toolCallId,
    );
    return { operation: prepared };
  } catch {
    return {
      block: true,
      reason: "unable to prepare worktree_pool release lifecycle state",
    };
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readAcquireReceipt(value: unknown): AcquireResult | null {
  if (!isRecord(value)) return null;
  const claimId = readNonEmptyString(value.claimId);
  const path = readNonEmptyString(value.path);
  const branch = readNonEmptyString(value.branch);
  const head = readNonEmptyString(value.head);
  const startPoint = readNonEmptyString(value.startPoint);
  const startPointHead = readNonEmptyString(value.startPointHead);
  const relationship = value.relationship;
  if (
    claimId === null ||
    path === null ||
    branch === null ||
    head === null ||
    startPoint === null ||
    startPointHead === null ||
    typeof value.reused !== "boolean" ||
    typeof value.startPointFetched !== "boolean" ||
    (relationship !== "equal" &&
      relationship !== "contains-start-point" &&
      relationship !== "behind-start-point" &&
      relationship !== "diverged")
  ) {
    return null;
  }
  return {
    claimId,
    path,
    branch,
    reused: value.reused,
    head,
    startPoint,
    startPointHead,
    startPointFetched: value.startPointFetched,
    relationship,
  };
}

function readReleased(value: unknown): boolean | null {
  return isRecord(value) && typeof value.released === "boolean"
    ? value.released
    : null;
}

function lifecycleFinalizationError(
  mode: string,
  context?: { taskId: string; claimId: string },
  cause?: unknown,
) {
  const text =
    context === undefined
      ? `unable to finalize worktree_pool ${mode} lifecycle state`
      : `worktree_pool ${mode} completed for claim ${context.claimId}, but task ${context.taskId} lifecycle finalization failed; reconcile the task before continuing`;
  return {
    content: [
      {
        type: "text" as const,
        text:
          cause instanceof WorktreeAssociationError
            ? `${text}. ${cause.message}; inspect the existing claims before another acquire. The allocated worktree was not removed.`
            : text,
      },
    ],
    details:
      context === undefined
        ? { action: mode }
        : { action: mode, claimId: context.claimId, taskId: context.taskId },
    isError: true,
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

export default function taskLifecycle(
  pi: ExtensionApi & TaskWorkStateApi,
): void {
  if (pi.exec === undefined) {
    throw new Error("task lifecycle requires Pi command execution");
  }
  const config = loadLifecycleConfig(
    fileURLToPath(new URL("./config.json", import.meta.url)),
  );
  const storePath = resolveBeadsDir();
  const store = createLifecycleStore(pi.exec.bind(pi), {
    store: storePath,
  });
  const pool = {
    async list(repository?: string) {
      const runtime = await loadWorktreePoolRuntime(
        repository === undefined ? [] : [repository],
        "identity",
      );
      return runtime.pool.list(repository);
    },
    async withClaimObservation<T>(
      repository: string,
      claimId: string,
      owner: LockOwner,
      operation: ClaimObservationTransaction<T>,
    ) {
      const runtime = await loadWorktreePoolRuntime([repository], "identity");
      return runtime.pool.withClaimObservation(
        repository,
        claimId,
        owner,
        operation,
      );
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
    async release(
      repository: string,
      claimId: string,
      owner: LockOwner,
      transaction: Parameters<TaskLifecyclePoolPort["release"]>[3],
    ) {
      const runtime = await loadWorktreePoolRuntime([repository], "identity");
      return runtime.pool.release(repository, claimId, owner, transaction);
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
    reconciliation: {
      issue: (id) => store.show(id),
      request: (request, signal) =>
        requestPiReconciliation(request, signal, storePath),
    },
    now: Date.now,
    pid: process.pid,
    hostname: readHostname(),
    activityWriteIntervalMs: config.activityWriteIntervalMs,
    sessionReconcileLimit: config.sessionReconcileLimit,
    sessionPrCheckLimit: config.sessionPrCheckLimit,
  })(pi);
}
