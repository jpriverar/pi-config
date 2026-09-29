import { randomUUID } from "node:crypto";
import type {
  CheckAdapterRegistry,
  CheckObservation,
} from "../task-lifecycle/checks.js";
import {
  ReconciliationRequestError,
  reconciliationOperationId,
  scanReconciliation,
  type PreparedCheck,
  type ReconcileRequest,
  type ReconcileResult,
  type ReconciliationCandidate,
} from "../task-lifecycle/reconciliation.js";
import type { TaskLifecycleService } from "../task-lifecycle/service.js";
import type { LifecycleStore, LockOwner } from "../task-lifecycle/types.js";
import type { DaemonConfig } from "./config.js";

export class ReconciliationQueueError extends Error {
  constructor(
    readonly code:
      | "queue_full"
      | "not_running"
      | "stopped"
      | "execution_failed",
    message: string,
    readonly outcomeUnknown = false,
  ) {
    super(message);
  }
}

export interface QueueDiagnostic {
  taskId?: string;
  code: string;
  count: number;
  lastSeenAt: string;
}
export interface QueueSnapshot {
  lastScanAttemptAt: string | null;
  lastScanSuccessAt: string | null;
  queued: number;
  localRunning: number;
  externalRunning: number;
  diagnostics: readonly QueueDiagnostic[];
}
export interface Reconciler {
  start(): void;
  reconcile(request: ReconcileRequest): Promise<ReconcileResult>;
  snapshot(): QueueSnapshot;
  stop(): Promise<void>;
}
export interface ReconcilerDependencies {
  store: LifecycleStore;
  service: TaskLifecycleService;
  adapters: CheckAdapterRegistry;
  owner: LockOwner;
  config: DaemonConfig;
  now(): number;
  abortLocalCommands(): void;
}
interface Entry {
  request: ReconcileRequest;
  binding: string;
  source: "scheduled" | "explicit";
  promise: Promise<ReconcileResult>;
  resolve(result: ReconcileResult): void;
  reject(error: Error): void;
}
interface Job {
  taskId: string;
  current: Entry;
  pending: Entry[];
  state:
    | "queued"
    | "preparing"
    | "remote_ready"
    | "observing"
    | "apply_ready"
    | "applying";
  prepared?: PreparedCheck;
  observation?: CheckObservation;
  controller?: AbortController;
}

