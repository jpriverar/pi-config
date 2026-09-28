import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";

export const DEFAULT_DAEMON_LIMITS = Object.freeze({
  scanIntervalMs: 60_000,
  externalConcurrency: 2,
  maxQueuedTasks: 100,
  commandTimeoutMs: 30_000,
  observationTimeoutMs: 120_000,
  requestTimeoutMs: 60_000,
  heartbeatIntervalMs: 10_000,
  heartbeatStaleMs: 30_000,
  localFailureBaseMs: 60_000,
  localFailureMaxMs: 900_000,
  maxOutputBytes: 16 * 1024 * 1024,
});

export interface DaemonConfig {
  version: 1;
  store: string;
  poolConfigPath: string;
  lifecycleConfigPath: string;
  runtimeRoot: string;
  executables: { node: string; bd: string; git: string; gh: string };
  githubAccounts: Readonly<Record<string, string>>;
  limits: { -readonly [K in keyof typeof DEFAULT_DAEMON_LIMITS]: number };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${label} has unknown field ${JSON.stringify(key)}`);
}
function absolute(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(
      `${label} must be an absolute path without control characters`,
    );
  return value;
}
async function existing(
  value: unknown,
  label: string,
  directory: boolean,
  executable = false,
): Promise<string> {
  const path = absolute(value, label);
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (directory ? !info.isDirectory() : !info.isFile())
      throw new Error("wrong type");
    await access(canonical, executable ? constants.X_OK : constants.R_OK);
    return canonical;
  } catch {
    throw new Error(
      `${label} is not an accessible ${directory ? "directory" : executable ? "executable" : "file"}: ${path}`,
    );
  }
}

export async function loadDaemonConfig(path: string): Promise<DaemonConfig> {
  absolute(path, "daemon config path");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`cannot read daemon config JSON at ${path}`);
  }
  const config = record(value, "daemon config");
  keys(
    config,
    [
      "version",
      "store",
      "poolConfigPath",
      "lifecycleConfigPath",
      "runtimeRoot",
      "executables",
      "githubAccounts",
      "limits",
    ],
    "daemon config",
  );
  if (config.version !== 1) throw new Error("daemon config version must be 1");
  const paths = record(config.executables, "executables");
  keys(paths, ["node", "bd", "git", "gh"], "executables");
  const accounts: Record<string, string> = Object.create(null);
  for (const [owner, account] of Object.entries(
    record(config.githubAccounts, "githubAccounts"),
  )) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner) ||
      typeof account !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(account)
    )
      throw new Error("githubAccounts requires explicit owner/account names");
    const normalized = owner.toLowerCase();
    if (Object.hasOwn(accounts, normalized))
      throw new Error(`duplicate GitHub account mapping for ${normalized}`);
    accounts[normalized] = account;
  }
  const overrides =
    config.limits === undefined ? {} : record(config.limits, "limits");
  keys(overrides, Object.keys(DEFAULT_DAEMON_LIMITS), "limits");
  const limits: DaemonConfig["limits"] = { ...DEFAULT_DAEMON_LIMITS };
  for (const [key, limit] of Object.entries(overrides)) {
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit <= 0 ||
      limit > 2_147_483_647
    )
      throw new Error(`limits.${key} must be a positive bounded integer`);
    limits[key as keyof typeof limits] = limit;
  }
  if (limits.localFailureMaxMs < limits.localFailureBaseMs)
    throw new Error("localFailureMaxMs must be at least localFailureBaseMs");
  if (limits.heartbeatStaleMs <= limits.heartbeatIntervalMs)
    throw new Error("heartbeatStaleMs must exceed heartbeatIntervalMs");
  return {
    version: 1,
    store: await existing(config.store, "store", true),
    poolConfigPath: await existing(
      config.poolConfigPath,
      "poolConfigPath",
      false,
    ),
    lifecycleConfigPath: await existing(
      config.lifecycleConfigPath,
      "lifecycleConfigPath",
      false,
    ),
    runtimeRoot: absolute(config.runtimeRoot, "runtimeRoot"),
    executables: {
      node: await existing(paths.node, "executables.node", false, true),
      bd: await existing(paths.bd, "executables.bd", false, true),
      git: await existing(paths.git, "executables.git", false, true),
      gh: await existing(paths.gh, "executables.gh", false, true),
    },
    githubAccounts: { ...accounts },
    limits,
  };
}

export function daemonEnvironment(config: DaemonConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? homedir(),
    PATH: [
      ...new Set([
        ...Object.values(config.executables).map(dirname),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ]),
    ].join(":"),
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    NO_COLOR: "1",
  };
  for (const name of [
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
