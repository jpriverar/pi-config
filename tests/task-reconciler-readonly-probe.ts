import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";
import { scanReconciliation } from "../lib/task-lifecycle/reconciliation.js";
import { runBoundedCommand } from "../lib/task-reconciler/commands.js";

export async function runReadonlyProbe(argv: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (
      !["--db", "--bd"].includes(key) ||
      flags.has(key) ||
      !value ||
      !isAbsolute(value)
    )
      throw new Error(
        `unsupported probe argument: ${key}; use --db /absolute/store --bd /absolute/bd`,
      );
    flags.set(key, value);
  }
  if (!flags.has("--db") || !flags.has("--bd"))
    throw new Error(
      "probe requires explicit --db /absolute/store and --bd /absolute/bd",
    );
  const db = await realpath(flags.get("--db")!);
  const bd = await realpath(flags.get("--bd")!);
  await access(bd, constants.X_OK);
  const started = performance.now();
  const signal = AbortSignal.timeout(20000);
  const commands = { total: 0, list: 0, show: 0 };
  let examined = 0;
  const store = createLifecycleStore(
    async (command, args) => {
      const action = args[0];
      if (command !== "bd" || (action !== "list" && action !== "show"))
        throw new Error(`probe refused non-read command: ${command} ${action}`);
      commands.total += 1;
      commands[action] += 1;
      return runBoundedCommand(bd, args, {
        signal,
        timeoutMs: 10000,
        env: { HOME: homedir(), PATH: `${dirname(bd)}:/usr/bin:/bin` },
      });
    },
    { store: db },
  );
  const scan = await scanReconciliation(
    {
      ...store,
      list: async (statuses) => {
        const rows = await store.list(statuses);
        examined = rows.length;
        return rows;
      },
    },
    Date.now(),
  );
  if (signal.aborted)
    throw new Error("read-only probe exceeded its 20-second deadline");
  const reasons: Record<string, number> = {};
  const diagnostics: Record<string, number> = {};
  for (const candidate of scan.candidates)
    for (const reason of candidate.reasons)
      reasons[reason] = (reasons[reason] ?? 0) + 1;
  for (const diagnostic of scan.diagnostics)
    diagnostics[diagnostic.code] = (diagnostics[diagnostic.code] ?? 0) + 1;
  return {
    readOnly: true,
    store: db,
    examined,
    selected: scan.candidates.length,
    reasons,
    diagnostics,
    commands,
    elapsedMs: Math.round(performance.now() - started),
  };
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(await runReadonlyProbe(process.argv.slice(2)), null, 2),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "read-only probe failed",
    );
    process.exitCode = 1;
  }
}
