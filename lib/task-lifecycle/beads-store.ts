import { hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { BeadsExec, BeadsExecResult } from "../beads.js";
import {
  withFileOperationLock,
  type FileOperationLockDependencies,
} from "../file-operation-lock.js";
import { decodeLifecycle } from "./model.js";
import type {
  CreateTaskInput,
  LifecycleIssue,
  LifecycleMetadataV1,
  LifecycleStatus,
  LifecycleStore,
  LockOwner,
  Mutation,
  NativeDependency,
  UpdateTaskLabelsInput,
} from "./types.js";

export interface LifecycleStoreOptions {
  store: string;
  lockDependencies?: FileOperationLockDependencies;
}

interface DecodedIssue {
  issue: LifecycleIssue;
  rawMetadata: Record<string, unknown>;
}

const STATUSES: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
]);

export function createLifecycleStore(
  exec: BeadsExec,
  options: LifecycleStoreOptions,
): LifecycleStore {
  const store = options.store;
  const lockDependencies =
    options.lockDependencies ?? defaultLockDependencies();

  async function execute(
    operation: string,
    args: readonly string[],
  ): Promise<BeadsExecResult> {
    let result: BeadsExecResult;
    try {
      result = await exec("bd", [...args, "--db", store]);
    } catch (error) {
      const detail = hasCode(error, "ENOENT")
        ? "bd CLI is unavailable"
        : "bd execution failed";
      throw lifecycleStoreError(operation, store, detail);
    }
    if (result.code !== 0) {
      throw lifecycleStoreError(
        operation,
        store,
        `bd exited with exit code ${result.code}`,
      );
    }
    return result;
  }

  async function executeJson(
    operation: string,
    args: readonly string[],
  ): Promise<unknown> {
    const result = await execute(operation, args);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw lifecycleStoreError(operation, store, "bd returned malformed JSON");
    }
  }

  async function readOne(id: string, operation: string): Promise<DecodedIssue> {
    assertIdentifier(id, "issue id");
    const value = await executeJson(operation, [
      "show",
      id,
      "--long",
      "--json",
    ]);
    const records = decodeEnvelope(value, operation, store);
    if (records.length !== 1) {
      throw lifecycleStoreError(
        operation,
        store,
        `bd returned ${records.length} issues instead of one`,
      );
    }
    return decodeIssue(records[0], id, operation, store);
  }

  async function show(id: string): Promise<LifecycleIssue> {
    return (await readOne(id, `read issue ${id}`)).issue;
  }

  async function list(
    statuses: readonly LifecycleStatus[],
  ): Promise<LifecycleIssue[]> {
    if (statuses.length === 0) {
      throw lifecycleStoreError("list issues", store, "statuses are required");
    }
    for (const status of statuses) assertStatus(status, "list issue status");
    const value = await executeJson("list issues", [
      "list",
      "-s",
      statuses.join(","),
      "-n",
      "0",
      "--json",
    ]);
    return decodeEnvelope(value, "list issues", store).map(
      (record) => decodeIssue(record, undefined, "list issues", store).issue,
    );
  }

  async function readyIds(): Promise<ReadonlySet<string>> {
    const value = await executeJson("list ready issues", ["ready", "--json"]);
    const ids = decodeEnvelope(value, "list ready issues", store).map(
      (record) => {
        try {
          const issue = requireRecord(record, "ready issue");
          assertIdentifier(issue.id, "ready issue id");
          return issue.id;
        } catch (error) {
          throw lifecycleStoreError(
            "list ready issues",
            store,
            errorMessage(error),
          );
        }
      },
    );
    return new Set(ids);
  }

  async function create(
    input: CreateTaskInput,
    lifecycle: LifecycleMetadataV1,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    assertNonEmpty(input.title, "task title");
    assertNonEmpty(input.why, "task why");
    if (input.workstream?.includes(",")) {
      throw lifecycleStoreError(
        "create task",
        store,
        "workstream must not contain a comma",
      );
    }
    return withFileOperationLock(
      join(store, "pi-task-lifecycle"),
      owner,
      async () => {
        const labels = [
          ...(input.workstream === undefined
            ? []
            : [`workstream:${input.workstream}`]),
          ...(input.needsJp ? ["needs:jp"] : []),
        ];
        const args = [
          "create",
          input.title,
          "-d",
          input.why,
          ...(labels.length === 0 ? [] : ["-l", labels.join(",")]),
          "--metadata",
          JSON.stringify({ piLifecycle: lifecycle }),
          "--json",
        ];
        const value = await executeJson("create task", args);
        const record = isRecord(value)
          ? value
          : decodeEnvelope(value, "create task", store)[0];
        if (record === undefined) {
          throw lifecycleStoreError(
            "create task",
            store,
            "bd returned no created issue",
          );
        }
        const created = decodeIssue(record, undefined, "create task", store);
        return (await readOne(created.issue.id, "verify created task")).issue;
      },
      lockDependencies,
    );
  }

  async function updateLabels(
    id: string,
    input: UpdateTaskLabelsInput,
    owner: LockOwner,
  ): Promise<LifecycleIssue> {
    assertIdentifier(id, "issue id");
    return withFileOperationLock(
      join(store, "pi-task-lifecycle"),
      owner,
      async () => {
        const args = ["update", id];
        for (const label of input.addLabels) {
          assertNonEmpty(label, "label to add");
          args.push("--add-label", label);
        }
        for (const label of input.removeLabels) {
          assertNonEmpty(label, "label to remove");
          args.push("--remove-label", label);
        }
        await execute(`update labels ${id}`, [...args, "--json"]);
        return (await readOne(id, `verify labels ${id}`)).issue;
      },
      lockDependencies,
    );
  }

  async function appendComment(
    id: string,
    message: string,
    owner: LockOwner,
    validate: (issue: LifecycleIssue) => void,
  ): Promise<LifecycleIssue> {
    assertIdentifier(id, "issue id");
    assertNonEmpty(message, "task comment");
    return withFileOperationLock(
      join(store, "pi-task-lifecycle"),
      owner,
      async () => {
        const current = await readOne(id, `read issue ${id} before comment`);
        validate(current.issue);
        await execute(`append comment ${id}`, [
          "comments",
          "add",
          id,
          message,
          "--json",
        ]);
        return (await readOne(id, `verify comment ${id}`)).issue;
      },
      lockDependencies,
    );
  }

  async function mutate(
    id: string,
    owner: Parameters<LifecycleStore["mutate"]>[1],
    operation: (issue: LifecycleIssue) => Mutation,
  ): Promise<LifecycleIssue> {
    assertIdentifier(id, "issue id");
    return withFileOperationLock(
      join(store, "pi-task-lifecycle"),
      owner,
      async () => {
        const current = await readOne(id, `read issue ${id}`);
        const mutation = operation(current.issue);
        validateMutation(mutation, id, store);
        const mergedMetadata = mergeLifecycleMetadata(
          current.rawMetadata,
          mutation.lifecycle,
        );
        await execute(`write mutation ${id}`, [
          "update",
          id,
          "-s",
          mutation.status,
          "--metadata",
          JSON.stringify(mergedMetadata),
          "--json",
        ]);
        const verified = await readOne(id, `verify mutation ${id}`);
        verifyMutation(verified.issue, mutation, id, store);
        return verified.issue;
      },
      lockDependencies,
    );
  }

  async function addBlocker(
    dependentId: string,
    blockerId: string,
  ): Promise<void> {
    assertIdentifier(dependentId, "dependent issue id");
    assertIdentifier(blockerId, "blocker issue id");
    await execute(`add blocker ${blockerId} to ${dependentId}`, [
      "dep",
      "add",
      dependentId,
      blockerId,
      "--type",
      "blocks",
    ]);
  }

  return {
    show,
    list,
    readyIds,
    create,
    updateLabels,
    appendComment,
    mutate,
    addBlocker,
  };
}

