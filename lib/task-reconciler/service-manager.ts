import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { hostname } from "node:os";
import type { BeadsExecResult } from "../beads.js";
import { withFileOperationLock } from "../file-operation-lock.js";
import { loadLifecycleConfig } from "../task-lifecycle/config.js";
import { loadPoolConfig } from "../../extensions/worktree-pool/config.js";
import {
  daemonEnvironment,
  loadDaemonConfig,
  type DaemonConfig,
} from "./config.js";
import { localPidState, resolveDaemonLock } from "./files.js";
import type { DaemonHealth } from "./health.js";
import { inspectLaunchd, launchAgent, type LaunchdState } from "./launchd.js";
import {
  digest,
  listFiles,
  readBoundedFile,
  readJson,
  safeVersion,
  verifyRuntimeBuild,
  type FileSystem,
  type RuntimeBuild,
} from "./runtime-build.js";
import { ADMIN_SOURCE } from "./admin-entry.mjs";

export type ServiceAction =
  | "install"
  | "start"
  | "stop"
  | "status"
  | "update"
  | "uninstall";
export interface ServiceManagerDependencies {
  fs: FileSystem;
  home: string;
  uid: number;
  platform: NodeJS.Platform;
  exec(
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<BeadsExecResult>;
  build(): Promise<RuntimeBuild>;
  health(config: DaemonConfig): Promise<DaemonHealth>;
  output(message: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  pidState(pid: number): "live" | "dead" | "ambiguous";
}
export interface ServicePaths {
  root: string;
  manifest: string;
  template: string;
  admin: string;
  agent: string;
  lock: string;
}
export interface ServiceManagerResult {
  action: ServiceAction;
  label: string;
  paths: ServicePaths;
  installed: boolean;
  enabled: boolean;
  loaded: boolean;
  runtimeVersion?: string;
  health?: DaemonHealth;
}
export interface ServiceManagerOptions {
  rollback?: boolean;
}
interface ServiceRecord {
  version: 1;
  managedBy: "pi-config:task-reconciler";
  uid: number;
  store: string;
  label: string;
  currentDeployment: string;
  previousDeployment: string | null;
  runtimeVersion: string;
  templateHash: string;
  adminHash: string;
  drainingPids: number[];
}
const OWNED = "pi-config:task-reconciler";
const EXTRA_FILES = [
  "daemon.json",
  "pool.json",
  "lifecycle.json",
  "agent.plist",
  "deployment.json",
];

export async function manageService(
  action: ServiceAction,
  configPath: string,
  deps: ServiceManagerDependencies,
  options: ServiceManagerOptions = {},
): Promise<ServiceManagerResult> {
  if (deps.platform !== "darwin")
    throw new Error("launchd administration requires macOS");
  if (!Number.isSafeInteger(deps.uid) || deps.uid < 0 || !isAbsolute(deps.home))
    throw new Error("invalid service UID/home");
  if (options.rollback && action !== "update")
    throw new Error("rollback requires update");
  const fs = deps.fs;
  const home = await fs.realpath(deps.home);
  if (!isAbsolute(configPath) || /[\u0000-\u001f\u007f]/.test(configPath))
    throw new Error(
      "daemon config path must be absolute without control characters",
    );
  const identity = (await readJson(await fs.realpath(configPath), fs)) as {
    version?: number;
    store?: unknown;
  } | null;
  if (
    !identity ||
    identity.version !== 1 ||
    typeof identity.store !== "string" ||
    !isAbsolute(identity.store) ||
    /[\u0000-\u001f\u007f]/.test(identity.store)
  )
    throw new Error("invalid daemon store identity");
  const store = await fs.realpath(identity.store);
  if (!(await fs.stat(store)).isDirectory())
    throw new Error(`daemon store is not a directory: ${store}`);
  const key = digest(store).slice(0, 16);
  const label = `com.pi.task-reconciler.${key}`;
  const base = join(home, ".pi/task-reconciler");
  const root = join(base, "services", key);
  const paths: ServicePaths = {
    root,
    manifest: join(root, "service.json"),
    template: join(root, "agent.plist"),
    admin: join(root, "admin.mjs"),
    agent: join(home, "Library/LaunchAgents", `${label}.plist`),
    lock: join(base, "admin-locks", key),
  };
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${label}`;
  deps.output(
    `Task reconciler ${target}: ${root}; LaunchAgent ${paths.agent}; store ${store}`,
  );
  const initial = await record();
  if (!initial && action === "status")
    return {
      action,
      label,
      paths,
      installed: false,
      enabled: false,
      loaded: false,
    };
  if (!initial && action !== "install")
    throw new Error(`service is not installed: ${label}`);
  const configOptions = {
    allowMissingExecutables: ["stop", "status", "uninstall"].includes(action),
  };
  const config = await loadDaemonConfig(
    action === "install" || action === "update"
      ? configPath
      : join(deploymentPath(initial!.currentDeployment), "daemon.json"),
    configOptions,
  );
  if (config.store !== store)
    throw new Error("installed configuration store mismatch");
  const env: NodeJS.ProcessEnv = {
    ...daemonEnvironment(config),
    HOME: home,
    LC_ALL: "C",
  };
  const command = (args: readonly string[]) =>
    deps.exec("/bin/launchctl", args, env);
  async function checked(args: readonly string[]): Promise<void> {
    const result = await command(args);
    if (result.code !== 0)
      throw new Error(
        `launchctl ${args[0]} failed for ${target} (exit ${result.code})`,
      );
  }
  async function exists(path: string): Promise<boolean> {
    try {
      await fs.lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function directory(
    path: string,
    create = false,
    privateMode = true,
  ): Promise<void> {
    if (create) await fs.mkdir(path, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== deps.uid ||
      (privateMode ? (info.mode & 0o777) !== 0o700 : (info.mode & 0o022) !== 0)
    )
      throw new Error(`unowned service directory: ${path}`);
    for (
      let parent = dirname(await fs.realpath(path));
      ;
      parent = dirname(parent)
    ) {
      const p = await fs.lstat(parent);
      if (
        (p.uid !== deps.uid && p.uid !== 0) ||
        ((p.mode & 0o022) !== 0 && (p.mode & 0o1000) === 0)
      )
        throw new Error(`unsafe service parent: ${parent}`);
      if (parent === dirname(parent)) break;
    }
  }
  async function atomic(path: string, content: string): Promise<void> {
    if (await exists(path)) await readBoundedFile(path, fs, deps.uid);
    const temporary = join(dirname(path), `.write-${randomUUID()}`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, path);
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async function record(): Promise<ServiceRecord | undefined> {
    if (!(await exists(root))) return undefined;
    await directory(root);
    if (
      !(await exists(paths.manifest)) &&
      (await fs.readdir(root)).length === 0
    )
      return undefined;
    const raw = (await readJson(
      paths.manifest,
      fs,
      deps.uid,
    )) as Partial<ServiceRecord>;
    if (
      !raw ||
      raw.version !== 1 ||
      raw.managedBy !== OWNED ||
      raw.uid !== deps.uid ||
      raw.store !== store ||
      raw.label !== label ||
      !safeVersion(raw.currentDeployment) ||
      !(
        raw.previousDeployment === null || safeVersion(raw.previousDeployment)
      ) ||
      !safeVersion(raw.runtimeVersion) ||
      typeof raw.templateHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.templateHash) ||
      typeof raw.adminHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.adminHash) ||
      !Array.isArray(raw.drainingPids) ||
      raw.drainingPids.length > 4 ||
      raw.drainingPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
    )
      throw new Error(`unowned or invalid service manifest: ${paths.manifest}`);
    paths.template = join(deploymentPath(raw.currentDeployment), "agent.plist");
    return raw as ServiceRecord;
  }
  async function save(current: ServiceRecord): Promise<void> {
    await atomic(paths.manifest, JSON.stringify(current));
  }
  function deploymentPath(id: string): string {
    if (!safeVersion(id)) throw new Error("invalid deployment identifier");
    return join(root, "runtimes", id);
  }
  async function deployment(id: string) {
    const path = deploymentPath(id);
    await directory(path);
    const build = await verifyRuntimeBuild(path, fs, EXTRA_FILES);
    const meta = (await readJson(
      join(path, "deployment.json"),
      fs,
      deps.uid,
    )) as {
      version?: number;
      uid?: number;
      store?: string;
      files?: Record<string, string>;
    };
    const expected = [
      ...Object.keys(build.manifest.files),
      "manifest.json",
      ...EXTRA_FILES.filter((name) => name !== "deployment.json"),
    ].sort();
    if (
      !meta ||
      meta.version !== 1 ||
      meta.uid !== deps.uid ||
      meta.store !== config.store ||
      !meta.files ||
      JSON.stringify(Object.keys(meta.files).sort()) !==
        JSON.stringify(expected)
    )
      throw new Error(`unowned deployment at ${path}`);
    for (const [name, hash] of Object.entries(meta.files))
      if (
        digest(
          await readBoundedFile(
            join(path, name),
            fs,
            deps.uid,
            16 * 1024 * 1024,
          ),
        ) !== hash
      )
        throw new Error(`deployment digest mismatch: ${name}`);
    const installed = await loadDaemonConfig(
      join(path, "daemon.json"),
      configOptions,
    );
    if (installed.store !== config.store)
      throw new Error("installed daemon store mismatch");
    return {
      path,
      build,
      config: installed,
      args: [
        installed.executables.node,
        join(path, build.manifest.entry),
        "run",
        "--config",
        join(path, "daemon.json"),
      ],
    };
  }
  async function definitions(current: ServiceRecord): Promise<void> {
    paths.template = join(
      deploymentPath(current.currentDeployment),
      "agent.plist",
    );
    if (
      digest(await readBoundedFile(paths.template, fs, deps.uid)) !==
        current.templateHash ||
      digest(await readBoundedFile(paths.admin, fs, deps.uid)) !==
        current.adminHash
    )
      throw new Error("unverifiable service definition ownership");
    if (await exists(paths.agent)) {
      await directory(dirname(paths.agent), false, false);
      const allowed = [current.templateHash];
      if (current.previousDeployment) {
        const previous = await deployment(current.previousDeployment);
        allowed.push(
          digest(
            await readBoundedFile(
              join(previous.path, "agent.plist"),
              fs,
              deps.uid,
            ),
          ),
        );
      }
      if (
        !allowed.includes(
          digest(await readBoundedFile(paths.agent, fs, deps.uid)),
        )
      )
        throw new Error(`unrelated LaunchAgent ownership at ${paths.agent}`);
    }
  }
  async function inspect(current: ServiceRecord): Promise<LaunchdState> {
    await definitions(current);
    const d = await deployment(current.currentDeployment);
    return inspectLaunchd(command, domain, label, paths.agent, d.args);
  }
  async function waitDead(current: ServiceRecord): Promise<void> {
    const deadline = deps.now() + config.limits.requestTimeoutMs;
    while (current.drainingPids.some((pid) => deps.pidState(pid) !== "dead")) {
      if (deps.now() >= deadline)
        throw new Error(
          `service process drain remains unconfirmed for ${target}`,
        );
      await deps.sleep(100);
    }
    if (current.drainingPids.length) {
      current.drainingPids = [];
      await save(current);
    }
  }
  async function stop(current: ServiceRecord): Promise<void> {
    const state = await inspect(current);
    if (state.pid !== null && !current.drainingPids.includes(state.pid)) {
      current.drainingPids.push(state.pid);
      await save(current);
    }
    await checked(["disable", target]);
    if (state.loaded) await checked(["bootout", target]);
    await waitDead(current);
    const after = await inspect(current);
    if (after.loaded || !after.disabled)
      throw new Error(`service stop remains unconfirmed for ${target}`);
  }
  async function waitHealthy(current: ServiceRecord): Promise<void> {
    const d = await deployment(current.currentDeployment);
    const deadline = deps.now() + config.limits.requestTimeoutMs;
    while (true) {
      const state = await inspect(current);
      const health = await deps.health(d.config);
      if (
        state.loaded &&
        !state.disabled &&
        health.state === "available" &&
        health.pid === state.pid &&
        health.runtimeVersion === current.runtimeVersion
      )
        return;
      if (deps.now() >= deadline)
        throw new Error(
          `service health did not become available for ${target}`,
        );
      await deps.sleep(250);
    }
  }
  async function start(current: ServiceRecord): Promise<void> {
    await waitDead(current);
    const before = await inspect(current);
    if (before.loaded && !before.disabled) {
      await waitHealthy(current);
      return;
    }
    if (before.loaded) await stop(current);
    await directory(dirname(paths.agent), true, false);
    await atomic(
      paths.agent,
      (await readBoundedFile(paths.template, fs, deps.uid)).toString("utf8"),
    );
    await checked(["enable", target]);
    try {
      await checked(["bootstrap", domain, paths.agent]);
      await waitHealthy(current);
    } catch (error) {
      await stop(current);
      throw error;
    }
  }
  async function withStoppedRuntime<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = await resolveDaemonLock(config.store, true);
    const owner = {
      pid: process.pid,
      host: hostname(),
      started: deps.now(),
      sessionId: `service-cutover-${randomUUID()}`,
    };
    return withFileOperationLock(lock, owner, operation, {
      now: deps.now,
      sleep: async () => {
        throw new Error("daemon singleton owner is still live");
      },
      isPidAlive: localPidState,
      hostname: hostname(),
      timeoutMs: 0,
    });
  }
  async function stage(): Promise<{ id: string; runtimeVersion: string }> {
    await loadLifecycleConfig(config.lifecycleConfigPath);
    try {
      await loadPoolConfig(config.poolConfigPath, {
        home,
        realpath: fs.realpath,
        runGit: (cwd, args) =>
          deps.exec(config.executables.git, ["-C", cwd, ...args], env),
      });
    } catch {
      throw new Error(`invalid pool configuration: ${config.poolConfigPath}`);
    }
    const node = await deps.exec(config.executables.node, ["--version"], env);
    const version = /^v(\d+)\.(\d+)\./.exec(node.stdout.trim());
    if (
      node.code !== 0 ||
      !version ||
      Number(version[1]) < 22 ||
      (Number(version[1]) === 22 && Number(version[2]) < 19)
    )
      throw new Error(
        `configured Node requires version >=22.19: ${config.executables.node}`,
      );
    const produced = await deps.build();
    const build = await verifyRuntimeBuild(produced.directory, fs);
    const pool = await readBoundedFile(config.poolConfigPath, fs);
    const policy = await readBoundedFile(config.lifecycleConfigPath, fs);
    const id = `${build.manifest.runtimeVersion}-${digest(JSON.stringify(config) + pool.toString("utf8") + policy.toString("utf8")).slice(0, 12)}`;
    const destination = deploymentPath(id);
    await directory(join(root, "runtimes"), true);
    if (!(await exists(destination))) {
      const temporary = await fs.mkdtemp(join(root, "runtimes/.staging-"));
      try {
        await fs.cp(build.directory, temporary, { recursive: true });
        const installed = {
          ...config,
          poolConfigPath: join(destination, "pool.json"),
          lifecycleConfigPath: join(destination, "lifecycle.json"),
        };
        await fs.writeFile(
          join(temporary, "daemon.json"),
          JSON.stringify(installed),
        );
        await fs.writeFile(join(temporary, "pool.json"), pool);
        await fs.writeFile(join(temporary, "lifecycle.json"), policy);
        const serviceEnv: NodeJS.ProcessEnv = {};
        for (const name of [
          "HOME",
          "PATH",
          "LC_ALL",
          "GIT_TERMINAL_PROMPT",
          "GH_PROMPT_DISABLED",
          "GH_NO_UPDATE_NOTIFIER",
          "GH_PAGER",
          "NO_COLOR",
          "GH_CONFIG_DIR",
          "XDG_CONFIG_HOME",
        ])
          if (env[name] !== undefined) serviceEnv[name] = env[name];
        await fs.writeFile(
          join(temporary, "agent.plist"),
          launchAgent(
            label,
            [
              installed.executables.node,
              join(destination, build.manifest.entry),
              "run",
              "--config",
              join(destination, "daemon.json"),
            ],
            serviceEnv,
          ),
        );
        const inventory: Record<string, string> = {};
        for (const name of await listFiles(temporary, fs)) {
          await fs.chmod(join(temporary, name), 0o600);
          inventory[name] = digest(
            await readBoundedFile(
              join(temporary, name),
              fs,
              deps.uid,
              16 * 1024 * 1024,
            ),
          );
        }
        await fs.writeFile(
          join(temporary, "deployment.json"),
          JSON.stringify({
            version: 1,
            uid: deps.uid,
            store: config.store,
            files: inventory,
          }),
          { mode: 0o600 },
        );
        await fs.chmod(temporary, 0o700);
        await fs.rename(temporary, destination);
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
    const d = await deployment(id);
    const smoke = await deps.exec(
      d.config.executables.node,
      [join(d.path, d.build.manifest.entry), "--runtime-info"],
      env,
    );
    let info: { protocolVersion?: number; runtimeVersion?: string };
    try {
      info = JSON.parse(smoke.stdout);
    } catch {
      throw new Error("standalone runtime verification returned invalid JSON");
    }
    if (
      smoke.code !== 0 ||
      info.protocolVersion !== 1 ||
      info.runtimeVersion !== build.manifest.runtimeVersion
    )
      throw new Error("standalone runtime verification failed");
    return { id, runtimeVersion: build.manifest.runtimeVersion };
  }
  async function select(
    selected: { id: string; runtimeVersion: string },
    previous: string | null,
  ): Promise<ServiceRecord> {
    const d = await deployment(selected.id);
    paths.template = join(d.path, "agent.plist");
    const template = await readBoundedFile(paths.template, fs, deps.uid);
    const admin = ADMIN_SOURCE;
    const current: ServiceRecord = {
      version: 1,
      managedBy: OWNED,
      uid: deps.uid,
      store: config.store,
      label,
      currentDeployment: selected.id,
      previousDeployment: previous,
      runtimeVersion: selected.runtimeVersion,
      templateHash: digest(template),
      adminHash: digest(admin),
      drainingPids: [],
    };
    const check = await deps.exec(
      "/usr/bin/plutil",
      ["-lint", paths.template],
      env,
    );
    if (check.code !== 0)
      throw new Error(`invalid LaunchAgent template: ${paths.template}`);
    if (!(await exists(paths.admin))) await atomic(paths.admin, admin);
    else if (
      (await readBoundedFile(paths.admin, fs, deps.uid)).toString("utf8") !==
      ADMIN_SOURCE
    )
      throw new Error("unverifiable installed admin entry point");
    await save(current);
    return current;
  }
  async function result(
    current?: ServiceRecord,
  ): Promise<ServiceManagerResult> {
    if (!current)
      return {
        action,
        label,
        paths,
        installed: false,
        enabled: false,
        loaded: false,
      };
    const state = await inspect(current);
    const d = await deployment(current.currentDeployment);
    return {
      action,
      label,
      paths,
      installed: true,
      enabled: !state.disabled && state.loaded,
      loaded: state.loaded,
      runtimeVersion: current.runtimeVersion,
      health: await deps.health(d.config),
    };
  }
  if (action === "status") return result(await record());
  await directory(paths.lock, true);
  const owner = {
    pid: process.pid,
    host: hostname(),
    started: deps.now(),
    sessionId: `service-admin-${randomUUID()}`,
  };
  return withFileOperationLock(
    paths.lock,
    owner,
    async () => {
      let current = await record();
      if (action === "install") {
        if (current)
          throw new Error(`service already installed; use update: ${label}`);
        if (await exists(paths.agent))
          throw new Error(
            `refusing existing unowned LaunchAgent: ${paths.agent}`,
          );
        await directory(root, true);
        if ((await fs.readdir(root)).length)
          throw new Error(`refusing unowned installation contents: ${root}`);
        current = await select(await stage(), null);
        return {
          action,
          label,
          paths,
          installed: true,
          enabled: false,
          loaded: false,
          runtimeVersion: current.runtimeVersion,
        };
      }
      if (!current) throw new Error(`service is not installed: ${label}`);
      if (action === "start") {
        await start(current);
        return result(current);
      }
      if (action === "stop") {
        await stop(current);
        return result(current);
      }
      if (action === "uninstall") {
        await definitions(current);
        const allowed = new Set(["service.json", "admin.mjs", "runtimes"]);
        for (const name of await fs.readdir(root))
          if (!allowed.has(name))
            throw new Error(`unowned installation content: ${name}`);
        await directory(join(root, "runtimes"));
        for (const id of await fs.readdir(join(root, "runtimes")))
          await deployment(id);
        await stop(current);
        const d = await deployment(current.currentDeployment);
        const health = await deps.health(d.config);
        if ("pid" in health)
          throw new Error(
            "a daemon still owns this store; stop it before uninstalling",
          );
        await withStoppedRuntime(async () => {
          if (await exists(paths.agent)) await fs.unlink(paths.agent);
          await fs.rm(root, { recursive: true });
        });
        return result();
      }
      const before = await inspect(current);
      if (options.rollback && !current.previousDeployment)
        throw new Error("no previous deployment is available for rollback");
      const priorTemplate = (
        await readBoundedFile(paths.template, fs, deps.uid)
      ).toString("utf8");
      await stop(current);
      const previous = structuredClone(current);
      let selected = false;
      try {
        current = await withStoppedRuntime(async () => {
          const candidate = options.rollback
            ? await deployment(previous.previousDeployment!)
            : undefined;
          const replacement = candidate
            ? {
                id: previous.previousDeployment!,
                runtimeVersion: candidate.build.manifest.runtimeVersion,
              }
            : await stage();
          return select(replacement, previous.currentDeployment);
        });
        selected = true;
        if (before.loaded && !before.disabled) await start(current);
        return result(current);
      } catch (error) {
        if (selected) await stop(current);
        if (await exists(paths.agent)) await atomic(paths.agent, priorTemplate);
        await save(previous);
        throw error;
      }
    },
    {
      now: deps.now,
      sleep: deps.sleep,
      isPidAlive: localPidState,
      hostname: hostname(),
      timeoutMs: 5000,
    },
  );
}
