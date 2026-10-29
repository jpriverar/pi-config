import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateLifecycle } from "./model.js";
import { ownerOf } from "./ownership.js";
import {
  decodeLifecycleAny,
  fingerprintConditionV2,
  fingerprintObservationV2,
  validateLifecycleV2,
} from "./v2-model.js";
import type {
  LifecycleIssue,
  LifecycleMetadataV2,
  LifecycleStore,
  LockOwner,
  TaskCondition,
} from "./types.js";

export type LifecycleV2Classifications = Readonly<
  Record<string, { purpose: TaskCondition["purpose"]; reason: string }>
>;
export interface LifecycleV2MigrationPlan {
  version: 1;
  fingerprint: string;
  source: LifecycleIssue[];
  classifications: LifecycleV2Classifications;
  proposals: Array<{ id: string; lifecycle: LifecycleMetadataV2 }>;
  unchanged: string[];
  diagnostics: string[];
}
export interface LifecycleV2MigrationStore {
  applyLifecycleV2Migration(
    review: LifecycleV2MigrationPlan & { storePath: string },
    owner: LockOwner,
  ): Promise<LifecycleIssue[]>;
}
export async function readLifecycleV2MigrationSnapshot(
  store: Pick<LifecycleStore, "list" | "showMany">,
): Promise<LifecycleIssue[]> {
  const listed = await store.list([
    "open",
    "in_progress",
    "blocked",
    "deferred",
    "closed",
  ]);
  const ids = new Set(listed.map((row) => row.id));
  if (ids.size !== listed.length)
    throw new Error("migration snapshot has duplicate issue IDs");
  const full = await store.showMany([...ids]);
  if (
    full.length !== ids.size ||
    full.some((row) => !ids.has(row.id)) ||
    new Set(full.map((row) => row.id)).size !== ids.size
  )
    throw new Error(
      "migration snapshot is incomplete; report again before conversion",
    );
  return full;
}