function decodeEnvelope(
  value: unknown,
  operation: string,
  store: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw lifecycleStoreError(
      operation,
      store,
      "bd returned a non-array response",
    );
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw lifecycleStoreError(
        operation,
        store,
        `bd returned an invalid issue at index ${index}`,
      );
    }
    return item;
  });
}

function decodeIssue(
  record: Record<string, unknown>,
  expectedId: string | undefined,
  operation: string,
  store: string,
): DecodedIssue {
  try {
    assertIdentifier(record.id, "issue id");
    if (expectedId !== undefined && record.id !== expectedId) {
      throw new Error(`expected issue ${expectedId}, received ${record.id}`);
    }
    if (typeof record.title !== "string") {
      throw new Error("issue title must be text");
    }
    assertStatus(record.status, "issue status");
    const rawMetadata =
      record.metadata === undefined
        ? {}
        : requireRecord(record.metadata, "issue metadata");
    const rawLifecycle = rawMetadata.piLifecycle;
    const decodedLifecycle =
      rawLifecycle === undefined ? null : decodeLifecycle(rawLifecycle);
    const lifecycle =
      decodedLifecycle === null || !decodedLifecycle.ok
        ? null
        : decodedLifecycle.value;
    const dependencies = decodeDependencies(record.dependencies);
    const issue: LifecycleIssue = {
      id: record.id,
      title: record.title,
      status: record.status,
      metadata: rawMetadata,
      lifecycle,
      dependencies,
    };
    return { issue, rawMetadata };
  } catch (error) {
    throw lifecycleStoreError(operation, store, errorMessage(error));
  }
}

