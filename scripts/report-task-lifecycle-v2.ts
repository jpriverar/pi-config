#!/usr/bin/env -S npx tsx
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BeadsExec } from "../lib/beads.js";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";
import {
  planLifecycleV2Migration,
  readLifecycleV2MigrationSnapshot,
  type LifecycleV2Classifications,
} from "../lib/task-lifecycle/v2-migration.js";
import {
  readMigrationJson,
  verifyMigrationStore,
  writeMigrationPlan,
} from "../lib/work-catalog/migration-io.js";

const usage =
  "Usage: report-task-lifecycle-v2 --store STORE --output REPORT [--classifications FILE]. Report only; no apply mode.";
function argumentsForReport(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  if (args.length % 2 !== 0) throw new Error(usage);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !["--store", "--output", "--classifications"].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--") ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new Error(usage);
    values.set(key, resolve(value));
  }
  if (!values.has("--store") || !values.has("--output")) throw new Error(usage);
  return values;
}

export async function runLifecycleV2Report(args: string[]): Promise<void> {
  const values = argumentsForReport(args);
  const storePath = await verifyMigrationStore(values.get("--store")!);
  const input = values.has("--classifications")
    ? await readMigrationJson(values.get("--classifications")!)
    : {};
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("classifications must be an object keyed by task ID");
  const { BEADS_DIR: _dir, BEADS_DB: _db, ...environment } = process.env;
  const exec = promisify(execFile);
  const run: BeadsExec = async (command, argv, options) => {
    try {
      const result = await exec(command, [...argv], {
        env: {
          ...environment,
          ...options?.env,
          BEADS_DIR: storePath,
          BD_BACKUP_ENABLED: "false",
        },
        timeout: 20_000,
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
        stderr: failure.stderr ?? "Beads read failed",
      };
    }
  };
  const snapshot = await readLifecycleV2MigrationSnapshot(
    createLifecycleStore(run, { store: storePath }),
  );
  const plan = planLifecycleV2Migration(
    snapshot,
    input as LifecycleV2Classifications,
  );
  await writeMigrationPlan(values.get("--output")!, { storePath, ...plan });
  console.log(
    JSON.stringify({
      report: values.get("--output"),
      fingerprint: plan.fingerprint,
      proposed: plan.proposals.length,
      unchanged: plan.unchanged.length,
      diagnostics: plan.diagnostics,
    }),
  );
  if (plan.diagnostics.length > 0) process.exitCode = 2;
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    await runLifecycleV2Report(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Lifecycle v2 report failed",
    );
    process.exitCode = 1;
  }
}
