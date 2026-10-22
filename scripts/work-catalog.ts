#!/usr/bin/env -S npx tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBeadsClient, type BeadsExec } from "../lib/beads.js";
import {
  buildCatalogMigration,
  decodeCatalogMigrationPlan,
  prepareCatalogMigration,
  activateCatalogMigration,
} from "../lib/work-catalog/migration.js";
import {
  createMigrationIO,
  readMigrationJson,
  verifyMigrationStore,
  writeMigrationPlan,
} from "../lib/work-catalog/migration-io.js";

const usage =
  "catalog preview --store STORE --assignments FILE --output PLAN | prepare --store STORE --plan PLAN | activate --store STORE --plan PLAN --runtime BUILD_DIR";
export function parseCatalogArguments(argv: string[]) {
  const [action, ...args] = argv;
  const required =
    action === "preview"
      ? ["store", "assignments", "output"]
      : action === "prepare"
        ? ["store", "plan"]
        : action === "activate"
          ? ["store", "plan", "runtime"]
          : undefined;
  if (!required || args.length !== required.length * 2) throw new Error(usage);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1],
      key = flag.slice(2);
    if (
      !flag.startsWith("--") ||
      !required.includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--") ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new Error(usage);
    values.set(key, resolve(value));
  }
  if (required.some((key) => !values.has(key))) throw new Error(usage);
  return { action: action as "preview" | "prepare" | "activate", values };
}
export async function runCatalog(argv: string[]): Promise<void> {
  const { action, values } = parseCatalogArguments(argv);
  const store = await verifyMigrationStore(values.get("store")!);
  const { BEADS_DIR: _dir, BEADS_DB: _db, ...baseEnv } = process.env;
  const exec = promisify(execFile);
  const run: BeadsExec = async (command, args, options) => {
    try {
      const result = await exec(command, [...args], {
        env: {
          ...baseEnv,
          ...options?.env,
          BEADS_DIR: store,
          BD_BACKUP_ENABLED: "false",
        },
        timeout: 20000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { code: 0, ...result };
    } catch (error) {
      const failure = error as {
        code?: unknown;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "Beads command unavailable",
      };
    }
  };
  const io = createMigrationIO(
    createBeadsClient(run, { env: { BEADS_DIR: store } }),
    store,
    values.get("runtime"),
  );
  if (action === "preview") {
    const snapshot = await io.readSnapshot();
    const plan = buildCatalogMigration(
      snapshot,
      await readMigrationJson(values.get("assignments")!),
    );
    await writeMigrationPlan(values.get("output")!, plan);
    console.log(
      `Private plan ${plan.id} written to ${values.get("output")}: ${Object.keys(plan.catalog.areas).length} areas, ${Object.keys(plan.catalog.projects).length} projects, ${plan.diagnostics.unscopedTasks} unchanged unscoped tasks. Review the full plan, missing descriptions, and exact destination/status mappings before approval. No catalog or task records were changed.`,
    );
    return;
  }
  const plan = decodeCatalogMigrationPlan(
    await readMigrationJson(values.get("plan")!),
  );
  if (action === "prepare") {
    await prepareCatalogMigration(plan, io);
    console.log(
      `Verified prepared catalog for ${plan.id}. Private backup: ${store}/pi-work-catalog-migrations. Keep task creation paused until activation completes.`,
    );
  } else {
    await activateCatalogMigration(plan, io);
    console.log(
      `Verified active catalog for ${plan.id}. Only new tasks inherit area routing; existing bindings were not moved. This does not prove older clients have retired.`,
    );
  }
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    await runCatalog(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Catalog migration failed",
    );
    console.error(
      "No automatic apply retry or rollback was attempted. Inspect the saved plan, catalog, and routing configuration before another apply.",
    );
    process.exitCode = 1;
  }
}
