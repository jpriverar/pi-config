import { isDeepStrictEqual } from "node:util";
import type { LifecycleStore, LockOwner } from "../task-lifecycle/types.js";
import {
  decodeWorkManagement,
  desiredWorkManagementStatus,
  LOG_TAG,
  type WorkManagementConfig,
  type WorkManagementState,
  type WorkManagementStore,
} from "./model.js";
import type {
  DatadogOperationRequest,
  DatadogOutcome,
  DatadogPreparation,
} from "./datadog.js";

export type SyncResult = "idle" | "delivered" | "retry" | "attention";
export interface WorkManagementSync {
  candidates(): Promise<string[]>;
  step(taskId: string, signal?: AbortSignal): Promise<SyncResult>;
}
export interface SyncDependencies {
  store: LifecycleStore & WorkManagementStore;
  owner: LockOwner;
  readConfig(): WorkManagementConfig | null;
  prepare(
    request: DatadogOperationRequest,
    signal?: AbortSignal,
  ): Promise<DatadogPreparation>;
  now(): number;
  retryBaseMs: number;
  retryMaxMs: number;
}

function attention(
  state: WorkManagementState,
  code: string,
): WorkManagementState {
  return {
    ...state,
    failure: {
      kind: "attention",
      code,
      count: (state.failure?.count ?? 0) + 1,
      retryAt: null,
    },
  };
}
export function createWorkManagementSync(
  deps: SyncDependencies,
): WorkManagementSync {
  return {
    async candidates() {
      const issues = await deps.store.list([
        "open",
        "in_progress",
        "blocked",
        "deferred",
        "closed",
      ]);
      return issues
        .filter((issue) => {
          if (issue.metadata.piWorkManagement === undefined) return false;
          try {
            const state = decodeWorkManagement(
              issue.metadata.piWorkManagement,
            )!;
            return (
              state.failure?.kind !== "attention" &&
              (state.failure?.retryAt ?? 0) <= deps.now()
            );
          } catch {
            return true;
          }
        })
        .map((issue) => issue.id);
    },
    async step(taskId, signal) {
      if (signal?.aborted) return "idle";
      const before = decodeWorkManagement(
        (await deps.store.show(taskId)).metadata.piWorkManagement,
      );
      if (!before) return "idle";
      if (before.failure?.kind === "attention") return "attention";
      if ((before.failure?.retryAt ?? 0) > deps.now()) return "idle";
      const comments =
        before.remote && !before.inFlight
          ? await deps.store.comments(taskId)
          : [];
      const pending: {
        request?: DatadogOperationRequest;
        state?: WorkManagementState;
        result: SyncResult;
      } = { result: "idle" };
      await deps.store.mutateWorkManagement(taskId, deps.owner, (issue) => {
        const state = decodeWorkManagement(issue.metadata.piWorkManagement);
        if (!state) return null;
        if (state.failure?.kind === "attention") {
          pending.result = "attention";
          return null;
        }
        if ((state.failure?.retryAt ?? 0) > deps.now()) return null;
        if (state.inFlight) {
          pending.result = "attention";
          return attention(state, "outcome_unknown");
        }
        try {
          if (!deps.readConfig()) throw new Error("missing config");
        } catch {
          pending.result = "attention";
          return attention(state, "configuration_unavailable");
        }
        const desired = desiredWorkManagementStatus(
          state.target,
          issue.lifecycle,
        );
        if (!desired) {
          pending.result = "attention";
          return attention(state, "lifecycle_unavailable");
        }
        const request: DatadogOperationRequest = {
          taskId,
          target: state.target,
          operation: { kind: "create" },
        };
        if (!state.remote) request.initial = state.initial;
        else {
          request.remoteId = state.remote.id;
          if (desired !== state.lastSentStatus)
            request.operation = { kind: "status", statusName: desired };
          else {
            const comment = comments.find(
              (c) =>
                c.text.endsWith(LOG_TAG) &&
                !state.deliveredCommentIds.includes(c.id),
            );
            if (!comment) return null;
            request.operation = { kind: "comment", commentId: comment.id };
            request.comment = comment;
          }
        }
        pending.request = request;
        pending.state = state;
        return null;
      });
      const request = pending.request;
      if (!request) return pending.result;
      let prepared: DatadogPreparation;
      try {
        prepared = signal?.aborted
          ? { kind: "retryable", code: "interrupted" }
          : await deps.prepare(request, signal);
      } catch {
        prepared = { kind: "retryable", code: "preparation_failed" };
      }
      let expected = pending.state!;
      let reserved = false;
      let outcome: DatadogOutcome;
      if (prepared.kind === "ready") {
        if (signal?.aborted) return "idle";
        await deps.store.mutateWorkManagement(taskId, deps.owner, (issue) => {
          const state = decodeWorkManagement(issue.metadata.piWorkManagement);
          if (!isDeepStrictEqual(state, expected)) return null;
          expected = { ...expected, inFlight: request.operation };
          reserved = true;
          return expected;
        });
        if (!reserved) return "idle";
        try {
          outcome = signal?.aborted
            ? { kind: "unknown", code: "interrupted" }
            : await prepared.send();
        } catch {
          outcome = { kind: "unknown", code: "outcome_unknown" };
        }
      } else outcome = prepared;
      let result: SyncResult = "idle";
      await deps.store.mutateWorkManagement(taskId, deps.owner, (issue) => {
        const state = decodeWorkManagement(issue.metadata.piWorkManagement)!;
        if (!isDeepStrictEqual(state, expected)) {
          if (reserved)
            throw new Error(`work management attempt changed for ${taskId}`);
          return null;
        }
        result = "attention";
        if (outcome.kind === "success") {
          if (request.operation.kind === "create") {
            if (!outcome.remote)
              return attention(state, "missing_remote_identity");
            state.remote = outcome.remote;
            state.lastSentStatus = state.target.statuses.actionable;
          } else if (request.operation.kind === "status")
            state.lastSentStatus = request.operation.statusName;
          else state.deliveredCommentIds.push(request.operation.commentId);
          state.inFlight = null;
          state.failure = null;
          result = "delivered";
          return state;
        }
        if (outcome.kind === "unknown") return attention(state, outcome.code);
        state.inFlight = null;
        if (outcome.kind === "rejected") return attention(state, outcome.code);
        const count = (state.failure?.count ?? 0) + 1;
        const delay = Math.max(
          outcome.retryAfterMs ?? 0,
          Math.min(
            deps.retryMaxMs,
            deps.retryBaseMs * 2 ** Math.min(30, count - 1),
          ),
        );
        if (!Number.isSafeInteger(deps.now() + delay))
          return attention(state, "invalid_retry_delay");
        state.failure = {
          kind: "retryable",
          code: outcome.code,
          count,
          retryAt: deps.now() + delay,
        };
        result = "retry";
        return state;
      });
      return result;
    },
  };
}