function decodeDependencies(value: unknown): NativeDependency[] {
  if (value === undefined || isDependencyEdgeSummaryList(value)) return [];
  if (!Array.isArray(value)) {
    throw new Error("invalid native dependencies: expected an array");
  }
  return value.map((item, index) => {
    try {
      const record = requireRecord(item, "native dependency");
      assertIdentifier(record.id, "native dependency id");
      assertStatus(record.status, "native dependency status");
      if (
        typeof record.dependency_type !== "string" ||
        record.dependency_type.length === 0
      ) {
        throw new Error("dependency_type must be non-empty text");
      }
      return {
        id: record.id,
        status: record.status,
        dependencyType: record.dependency_type,
      };
    } catch (error) {
      throw new Error(
        `invalid native dependency at index ${index}: ${errorMessage(error)}`,
      );
    }
  });
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

function validateMutation(
  mutation: Mutation,
  issueId: string,
  store: string,
): void {
  try {
    assertIdentifier(mutation.operationId, "mutation operation id");
    assertStatus(mutation.status, "mutation status");
    const decoded = decodeLifecycle(mutation.lifecycle);
    if (!decoded.ok) throw new Error(decoded.warning);
    if (
      !mutation.lifecycle.transitionHistory.some(
        (transition) => transition.operationId === mutation.operationId,
      )
    ) {
      throw new Error(
        `transition history does not contain operation ${mutation.operationId}`,
      );
    }
  } catch (error) {
    throw lifecycleStoreError(
      `prepare mutation ${issueId}`,
      store,
      errorMessage(error),
    );
  }
}

function mergeLifecycleMetadata(
  metadata: Record<string, unknown>,
  lifecycle: LifecycleMetadataV1,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "piLifecycle" || key.startsWith("piLifecycle.")) continue;
    merged[key] = value;
  }
  merged.piLifecycle = lifecycle;
  return merged;
}

function verifyMutation(
  actual: LifecycleIssue,
  expected: Mutation,
  issueId: string,
  store: string,
): void {
  const fail = (field: string): never => {
    throw lifecycleStoreError(
      `verify mutation ${issueId}`,
      store,
      `${field} did not match the requested mutation`,
    );
  };
  if (actual.status !== expected.status) fail("status");
  const lifecycle = actual.lifecycle;
  if (lifecycle === null) {
    throw lifecycleStoreError(
      `verify mutation ${issueId}`,
      store,
      "lifecycle did not match the requested mutation",
    );
  }
  if (lifecycle.phase !== expected.lifecycle.phase) fail("phase");
  if (!isDeepStrictEqual(lifecycle.execution, expected.lifecycle.execution))
    fail("execution");
  if (
    !isDeepStrictEqual(
      lifecycle.artifacts.map((artifact) => artifact.id),
      expected.lifecycle.artifacts.map((artifact) => artifact.id),
    )
  )
    fail("artifact IDs");
  if (
    !isDeepStrictEqual(
      lifecycle.resources.map((resource) => resource.id),
      expected.lifecycle.resources.map((resource) => resource.id),
    )
  )
    fail("resource IDs");
  if (
    !lifecycle.transitionHistory.some(
      (transition) => transition.operationId === expected.operationId,
    )
  )
    fail("operation ID");
}

function assertStatus(
  value: unknown,
  field: string,
): asserts value is LifecycleStatus {
  if (typeof value !== "string" || !STATUSES.has(value)) {
    throw new Error(`${field} is unsupported`);
  }
}

function assertNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
}

function assertIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} is invalid`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lifecycleStoreError(
  operation: string,
  store: string,
  detail: string,
): Error {
  return new Error(
    `Beads lifecycle ${operation} in store ${store} failed: ${detail}`,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLockDependencies(): FileOperationLockDependencies {
  return {
    now: Date.now,
    sleep: (milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    isPidAlive(pid) {
      try {
        process.kill(pid, 0);
        return "live";
      } catch (error) {
        return hasCode(error, "ESRCH") ? "dead" : "ambiguous";
      }
    },
    hostname: hostname(),
    timeoutMs: 5_000,
  };
}
