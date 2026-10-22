import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { withFileOperationLock } from "../file-operation-lock.js";
import { collectProjects } from "../project-management.js";
import {
  decodeProjectRenameRegistry,
  resolveProjectRename,
  type ProjectRenameRegistry,
} from "../project-renames.js";
import {
  decodeProjectArchiveRegistry,
  type ProjectArchiveRegistry,
} from "../project-archives.js";
import { localPidState } from "../task-reconciler/files.js";
import { decodeWorkManagementConfig } from "../work-management/config.js";
import type {
  CatalogWorkManagementConfig,
  LegacyWorkManagementConfig,
  WorkManagementConfig,
} from "../work-management/model.js";
import type { BeadsIssue } from "../beads.js";
import {
  catalogId,
  catalogName,
  fields,
  object,
  decodePublication,
  decodeWorkCatalog,
  encodeWorkCatalog,
  validateDescription,
  type CatalogIssue,
  type WorkCatalog,
} from "./model.js";
import { resolveTaskMembership } from "./membership.js";
import { destinationMismatchCount } from "./service.js";
import { publicationSummary } from "./presentation.js";
import type { CatalogStore } from "./store.js";

export interface MigrationSnapshot {
  store: string;
  catalog: WorkCatalog | null;
  issues: CatalogIssue[];
  renames: ProjectRenameRegistry;
  archives: ProjectArchiveRegistry;
  config: WorkManagementConfig | null;
}
interface MigrationDiagnostics {
  unscopedTasks: number;
  unclassifiedProjects: string[];
  missingDescriptions: string[];
  previousDestinations: { projectId: string; count: number }[];
  legacyRouting: { workstream: string; publication: string }[];
}
export interface CatalogMigrationPlan {
  version: 1;
  id: string;
  store: string;
  sourceFingerprint: string;
  sourceConfig: LegacyWorkManagementConfig | null;
  catalog: WorkCatalog;
  config: CatalogWorkManagementConfig;
  diagnostics: MigrationDiagnostics;
}
export interface CatalogMigrationDependencies {
  storePath: string;
  readSnapshot(): Promise<MigrationSnapshot>;
  catalog: CatalogStore;
  backup(plan: CatalogMigrationPlan): Promise<void>;
  verifyBackup(plan: CatalogMigrationPlan): Promise<void>;
  writeConfig(config: CatalogWorkManagementConfig): Promise<void>;
  verifyRuntime(): Promise<void>;
}
export const MAX_MIGRATION_BYTES = 1024 * 1024;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
function equal(a: unknown, b: unknown): boolean {
  return hash(a) === hash(b);
}
function path(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Migration requires an absolute verified store path");
  return value;
}
function sourceFingerprint(snapshot: MigrationSnapshot): string {
  const ids = new Set<string>();
  const issues = snapshot.issues
    .map((issue) => {
      if (ids.has(issue.id))
        throw new Error("Migration source contains duplicate task IDs");
      ids.add(issue.id);
      return {
        id: issue.id,
        status: issue.status,
        labels: [
          ...new Set(issue.labels.filter((l) => l.startsWith("workstream:"))),
        ].sort(),
        projectReference: issue.projectReference ?? { kind: "absent" },
        capturedDestination: issue.capturedDestination ?? null,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hash({
    store: path(snapshot.store),
    issues,
    renames: decodeProjectRenameRegistry(snapshot.renames),
    archives: decodeProjectArchiveRegistry(snapshot.archives),
  });
}
function inventory(snapshot: MigrationSnapshot) {
  const renames = decodeProjectRenameRegistry(snapshot.renames);
  const canonical = (name: string) => {
    catalogName(name);
    const next = resolveProjectRename(renames, name);
    if (
      Object.hasOwn(renames.aliases, name.toLowerCase()) &&
      next === undefined
    )
      throw new Error(
        `Migration alias cycle or collision at ${JSON.stringify(name)}`,
      );
    return next ?? name;
  };
  const observed = collectProjects(
    [...snapshot.issues]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((issue) => ({ ...issue, title: "" })) as BeadsIssue[],
  );
  const names = [
    ...observed.flatMap((p) => [...p.variants]),
    ...snapshot.archives.archived,
    ...Object.keys(renames.aliases),
    ...Object.values(renames.aliases),
  ];
  const groups = new Map<string, Set<string>>();
  for (const name of names.sort()) {
    const key = canonical(name).toLowerCase();
    const aliases = groups.get(key) ?? new Set<string>();
    aliases.add(name.toLowerCase());
    aliases.add(key);
    groups.set(key, aliases);
  }
  return groups;
}
export function buildCatalogMigration(
  snapshot: MigrationSnapshot,
  value: unknown,
  uuid: () => string = randomUUID,
): CatalogMigrationPlan {
  if (snapshot.catalog !== null || snapshot.config?.version === 2)
    throw new Error(
      "Migration preview requires a legacy store with no catalog; inspect an existing prepared/active plan instead",
    );
  if (
    snapshot.issues.some(
      (i) => i.projectReference && i.projectReference.kind !== "absent",
    )
  )
    throw new Error(
      "Legacy migration cannot reinterpret existing project references",
    );
  const sourceConfig =
    snapshot.config === null
      ? null
      : (decodeWorkManagementConfig(
          snapshot.config,
        ) as LegacyWorkManagementConfig);
  const input = object(value);
  const assignments = fields(input, [
    "version",
    "areas",
    "projects",
    ...(Object.hasOwn(input, "helpers") ? ["helpers"] : []),
  ]);
  if (
    assignments.version !== 1 ||
    !Array.isArray(assignments.areas) ||
    !Array.isArray(assignments.projects)
  )
    throw new Error("Invalid migration assignments version or entity arrays");
  const helpers =
    assignments.helpers === undefined
      ? sourceConfig
      : fields(assignments.helpers, ["ddAuthPath", "curlPath"]);
  if (!helpers)
    throw new Error("Migration requires explicitly configured WM helper paths");
  const config = decodeWorkManagementConfig({
    version: 2,
    routingMode: "catalog",
    ddAuthPath: helpers.ddAuthPath,
    curlPath: helpers.curlPath,
  }) as CatalogWorkManagementConfig;
  const catalog: WorkCatalog = {
    version: 1,
    revision: 0,
    state: "prepared",
    areas: {},
    projects: {},
  };
  const areas = new Map<string, string>();
  for (const raw of assignments.areas) {
    const row = fields(raw, ["name", "description", "publication"]);
    const name = catalogName(row.name),
      key = name.toLowerCase(),
      id = catalogId(uuid());
    if (areas.has(key) || Object.hasOwn(catalog.areas, id))
      throw new Error("Duplicate migration area name or ID");
    catalog.areas[id] = {
      id,
      name,
      description: validateDescription(row.description),
      publication: decodePublication(row.publication),
      archived: false,
    };
    areas.set(key, id);
  }
  const groups = inventory(snapshot);
  const assigned = new Set<string>();
  const archived = new Set(
    decodeProjectArchiveRegistry(snapshot.archives).archived,
  );
  for (const raw of assignments.projects) {
    const row = fields(raw, ["name", "area", "description"]);
    const name = catalogName(row.name),
      key = name.toLowerCase();
    const aliases = groups.get(key);
    if (!aliases || assigned.has(key))
      throw new Error(
        `Unknown, duplicate, or aliased project assignment ${JSON.stringify(name)}; use canonical names`,
      );
    const areaId =
      row.area === null ? null : areas.get(catalogName(row.area).toLowerCase());
    if (areaId === undefined)
      throw new Error(`Unknown assigned area for ${JSON.stringify(name)}`);
    const id = catalogId(uuid());
    if (Object.hasOwn(catalog.projects, id) || Object.hasOwn(catalog.areas, id))
      throw new Error("Duplicate migration entity ID");
    catalog.projects[id] = {
      id,
      name,
      description:
        row.description === null ? null : validateDescription(row.description),
      areaId,
      archived: [...aliases].some((a) => archived.has(a)),
      workstreamKey: key,
      aliases: [...aliases].filter((a) => a !== key).sort(),
    };
    assigned.add(key);
  }
  if (assigned.size !== groups.size)
    throw new Error(
      "Every legacy project requires an explicit assignment, including intentional area:null entries",
    );
  const verified = decodeWorkCatalog(encodeWorkCatalog(catalog))!;
  const memberships = snapshot.issues.map((issue) =>
    resolveTaskMembership(verified, issue),
  );
  if (memberships.some((m) => m.kind === "invalid"))
    throw new Error(
      "Ambiguous or inconsistent legacy task membership requires an explicit repair before migration",
    );
  const projects = Object.values(verified.projects);
  const diagnostics: MigrationDiagnostics = {
    unscopedTasks: memberships.filter((m) => m.kind === "unscoped").length,
    unclassifiedProjects: projects
      .filter((p) => p.areaId === null)
      .map((p) => p.id),
    missingDescriptions: projects
      .filter((p) => p.description === null)
      .map((p) => p.id),
    previousDestinations: projects
      .filter((p) => p.areaId !== null)
      .map((p) => ({
        projectId: p.id,
        count: destinationMismatchCount(
          p,
          verified.areas[p.areaId!].publication,
          snapshot.issues,
        ),
      }))
      .filter((p) => p.count > 0),
    legacyRouting: [...new Set([...groups.values()].flatMap((g) => [...g]))]
      .sort()
      .map((workstream) => {
        const target =
          sourceConfig &&
          (Object.hasOwn(sourceConfig.workstreams, workstream)
            ? sourceConfig.workstreams[workstream]
            : sourceConfig.defaultTarget);
        return {
          workstream,
          publication: publicationSummary({
            publication: target
              ? { mode: "datadog", target }
              : { mode: "local" },
          }),
        };
      }),
  };
  const body = {
    version: 1 as const,
    store: path(snapshot.store),
    sourceFingerprint: sourceFingerprint(snapshot),
    sourceConfig,
    catalog: verified,
    config,
    diagnostics,
  };
  return decodeCatalogMigrationPlan({ ...body, id: hash(body) });
}
export function decodeCatalogMigrationPlan(
  value: unknown,
): CatalogMigrationPlan {
  const row = fields(value, [
    "version",
    "id",
    "store",
    "sourceFingerprint",
    "sourceConfig",
    "catalog",
    "config",
    "diagnostics",
  ]);
  const { id, ...body } = row;
  if (Buffer.byteLength(JSON.stringify(row)) > MAX_MIGRATION_BYTES)
    throw new Error("Migration plan exceeds its private-file budget");
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || hash(body) !== id)
    throw new Error(
      "Migration plan checksum mismatch; review a new plan instead of editing a saved one",
    );
  const catalog = decodeWorkCatalog(row.catalog);
  const config = decodeWorkManagementConfig(row.config);
  const sourceConfig =
    row.sourceConfig === null
      ? null
      : decodeWorkManagementConfig(row.sourceConfig);
  if (
    row.version !== 1 ||
    typeof row.sourceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sourceFingerprint) ||
    !catalog ||
    catalog.state !== "prepared" ||
    catalog.revision !== 0 ||
    config.version !== 2 ||
    sourceConfig?.version === 2
  )
    throw new Error("Invalid migration plan schema");
  const diagnostics = fields(row.diagnostics, [
    "unscopedTasks",
    "unclassifiedProjects",
    "missingDescriptions",
    "previousDestinations",
    "legacyRouting",
  ]);
  if (
    !Number.isSafeInteger(diagnostics.unscopedTasks) ||
    (diagnostics.unscopedTasks as number) < 0
  )
    throw new Error("Invalid migration diagnostics");
  for (const key of ["unclassifiedProjects", "missingDescriptions"] as const) {
    const items = diagnostics[key];
    if (
      !Array.isArray(items) ||
      items.some((id) => !Object.hasOwn(catalog.projects, catalogId(id)))
    )
      throw new Error("Invalid migration diagnostic project IDs");
  }
  if (
    !Array.isArray(diagnostics.previousDestinations) ||
    !Array.isArray(diagnostics.legacyRouting)
  )
    throw new Error("Invalid migration diagnostics");
  for (const value of diagnostics.previousDestinations) {
    const item = fields(value, ["projectId", "count"]);
    if (
      !Object.hasOwn(catalog.projects, catalogId(item.projectId)) ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 1
    )
      throw new Error("Invalid destination diagnostic");
  }
  for (const value of diagnostics.legacyRouting) {
    const item = fields(value, ["workstream", "publication"]);
    catalogName(item.workstream);
    validateDescription(item.publication);
  }
  return {
    version: 1,
    id,
    store: path(row.store),
    sourceFingerprint: row.sourceFingerprint,
    sourceConfig,
    catalog,
    config,
    diagnostics: diagnostics as unknown as MigrationDiagnostics,
  };
}
export function verifyMigrationSource(
  plan: CatalogMigrationPlan,
  snapshot: MigrationSnapshot,
): void {
  if (
    snapshot.store !== plan.store ||
    sourceFingerprint(snapshot) !== plan.sourceFingerprint
  )
    throw new Error(
      "Migration source changed; stop and review a fresh snapshot",
    );
  const resumed =
    equal(snapshot.catalog, plan.catalog) &&
    equal(snapshot.config, plan.config);
  if (!equal(snapshot.config, plan.sourceConfig) && !resumed)
    throw new Error(
      "Migration configuration changed; inspect the interrupted state before continuing",
    );
}
function activeCatalog(plan: CatalogMigrationPlan): WorkCatalog {
  return { ...structuredClone(plan.catalog), revision: 1, state: "active" };
}
async function locked(
  plan: CatalogMigrationPlan,
  deps: CatalogMigrationDependencies,
  operation: (plan: CatalogMigrationPlan) => Promise<void>,
) {
  const verified = decodeCatalogMigrationPlan(plan);
  if (verified.store !== deps.storePath)
    throw new Error("Migration plan belongs to a different store");
  const host = hostname();
  await withFileOperationLock(
    join(deps.storePath, "pi-task-lifecycle"),
    {
      pid: process.pid,
      host,
      sessionId: `catalog-migration-${verified.id}`,
      started: Date.now(),
    },
    () => operation(verified),
    {
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      isPidAlive: localPidState,
      hostname: host,
      timeoutMs: 5000,
    },
  );
}
export async function prepareCatalogMigration(
  plan: CatalogMigrationPlan,
  deps: CatalogMigrationDependencies,
): Promise<void> {
  await locked(plan, deps, async (plan) => {
    const snapshot = await deps.readSnapshot();
    verifyMigrationSource(plan, snapshot);
    if (!equal(snapshot.config, plan.sourceConfig))
      throw new Error(
        "Configuration cutover already started; inspect and resume activation, not prepare",
      );
    if (equal(snapshot.catalog, plan.catalog)) {
      await deps.verifyBackup(plan);
      return;
    }
    if (snapshot.catalog !== null)
      throw new Error(
        "Existing catalog differs from the exact prepared catalog plan",
      );
    await deps.backup(plan);
    await deps.verifyBackup(plan);
    await deps.catalog.write(plan.catalog);
    if (!equal(await deps.catalog.read(), plan.catalog))
      throw new Error(
        "Prepared catalog write is uncertain; inspect exact plan IDs before retrying",
      );
  });
}
export async function activateCatalogMigration(
  plan: CatalogMigrationPlan,
  deps: CatalogMigrationDependencies,
): Promise<void> {
  await locked(plan, deps, async (plan) => {
    const snapshot = await deps.readSnapshot();
    if (
      equal(snapshot.catalog, activeCatalog(plan)) &&
      equal(snapshot.config, plan.config)
    ) {
      await deps.verifyBackup(plan);
      return;
    }
    if (!equal(snapshot.catalog, plan.catalog))
      throw new Error(
        "Activation requires the exact prepared catalog and revision",
      );
    verifyMigrationSource(plan, snapshot);
    await deps.verifyBackup(plan);
    await deps.verifyRuntime();
    if (!equal(snapshot.config, plan.config))
      await deps.writeConfig(plan.config);
    const after = await deps.readSnapshot();
    verifyMigrationSource(plan, after);
    if (
      !equal(after.config, plan.config) ||
      !equal(after.catalog, plan.catalog)
    )
      throw new Error(
        "Configuration cutover read-back is uncertain; inspect before continuing",
      );
    await deps.catalog.write(activeCatalog(plan));
    if (!equal(await deps.catalog.read(), activeCatalog(plan)))
      throw new Error(
        "Active marker read-back is uncertain; inspect exact plan IDs before retrying",
      );
  });
}
