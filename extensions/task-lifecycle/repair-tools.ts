import {
  WorktreeRepairError,
  type WorktreeRepairService,
} from "../../lib/task-lifecycle/worktree-repair.js";
import type { LockOwner } from "../../lib/task-lifecycle/types.js";

interface RepairContext {
  mode?: string;
  hasUI?: boolean;
  sessionManager: { getSessionId(): string };
  ui?: {
    confirm?(
      title: string,
      message: string,
      options?: { signal?: AbortSignal },
    ): Promise<boolean>;
    notify?(message: string, level: "info" | "warning"): void;
  };
}
interface RepairTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    id: string,
    params: any,
    signal: unknown,
    update: unknown,
    context: RepairContext,
  ): Promise<unknown>;
}

export function registerWorktreeRepairTools(
  pi: { registerTool(tool: RepairTool): void },
  deps: {
    service?: Pick<WorktreeRepairService, "preview" | "apply">;
    ownerFor(context: RepairContext): LockOwner;
  },
): void {
  const properties = {
    taskId: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
    },
    claimIds: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: {
        type: "string",
        pattern:
          "^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
      },
    },
  };
  const service = () => {
    if (!deps.service)
      throw new WorktreeRepairError(
        "Worktree repair is unavailable in this extension instance.",
      );
    return deps.service;
  };
  pi.registerTool({
    name: "task_worktree_repair_preview",
    label: "Preview task worktree repair",
    description:
      "Read-only preview of exact existing claims: cancel a failed release while retaining its checkout, or associate a healthy claim already owned by the target session. Returns a state fingerprint; never acquires, deletes, or transfers worktrees.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties,
      required: ["taskId", "claimIds"],
    },
    async execute(_id, params, signal) {
      try {
        abortSignal(signal)?.throwIfAborted();
        const plan = await service().preview(params.taskId, params.claimIds);
        return {
          content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
          details: plan,
        };
      } catch (error) {
        throw publicError(
          error,
          "Unable to inspect repair preview safely.",
          signal,
        );
      }
    },
  });
  pi.registerTool({
    name: "task_worktree_repair_apply",
    label: "Confirm task worktree repair",
    description:
      "Terminal-only, operator-confirmed application of a fresh task_worktree_repair_preview fingerprint. Keeps all files and the target session owner. Never bypass confirmation with Bash/service calls, never auto-retry denial or uncertain outcomes, and never treat design approval as approval of a live repair.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...properties,
        expectedFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["taskId", "claimIds", "expectedFingerprint"],
    },
    async execute(_id, params, signal, _update, context) {
      if (
        context.mode !== "tui" ||
        context.hasUI !== true ||
        typeof context.ui?.confirm !== "function"
      )
        throw new Error(
          "Worktree repair apply requires interactive terminal (TUI) confirmation.",
        );
      try {
        const cancellation = abortSignal(signal);
        cancellation?.throwIfAborted();
        const repairs = service();
        const plan = await repairs.preview(params.taskId, params.claimIds);
        if (plan.fingerprint !== params.expectedFingerprint)
          throw new WorktreeRepairError(
            "Repair preview is stale; state changed. Request a fresh preview.",
          );
        if (plan.claims.every((claim) => claim.action === "none")) {
          const result = { taskId: plan.taskId, repairedClaimIds: [] };
          return {
            content: [
              {
                type: "text",
                text: "Selected claims are already consistent; no repair was applied.",
              },
            ],
            details: result,
          };
        }
        const actor = deps.ownerFor(context);
        const approved = await context.ui.confirm(
          "Authorize these exact worktree repairs?",
          [
            `Initiating session: ${JSON.stringify(actor.sessionId)}`,
            "Confirm the target session remains idle. The original execution owner will be preserved.",
            "cancel_release: keep the checkout, restore its original native lock, and mark its pool/task association active.",
            "associate: register the existing active claim on the target task; do not allocate another checkout.",
            "No source files or submodules will be removed. Other claims will not be changed.",
            JSON.stringify(plan, null, 2),
          ].join("\n\n"),
          { signal: cancellation },
        );
        if (approved !== true)
          throw new WorktreeRepairError(
            "Worktree repair declined by operator; no repair was applied.",
          );
        cancellation?.throwIfAborted();
        const result = await repairs.apply(
          params.taskId,
          params.claimIds,
          plan.fingerprint,
          actor,
          cancellation,
        );
        return {
          content: [
            {
              type: "text",
              text: `Repaired ${result.repairedClaimIds.length} claim association(s) on ${result.taskId}; source files and original owner preserved.`,
            },
          ],
          details: result,
        };
      } catch (error) {
        throw publicError(
          error,
          "Repair did not complete; inspect a fresh preview before retrying.",
          signal,
        );
      }
    },
  });
}

function abortSignal(signal: unknown): AbortSignal | undefined {
  return signal instanceof AbortSignal ? signal : undefined;
}
function publicError(error: unknown, fallback: string, signal: unknown): Error {
  if (error instanceof WorktreeRepairError) return error;
  if (abortSignal(signal)?.aborted)
    return new Error("Worktree repair cancelled.");
  return new Error(fallback);
}