export function createReconciler(deps: ReconcilerDependencies): Reconciler {
  const { limits } = deps.config;
  const jobs = new Map<string, Job>();
  const requests = new Map<string, Entry>();
  const backlog = new Map<string, ReconciliationCandidate>();
  const backoff = new Map<string, { failures: number; nextAt: number }>();
  const diagnostics = new Map<string, QueueDiagnostic>();
  const work = new Set<Promise<void>>();
  let started = false;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let scanDue = false;
  let scanning = false;
  let localBusy = false;
  let externalRunning = 0;
  let nextSource: Entry["source"] = "explicit";
  let pumpScheduled = false;
  let lastScanAttemptAt: string | null = null;
  let lastScanSuccessAt: string | null = null;

  const timestamp = () => new Date(deps.now()).toISOString();
  function diagnostic(code: string, taskId?: string): void {
    const key = JSON.stringify([code, taskId]);
    const count = (diagnostics.get(key)?.count ?? 0) + 1;
    diagnostics.delete(key);
    diagnostics.set(key, {
      code,
      ...(taskId === undefined ? {} : { taskId }),
      count,
      lastSeenAt: timestamp(),
    });
    while (diagnostics.size > 20)
      diagnostics.delete(diagnostics.keys().next().value!);
  }
  function clearDiagnostic(code: string, taskId?: string): void {
    diagnostics.delete(JSON.stringify([code, taskId]));
  }
  function track(promise: Promise<void>): void {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => {
        work.delete(promise);
        diagnostic("reconciler_internal_failure");
      },
    );
  }
  function enqueuePump(): void {
    if (pumpScheduled || stopping || !started) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }
  function entry(request: ReconcileRequest, source: Entry["source"]): Entry {
    let resolve!: Entry["resolve"];
    let reject!: Entry["reject"];
    const promise = new Promise<ReconcileResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    if (source === "scheduled") void promise.catch(() => {});
    const value = {
      request: structuredClone(request),
      binding: reconciliationOperationId(request),
      source,
      promise,
      resolve,
      reject,
    };
    requests.set(request.requestId, value);
    return value;
  }
  function admitScheduled(): void {
    for (const [id] of backlog) {
      if (requests.size >= limits.maxQueuedTasks) return;
      backlog.delete(id);
      if (jobs.has(id) || (backoff.get(id)?.nextAt ?? 0) > deps.now()) continue;
      const current = entry(
        { requestId: `auto-${randomUUID()}`, taskId: id },
        "scheduled",
      );
      jobs.set(id, { taskId: id, current, pending: [], state: "queued" });
    }
  }
  function finish(job: Job, result?: ReconcileResult, error?: Error): void {
    requests.delete(job.current.request.requestId);
    if (error || stopping)
      job.current.reject(
        error ??
          new ReconciliationQueueError(
            "stopped",
            "reconciler stopped; result may be unknown",
            true,
          ),
      );
    else job.current.resolve(result!);
    if (stopping) {
      for (const pending of job.pending) {
        requests.delete(pending.request.requestId);
        pending.reject(
          new ReconciliationQueueError(
            "stopped",
            "reconciler stopped before request completion",
          ),
        );
      }
      jobs.delete(job.taskId);
    } else if (job.pending.length > 0) {
      job.current = job.pending.shift()!;
      job.state = "queued";
      job.prepared = undefined;
      job.observation = undefined;
      job.controller = undefined;
    } else jobs.delete(job.taskId);
    enqueuePump();
  }
  function failLocal(job: Job, error: unknown): void {
    if (!stopping && error instanceof ReconciliationRequestError) {
      finish(job, undefined, error);
      return;
    }
    if (!stopping) {
      const failures = (backoff.get(job.taskId)?.failures ?? 0) + 1;
      backoff.set(job.taskId, {
        failures,
        nextAt:
          deps.now() +
          Math.min(
            limits.localFailureMaxMs,
            limits.localFailureBaseMs * 2 ** Math.min(30, failures - 1),
          ),
      });
      diagnostic("local_reconciliation_failed", job.taskId);
    }
    finish(
      job,
      undefined,
      new ReconciliationQueueError(
        stopping ? "stopped" : "execution_failed",
        stopping
          ? "reconciler stopped; result may be unknown"
          : "local reconciliation failed; inspect daemon health",
        true,
      ),
    );
  }
  function succeeded(job: Job, result: ReconcileResult): void {
    backoff.delete(job.taskId);
    clearDiagnostic("local_reconciliation_failed", job.taskId);
    finish(job, result);
  }
  function runLocal(fn: () => Promise<void>): void {
    localBusy = true;
    track(
      (async () => {
        try {
          await fn();
        } finally {
          localBusy = false;
          enqueuePump();
        }
      })(),
    );
  }
  async function scan(): Promise<void> {
    scanning = true;
    lastScanAttemptAt = timestamp();
    try {
      const snapshot = await scanReconciliation(deps.store, deps.now());
      if (stopping) return;
      lastScanSuccessAt = timestamp();
      const currentDiagnostics = new Set(
        snapshot.diagnostics.map((item) =>
          JSON.stringify([item.code, item.taskId]),
        ),
      );
      for (const [key, value] of diagnostics) {
        if (
          [
            "scan_failed",
            "malformed_lifecycle",
            "blocker_lookup_failed",
            "blocker_unavailable",
            "blocker_id_too_large",
          ].includes(value.code) &&
          !currentDiagnostics.has(key)
        )
          diagnostics.delete(key);
      }
      for (const item of snapshot.diagnostics)
        diagnostic(item.code, item.taskId);
      const eligible = new Set(snapshot.candidates.map((c) => c.taskId));
      for (const id of backlog.keys())
        if (!eligible.has(id)) backlog.delete(id);
      for (const id of backoff.keys())
        if (!eligible.has(id)) backoff.delete(id);
      for (const candidate of snapshot.candidates) {
        if (!jobs.has(candidate.taskId) && !backlog.has(candidate.taskId))
          backlog.set(candidate.taskId, candidate);
      }
    } catch {
      if (!stopping) diagnostic("scan_failed");
    } finally {
      scanning = false;
    }
  }
  async function prepare(job: Job): Promise<void> {
    try {
      const prepared = await deps.service.prepareReconciliation(
        job.current.request,
        deps.owner,
      );
      if (stopping) {
        finish(job);
        return;
      }
      if (prepared.kind === "complete") {
        succeeded(job, { outcome: prepared.outcome, issue: prepared.issue });
        return;
      }
      job.prepared = prepared.prepared;
      if (prepared.prepared.check.kind === "github_pull_request") {
        job.state = "remote_ready";
        return;
      }
      job.observation = await deps.adapters.observe(
        prepared.prepared.check,
        prepared.prepared.artifacts,
        { manualOutcome: prepared.prepared.manualOutcome },
      );
      if (stopping) {
        finish(job);
        return;
      }
      job.state = "applying";
      succeeded(
        job,
        await deps.service.applyReconciliation(
          prepared.prepared,
          job.observation,
          deps.owner,
        ),
      );
    } catch (error) {
      failLocal(job, error);
    }
  }
  async function apply(job: Job): Promise<void> {
    try {
      const result = await deps.service.applyReconciliation(
        job.prepared!,
        job.observation!,
        deps.owner,
      );
      if (!stopping && result.outcome === "applied") {
        if (job.observation!.outcome === "error")
          diagnostic("check_error", job.taskId);
        else clearDiagnostic("check_error", job.taskId);
      }
      succeeded(job, result);
    } catch (error) {
      failLocal(job, error);
    }
  }
  function observe(job: Job): void {
    job.state = "observing";
    const controller = new AbortController();
    job.controller = controller;
    externalRunning += 1;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.observationTimeoutMs);
    track(
      (async () => {
        try {
          try {
            job.observation = await deps.adapters.observe(
              job.prepared!.check,
              job.prepared!.artifacts,
              {
                signal: controller.signal,
                manualOutcome: job.prepared!.manualOutcome,
              },
            );
          } catch {
            job.observation = {
              outcome: "error",
              observation: "external check failed; inspect daemon health",
            };
          }
          if (stopping) finish(job);
          else {
            if (timedOut)
              job.observation = {
                outcome: "error",
                observation: "external check observation timed out",
              };
            job.state = "apply_ready";
          }
        } finally {
          clearTimeout(deadline);
          externalRunning -= 1;
          job.controller = undefined;
          enqueuePump();
        }
      })(),
    );
  }
  function pump(): void {
    if (!started || stopping) return;
    admitScheduled();
    for (const job of jobs.values()) {
      if (externalRunning >= limits.externalConcurrency) break;
      if (job.state === "remote_ready") observe(job);
    }
    if (localBusy) return;
    if (scanDue) {
      scanDue = false;
      runLocal(scan);
      return;
    }
    const ready = [...jobs.values()].filter(
      (job) => job.state === "queued" || job.state === "apply_ready",
    );
    const preferred = ready.filter((job) => job.current.source === nextSource);
    const candidates = preferred.length > 0 ? preferred : ready;
    const next =
      candidates.find((job) => job.state === "apply_ready") ?? candidates[0];
    if (next) {
      nextSource =
        next.current.source === "explicit" ? "scheduled" : "explicit";
      if (next.state === "apply_ready") {
        next.state = "applying";
        runLocal(() => apply(next));
      } else {
        next.state = "preparing";
        runLocal(() => prepare(next));
      }
    }
  }

  return {
    start() {
      if (stopping) throw new Error("reconciler is stopped");
      if (started) return;
      started = true;
      scanDue = true;
      timer = setInterval(() => {
        if (scanning || scanDue) return;
        scanDue = true;
        enqueuePump();
      }, limits.scanIntervalMs);
      enqueuePump();
    },
    async reconcile(request) {
      if (!started || stopping)
        throw new ReconciliationQueueError(
          "not_running",
          "reconciler is not running or is stopping",
        );
      if (
        typeof request.taskId !== "string" ||
        request.taskId.length === 0 ||
        request.taskId.length > 256 ||
        request.taskId.startsWith("-") ||
        /[\u0000-\u001f\u007f]/.test(request.taskId)
      )
        throw new ReconciliationRequestError(
          "invalid_request",
          "invalid reconciliation taskId",
        );
      const binding = reconciliationOperationId(request);
      const existing = requests.get(request.requestId);
      if (existing) {
        if (existing.binding !== binding)
          throw new ReconciliationRequestError(
            "request_conflict",
            "conflicting reconciliation request",
          );
        return existing.promise;
      }
      const job = jobs.get(request.taskId);
      if (
        job &&
        request.manualOutcome !== undefined &&
        [job.current, ...job.pending].some(
          (e) =>
            e.request.manualOutcome !== undefined &&
            e.request.manualOutcome !== request.manualOutcome,
        )
      )
        throw new ReconciliationRequestError(
          "request_conflict",
          "conflicting manual reconciliation outcomes",
        );
      if (requests.size >= limits.maxQueuedTasks)
        throw new ReconciliationQueueError(
          "queue_full",
          "reconciliation queue is full",
        );
      const pending = entry(request, "explicit");
      backlog.delete(request.taskId);
      if (job) job.pending.push(pending);
      else
        jobs.set(request.taskId, {
          taskId: request.taskId,
          current: pending,
          pending: [],
          state: "queued",
        });
      enqueuePump();
      return pending.promise;
    },
    snapshot() {
      const counts = { queued: 0, localRunning: 0, externalRunning: 0 };
      for (const job of jobs.values()) {
        if (job.state === "observing") counts.externalRunning += 1;
        else if (job.state === "preparing" || job.state === "applying")
          counts.localRunning += 1;
        else counts.queued += 1;
      }
      return {
        lastScanAttemptAt,
        lastScanSuccessAt,
        ...counts,
        diagnostics: [...diagnostics.values()].map((d) => ({ ...d })),
      };
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      clearInterval(timer);
      deps.abortLocalCommands();
      for (const job of [...jobs.values()]) {
        job.controller?.abort();
        if (!["preparing", "observing", "applying"].includes(job.state))
          finish(job);
      }
      stopPromise = (async () => {
        await Promise.allSettled([...work]);
        for (const job of [...jobs.values()]) finish(job);
        backlog.clear();
        backoff.clear();
      })();
      return stopPromise;
    },
  };
}