export class LifecycleV2MigrationApplyError extends Error {
  constructor(
    readonly verifiedTaskIds: string[],
    readonly uncertainTaskId: string,
    cause: unknown,
  ) {
    super(
      `conversion stopped at ${uncertainTaskId}; verified conversions: ${verifiedTaskIds.join(", ") || "none"}; write may have applied. Inspect before retrying; no rollback attempted. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

export function planLifecycleV2Migration(
  issues: readonly LifecycleIssue[],
  classifications: LifecycleV2Classifications,
): LifecycleV2MigrationPlan {
  const source = structuredClone([...issues]);
  const rows = [...source].sort((a, b) => a.id.localeCompare(b.id));
  const plan: LifecycleV2MigrationPlan = {
    version: 1,
    fingerprint: "",
    source,
    classifications: structuredClone(classifications),
    proposals: [],
    unchanged: [],
    diagnostics: [],
  };
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== rows.length)
    plan.diagnostics.push(
      "duplicate issue IDs make the migration snapshot ambiguous",
    );
  const owners = new Map<string, string>();
  const resources = new Map<string, string>();
  const classified = new Set<string>();
  for (const row of rows) {
    try {
      if (!Object.hasOwn(row.metadata, "piLifecycle")) {
        if (row.lifecycle !== null)
          throw new Error("decoded lifecycle contradicts absent metadata");
        plan.unchanged.push(row.id);
        continue;
      }
      const decoded = decodeLifecycleAny(row.metadata.piLifecycle);
      if (!decoded.ok) throw new Error(decoded.warning);
      if (!isDeepStrictEqual(row.lifecycle, decoded.value))
        throw new Error("decoded lifecycle contradicts raw metadata");
      const lifecycle = decoded.value;
      if (
        lifecycle.activeCheck?.state === "satisfied" &&
        (lifecycle.activeCheck.lastObservation === null ||
          lifecycle.activeCheck.lastCheckedAt === null)
      )
        throw new Error(
          "satisfied check requires its persisted observation and timestamp before conversion",
        );
      const dependencies = row.dependencies.map((dep) => {
        if (dep.dependencyType !== "blocks") return dep;
        const blocker = byId.get(dep.id);
        if (!blocker) throw new Error(`missing native blocker ${dep.id}`);
        return { ...dep, status: blocker.status };
      });
      const owner = ownerOf(lifecycle);
      if (owner !== null) {
        const previous = owners.get(owner.sessionId);
        if (previous !== undefined)
          throw new Error(
            `session ${owner.sessionId} owns multiple tasks: ${previous}, ${row.id}`,
          );
        owners.set(owner.sessionId, row.id);
      }
      for (const resource of lifecycle.resources) {
        if (resource.cleanupState === "released") continue;
        if (resource.cleanupState !== "active")
          throw new Error(
            `resource ${resource.id} is ${resource.cleanupState}; reconcile it before conversion`,
          );
        for (const identity of [
          `claim:${resource.claimId}`,
          `slot:${resource.pathId}`,
          `path:${resource.path}`,
        ]) {
          const previous = resources.get(identity);
          if (previous !== undefined)
            throw new Error(
              `resource identity ${identity} is shared by ${previous} and ${row.id}`,
            );
          resources.set(identity, row.id);
        }
      }
      if (lifecycle.version === 2) {
        validateLifecycleV2(lifecycle, { ...row, dependencies, lifecycle });
        plan.unchanged.push(row.id);
        continue;
      }
      validateLifecycle(lifecycle, { ...row, dependencies });
      let condition: TaskCondition | null = null;
      if (lifecycle.waiting !== null) {
        classified.add(row.id);
        const classification = Object.hasOwn(classifications, row.id)
          ? classifications[row.id]
          : undefined;
        if (!classification)
          throw new Error(
            "condition requires an explicit purpose classification",
          );
        if (
          classification.purpose !== "completion" &&
          classification.purpose !== "continuation"
        )
          throw new Error("invalid condition purpose classification");
        if (
          typeof classification.reason !== "string" ||
          !classification.reason.trim()
        )
          throw new Error("classification reason must be non-empty");
        if (
          Object.keys(classification).some(
            (key) => key !== "purpose" && key !== "reason",
          )
        )
          throw new Error("unsupported classification field");
        if (
          classification.purpose !== "completion" &&
          (lifecycle.waiting.kind === "dependency" ||
            lifecycle.activeCheck?.state !== "satisfied")
        )
          throw new Error(
            "unmet legacy requirements must remain completion conditions",
          );
        condition = {
          id: `migration:${row.id}:${digest({ lifecycle, classification })}`,
          kind: lifecycle.waiting.kind,
          purpose: classification.purpose,
        };
      }
      const {
        execution: _execution,
        waiting: _waiting,
        version: _version,
        ...shared
      } = lifecycle;
      const converted: LifecycleMetadataV2 = {
        ...shared,
        version: 2,
        owner,
        condition,
        pause: null,
      };
      if (converted.phase === "waiting")
        converted.pause = {
          id: `migration-pause:${row.id}:${digest(lifecycle)}`,
          blockedAt: lifecycle.stateEnteredAt,
          conditionFingerprint: fingerprintConditionV2(
            converted,
            dependencies,
          )!,
          observationFingerprint: fingerprintObservationV2(converted),
        };
      validateLifecycleV2(converted, {
        ...row,
        dependencies,
        lifecycle: converted,
      });
      plan.proposals.push({ id: row.id, lifecycle: converted });
    } catch (error) {
      plan.diagnostics.push(
        `${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const id of Object.keys(classifications))
    if (!classified.has(id))
      plan.diagnostics.push(
        `${id}: classification does not identify a convertible legacy condition`,
      );
  plan.fingerprint = digest({
    version: plan.version,
    source: rows.map((row) => ({
      ...row,
      dependencies: [...row.dependencies].sort((a, b) =>
        `${a.id}:${a.dependencyType}`.localeCompare(
          `${b.id}:${b.dependencyType}`,
        ),
      ),
    })),
    classifications: plan.classifications,
    proposals: plan.proposals,
    unchanged: plan.unchanged,
    diagnostics: plan.diagnostics,
  });
  return plan;
}
