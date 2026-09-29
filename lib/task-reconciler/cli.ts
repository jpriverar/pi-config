import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_VERSION } from "./build-info.js";
import { runBoundedCommand } from "./commands.js";
import { loadDaemonConfig } from "./config.js";
import { localPidState } from "./files.js";
import { readDaemonHealth } from "./health.js";
import { createDaemonRuntime } from "./runtime.js";
import { verifyRuntimeBuild } from "./runtime-build.js";
import { serveReconciler } from "./server.js";
import {
  manageService,
  type ServiceAction,
  type ServiceManagerDependencies,
  type ServiceManagerOptions,
} from "./service-manager.js";

export interface CliDependencies {
  output(message: string): void;
  manage(
    action: ServiceAction,
    configPath: string,
    options: ServiceManagerOptions,
  ): Promise<void>;
  run(configPath: string): Promise<void>;
}
export interface CliOptions {
  sourceRoot?: string;
  deps?: CliDependencies;
}
const USAGE =
  "task-reconciler <install|start|stop|status|update|uninstall|run> --config <absolute-path> [--rollback (update only)]";
function defaults(sourceRoot: string): CliDependencies {
  const output = (message: string) => console.log(message);
  const deps: ServiceManagerDependencies = {
    fs,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    platform: process.platform,
    output,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pidState: localPidState,
    health: readDaemonHealth,
    exec: (file, args, env) =>
      runBoundedCommand(file, args, { env, timeoutMs: 30000 }),
    build: async () => {
      const result = await runBoundedCommand(
        process.execPath,
        [join(sourceRoot, "scripts/build-task-reconciler.mjs"), "--json"],
        {
          env: {
            HOME: homedir(),
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            LC_ALL: "C",
          },
          timeoutMs: 150000,
        },
      );
      if (result.code !== 0)
        throw new Error(
          `runtime build failed; run npm run build:reconciler in ${sourceRoot}`,
        );
      let value: unknown;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        throw new Error("runtime builder returned invalid JSON");
      }
      const directory = (value as { directory?: unknown } | null)?.directory;
      if (
        typeof directory !== "string" ||
        !isAbsolute(directory) ||
        relative(
          await fs.realpath(join(sourceRoot, ".reconciler-build")),
          await fs.realpath(directory),
        ).startsWith("..")
      )
        throw new Error(
          "runtime builder returned a path outside the package build directory",
        );
      return verifyRuntimeBuild(directory);
    },
  };
  return {
    output,
    manage: async (action, configPath, options) => {
      const result = await manageService(action, configPath, deps, options);
      output(JSON.stringify(result));
    },
    run: async (configPath) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.on("SIGTERM", abort);
      process.on("SIGINT", abort);
      try {
        const config = await loadDaemonConfig(configPath);
        const owner = {
          pid: process.pid,
          host: hostname(),
          sessionId: `daemon-${randomUUID()}`,
          started: Date.now(),
        };
        const runner = await createDaemonRuntime(config, owner);
        try {
          await serveReconciler(config, runner, owner, controller.signal);
        } finally {
          await runner.stop();
        }
      } finally {
        process.removeListener("SIGTERM", abort);
        process.removeListener("SIGINT", abort);
      }
    },
  };
}
export async function runCli(
  argv: readonly string[],
  options: CliOptions = {},
): Promise<number> {
  const deps =
    options.deps ??
    defaults(
      options.sourceRoot ?? fileURLToPath(new URL("../../", import.meta.url)),
    );
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      deps.output(USAGE);
      return 0;
    }
    if (argv.length === 1 && argv[0] === "--runtime-info") {
      deps.output(
        JSON.stringify({ protocolVersion: 1, runtimeVersion: RUNTIME_VERSION }),
      );
      return 0;
    }
    const action = argv[0];
    if (
      ![
        "install",
        "start",
        "stop",
        "status",
        "update",
        "uninstall",
        "run",
      ].includes(action)
    )
      throw new Error(USAGE);
    let configPath: string | undefined;
    let rollback = false;
    for (let i = 1; i < argv.length; i += 1) {
      if (argv[i] === "--config" && configPath === undefined && argv[i + 1]) {
        configPath = argv[++i];
        continue;
      }
      if (argv[i] === "--rollback" && !rollback && action === "update") {
        rollback = true;
        continue;
      }
      throw new Error(`unsupported or duplicate CLI argument at position ${i}`);
    }
    if (
      !configPath ||
      !isAbsolute(configPath) ||
      /[\u0000-\u001f\u007f]/.test(configPath)
    )
      throw new Error(
        "--config requires one absolute path without control characters",
      );
    if (action === "run") await deps.run(configPath);
    else
      await deps.manage(
        action as ServiceAction,
        configPath,
        rollback ? { rollback: true } : {},
      );
    return 0;
  } catch (error) {
    deps.output(
      error instanceof Error ? error.message : "task reconciler command failed",
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  (await fs.realpath(process.argv[1]).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
)
  process.exitCode = await runCli(process.argv.slice(2));
