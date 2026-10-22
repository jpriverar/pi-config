import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BeadsClient, BeadsResult } from "../beads.js";
import { ALL_PROJECT_ISSUE_STATUSES } from "../project-management.js";
import {
  readBoundedFile,
  verifyRuntimeBuild,
  type RuntimeManifest,
} from "../task-reconciler/runtime-build.js";
import { verifyParents, writePrivateJson } from "../task-reconciler/files.js";
import { readPiDaemonHealth } from "../task-reconciler/pi-client.js";
import type { DaemonHealth } from "../task-reconciler/health.js";
import { decodeWorkManagementConfig } from "../work-management/config.js";
import { fields } from "./model.js";
import { createCatalogStore } from "./store.js";
import {
  decodeCatalogMigrationPlan,
  MAX_MIGRATION_BYTES,
  type CatalogMigrationDependencies,
  type CatalogMigrationPlan,
  type MigrationSnapshot,
} from "./migration.js";

export async function verifyMigrationStore(path: string): Promise<string> {
  const store = await realpath(path);
  const info = await lstat(store);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error(
      `Migration store must be an owned, non-writable-by-others directory: ${store}`,
    );
  await verifyParents(join(store, "pi-work-management.json"));
  return store;
}
export async function readMigrationJson(
  path: string,
  limit = MAX_MIGRATION_BYTES,
): Promise<unknown> {
  await verifyParents(path);
  const bytes = await readBoundedFile(
    path,
    undefined,
    process.getuid?.(),
    limit,
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`Invalid migration JSON at ${path}`);
  }
}
export async function writeMigrationPlan(
  path: string,
  value: unknown,
): Promise<void> {
  await verifyParents(path);
  await writePrivateJson(path, value, {
    maxBytes: MAX_MIGRATION_BYTES,
    exclusive: true,
  });
}
export function assertCatalogRuntime(
  manifest: RuntimeManifest,
  health: DaemonHealth,
): void {
  if (manifest.workCatalogVersion !== 1)
    throw new Error(
      "Runtime artifact does not declare catalog support; build and install compatible code first",
    );
  if (health.state !== "available")
    throw new Error(
      "A fresh available daemon is required before activation; inspect /task-reconciler status",
    );
  if (health.runtimeVersion !== manifest.runtimeVersion)
    throw new Error(
      "Live daemon runtime does not match the verified catalog-capable artifact",
    );
}
function result<T>(value: BeadsResult<T>): T {
  if (!value.ok)
    throw new Error(
      `Migration cannot read ${value.error.operation}: ${value.error.message}`,
    );
  return value.value;
}
export function createMigrationIO(
  client: BeadsClient,
  store: string,
  runtimeDirectory?: string,
): CatalogMigrationDependencies {
  const catalog = createCatalogStore(client);
  const configuration = join(store, "pi-work-management.json");
  const backupRoot = join(store, "pi-work-catalog-migrations");
  async function readConfig() {
    try {
      return decodeWorkManagementConfig(
        await readMigrationJson(configuration, 64 * 1024),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function readSnapshot(): Promise<MigrationSnapshot> {
    if ((await verifyMigrationStore(store)) !== store)
      throw new Error("Migration store identity changed");
    const [listed, renames, archives, current, config] = await Promise.all([
      client.listIssues(ALL_PROJECT_ISSUE_STATUSES),
      client.getProjectRenameRegistry(),
      client.getProjectArchiveRegistry(),
      catalog.read(),
      readConfig(),
    ]);
    return {
      store,
      catalog: current,
      config,
      renames: result(renames),
      archives: result(archives),
      issues: result(listed).map((issue) => ({
        id: issue.id,
        status: issue.status,
        labels: issue.labels,
        projectReference: issue.projectReference,
        capturedDestination: issue.capturedDestination,
      })),
    };
  }
  const backupPath = (plan: CatalogMigrationPlan) =>
    join(backupRoot, `${plan.id}.json`);
  async function verifyBackup(plan: CatalogMigrationPlan) {
    const saved = fields(await readMigrationJson(backupPath(plan)), [
      "version",
      "plan",
      "priorCatalog",
      "priorConfig",
    ]);
    const prior =
      saved.priorConfig === null
        ? null
        : decodeWorkManagementConfig(saved.priorConfig);
    if (
      saved.version !== 1 ||
      saved.priorCatalog !== null ||
      decodeCatalogMigrationPlan(saved.plan).id !== plan.id ||
      !isDeepStrictEqual(prior, plan.sourceConfig)
    )
      throw new Error(
        "Private migration backup does not match the exact plan; stop for inspection",
      );
  }
  return {
    storePath: store,
    readSnapshot,
    catalog,
    async backup(plan) {
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      const info = await lstat(backupRoot);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700
      )
        throw new Error("Unsafe migration backup directory");
      try {
        await verifyBackup(plan);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeMigrationPlan(backupPath(plan), {
        version: 1,
        plan,
        priorCatalog: null,
        priorConfig: plan.sourceConfig,
      });
      await verifyBackup(plan);
    },
    verifyBackup,
    async writeConfig(config) {
      for (const executable of [config.ddAuthPath, config.curlPath]) {
        const resolved = await realpath(executable);
        if (!(await lstat(resolved)).isFile())
          throw new Error(`WM helper is not a file: ${executable}`);
        await access(executable, constants.X_OK);
      }
      await verifyParents(configuration);
      await writePrivateJson(configuration, config);
      if (!isDeepStrictEqual(await readConfig(), config))
        throw new Error(
          "Version-2 configuration read-back mismatch; inspect before retrying",
        );
    },
    async verifyRuntime() {
      if (!runtimeDirectory)
        throw new Error(
          "Activation requires --runtime pointing to the exact installed build artifact",
        );
      const directory = await realpath(runtimeDirectory);
      await verifyParents(join(directory, "manifest.json"));
      await readBoundedFile(
        join(directory, "manifest.json"),
        undefined,
        process.getuid?.(),
      );
      const build = await verifyRuntimeBuild(directory);
      assertCatalogRuntime(build.manifest, await readPiDaemonHealth(store));
    },
  };
}
