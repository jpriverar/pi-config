import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceScript = join(repository, "scripts", "bootstrap-macos.sh");
const sourceReconciler = join(
  repository,
  "scripts",
  "reconcile-personal-profile.mjs",
);
const sourcePackageJson = join(repository, "package.json");

const fakeHead = "799a816799a816799a816799a816799a816799a8";
const managedSources = [
  "npm:pi-mcp-adapter@2.26.0",
  "npm:pi-subagents@0.50.0",
  "npm:context-mode@1.0.169",
  "npm:pi-markdown-preview@0.14.1",
  "npm:@juicesharp/rpiv-ask-user-question@2.6.1",
];
const workMarker = ["data", "dog"].join("");

type BootstrapState = {
  binDir: string;
  commandLogPath: string;
  failBd: boolean;
  failPiInstallAt?: number;
  failShellWithBackup: boolean;
  homeDir: string;
  installedFormulas: string[];
  piInstallCountPath: string;
  repoRoot: string;
  scriptPath: string;
};

type FixtureOptions = {
  beadsFiles?: Array<{ bytes: string; path: string }>;
  fakeNodeVersion?: string;
  fakePiVersion?: string;
  fakeUname?: string;
  failBd?: boolean;
  failPiInstallAt?: number;
  failShellWithBackup?: boolean;
  includeBrew?: boolean;
  initialMcpBytes?: string;
  initialSettingsBytes?: string;
  initialZshrcBytes?: string;
  installedFormulas?: string[];
};

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCommandLog(path: string) {
  try {
    const contents = await readFile(path, "utf8");
    return contents
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function listTreePaths(
  root: string,
  relativePath = "",
): Promise<string[]> {
  const entries = await readdir(join(root, relativePath), {
    withFileTypes: true,
  });
  const paths: string[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const nextRelativePath = relativePath
      ? join(relativePath, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      paths.push(`${nextRelativePath}/`);
      paths.push(...(await listTreePaths(root, nextRelativePath)));
      continue;
    }
    paths.push(nextRelativePath);
  }

  return paths;
}

async function snapshotDirectory(root: string) {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await listTreePaths(root);
  const snapshot: string[] = [];

  for (const entry of entries) {
    if (entry.endsWith("/")) {
      snapshot.push(entry);
      continue;
    }
    snapshot.push(`${entry}:${await readFile(join(root, entry), "utf8")}`);
  }

  return snapshot;
}

function managedPackagePath(homeDir: string, packageName: string) {
  return join(
    homeDir,
    ".pi",
    "agent",
    "npm",
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
}

async function expectedHappyPathCommandLog(state: BootstrapState) {
  const reconcilerPath = join(
    state.repoRoot,
    "scripts",
    "reconcile-personal-profile.mjs",
  );
  const agentDir = join(state.homeDir, ".pi", "agent");
  const canonicalScriptsDir = await realpath(join(state.repoRoot, "scripts"));

  return [
    "uname -s",
    `git -C ${canonicalScriptsDir}/.. rev-parse --show-toplevel`,
    "brew list --formula volta",
    "brew install volta",
    "brew list --formula beads",
    "brew install beads",
    "volta install node@22.19.0",
    "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.1",
    `node ${reconcilerPath} validate --agent-dir ${agentDir} --repo-dir ${state.repoRoot}`,
    `node ${reconcilerPath} settings --agent-dir ${agentDir} --repo-dir ${state.repoRoot}`,
    `pi install ${state.repoRoot}`,
    ...managedSources.map((source) => `pi install ${source}`),
    `node ${reconcilerPath} settings --agent-dir ${agentDir} --repo-dir ${state.repoRoot}`,
    `node ${reconcilerPath} verify --agent-dir ${agentDir} --repo-dir ${state.repoRoot}`,
    "node --version",
    "pi --version",
    "bd init --init-if-missing --non-interactive --prefix jp",
    `node ${reconcilerPath} shell --zshrc ${join(state.homeDir, ".zshrc")}`,
    `git -C ${state.repoRoot} rev-parse HEAD`,
  ];
}

async function expectedResolveRepoCommandLog(state: BootstrapState) {
  const canonicalScriptsDir = await realpath(join(state.repoRoot, "scripts"));
  return [
    "uname -s",
    `git -C ${canonicalScriptsDir}/.. rev-parse --show-toplevel`,
  ];
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "bootstrap-macos-test-"));
  const canonicalRoot = await realpath(root);
  t.after(() => rm(canonicalRoot, { recursive: true, force: true }));

  const repoRoot = join(canonicalRoot, "fixture repo with spaces");
  const scriptsDir = join(repoRoot, "scripts");
  const binDir = join(canonicalRoot, "bin");
  const homeDir = join(canonicalRoot, "home");
  const commandLogPath = join(canonicalRoot, "command.log");
  const piInstallCountPath = join(canonicalRoot, "pi-install-count");

  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);

  const scriptPath = join(scriptsDir, "bootstrap-macos.sh");
  await Promise.all([
    cp(sourceScript, scriptPath),
    cp(sourceReconciler, join(scriptsDir, "reconcile-personal-profile.mjs")),
    cp(sourcePackageJson, join(repoRoot, "package.json")),
  ]);
  await chmod(scriptPath, 0o755);

  if (options.initialSettingsBytes !== undefined) {
    const agentDir = join(homeDir, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      options.initialSettingsBytes,
    );
  }

  if (options.initialMcpBytes !== undefined) {
    const agentDir = join(homeDir, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "mcp.json"), options.initialMcpBytes);
  }

  if (options.initialZshrcBytes !== undefined) {
    await writeFile(join(homeDir, ".zshrc"), options.initialZshrcBytes);
  }

  for (const beadsFile of options.beadsFiles ?? []) {
    const targetPath = join(homeDir, "beads", beadsFile.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, beadsFile.bytes);
  }

  await writeExecutable(
    join(binDir, "uname"),
    `#!/bin/sh
set -eu
printf "uname" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
printf "%s\\n" "${options.fakeUname ?? "Darwin"}"
`,
  );
  await writeExecutable(
    join(binDir, "git"),
    `#!/bin/sh
set -eu
printf "git" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
if [ "$#" -eq 4 ] && [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then
  printf "%s\\n" "$BOOTSTRAP_FAKE_REPO"
  exit 0
fi
if [ "$#" -eq 4 ] && [ "$1" = "-C" ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then
  printf "%s\\n" "$BOOTSTRAP_FAKE_HEAD"
  exit 0
fi
echo "unexpected git invocation: $*" >&2
exit 2
`,
  );

  if (options.includeBrew ?? false) {
    await writeExecutable(
      join(binDir, "brew"),
      `#!/bin/sh
set -eu
printf "brew" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
if [ "$#" -eq 3 ] && [ "$1" = "list" ] && [ "$2" = "--formula" ]; then
  case " $BOOTSTRAP_INSTALLED_FORMULAS " in
    *" $3 "*) exit 0 ;;
  esac
  exit 1
fi
if [ "$#" -eq 2 ] && [ "$1" = "install" ]; then
  exit 0
fi
echo "unexpected brew invocation: $*" >&2
exit 2
`,
    );
  }

  await Promise.all([
    writeExecutable(
      join(binDir, "volta"),
      `#!/bin/sh
set -eu
printf "volta" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
if [ "$#" -eq 2 ] && [ "$1" = "install" ] && [ "$2" = "node@22.19.0" ]; then
  exit 0
fi
echo "unexpected volta invocation: $*" >&2
exit 2
`,
    ),
    writeExecutable(
      join(binDir, "npm"),
      `#!/bin/sh
set -eu
printf "npm" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
if [ "$#" -eq 4 ] && [ "$1" = "install" ] && [ "$2" = "--global" ] && [ "$3" = "--ignore-scripts" ] && [ "$4" = "@earendil-works/pi-coding-agent@0.84.1" ]; then
  exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 2
`,
    ),
    writeExecutable(
      join(binDir, "node"),
      `#!/bin/sh
set -eu
printf "node" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf "%s\\n" "${options.fakeNodeVersion ?? "v22.19.0"}"
  exit 0
fi
if [ "${options.failShellWithBackup ? "1" : "0"}" = "1" ] && [ "$#" -ge 4 ] && [ "$2" = "shell" ]; then
  zshrc_path=""
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--zshrc" ]; then
      zshrc_path=$2
      break
    fi
    shift
  done
  cp "$zshrc_path" "$zshrc_path.jpriverar-pi-bootstrap.bak"
  echo "simulated shell reconciliation failure" >&2
  exit 1
fi
exec "$BOOTSTRAP_REAL_NODE" "$@"
`,
    ),
    writeExecutable(
      join(binDir, "pi"),
      `#!/bin/sh
set -eu
printf "pi" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf "%s\\n" "${options.fakePiVersion ?? "0.84.1"}"
  exit 0
fi
if [ "$#" -eq 2 ] && [ "$1" = "install" ]; then
  install_count=0
  if [ -f "$BOOTSTRAP_PI_INSTALL_COUNT_PATH" ]; then
    install_count=$(cat "$BOOTSTRAP_PI_INSTALL_COUNT_PATH")
  fi
  install_count=$((install_count + 1))
  printf "%s" "$install_count" > "$BOOTSTRAP_PI_INSTALL_COUNT_PATH"
  source=$2
  if [ "$BOOTSTRAP_FAIL_PI_INSTALL_AT" -eq "$install_count" ]; then
    echo "simulated pi install failure for $source" >&2
    exit 1
  fi
  case "$source" in
    npm:*)
      spec=\${source#npm:}
      package_name=\${spec%@*}
      version=\${spec##*@}
      package_json="$PI_CODING_AGENT_DIR/npm/node_modules/$package_name/package.json"
      mkdir -p "$(dirname "$package_json")"
      cat > "$package_json" <<EOF
{
  "name": "$package_name",
  "version": "$version"
}
EOF
      ;;
  esac
  exit 0
fi
echo "unexpected pi invocation: $*" >&2
exit 2
`,
    ),
    writeExecutable(
      join(binDir, "bd"),
      `#!/bin/sh
set -eu
printf "bd" >> "$BOOTSTRAP_COMMAND_LOG"
for argument in "$@"; do
  printf " %s" "$argument" >> "$BOOTSTRAP_COMMAND_LOG"
done
printf "\\n" >> "$BOOTSTRAP_COMMAND_LOG"
if [ "$#" -eq 4 ] && [ "$1" = "init" ] && [ "$2" = "--init-if-missing" ] && [ "$3" = "--non-interactive" ] && [ "$4" = "--prefix" ]; then
  echo "unexpected split prefix invocation" >&2
  exit 2
fi
if [ "$#" -eq 5 ] && [ "$1" = "init" ] && [ "$2" = "--init-if-missing" ] && [ "$3" = "--non-interactive" ] && [ "$4" = "--prefix" ] && [ "$5" = "jp" ]; then
  if [ "${options.failBd ? "1" : "0"}" = "1" ]; then
    echo "simulated beads init failure" >&2
    exit 1
  fi
  mkdir -p "$PWD/.beads"
  exit 0
fi
echo "unexpected bd invocation: $*" >&2
exit 2
`,
    ),
  ]);

  return {
    binDir,
    commandLogPath,
    failBd: options.failBd ?? false,
    failPiInstallAt: options.failPiInstallAt,
    failShellWithBackup: options.failShellWithBackup ?? false,
    homeDir,
    installedFormulas: options.installedFormulas ?? [],
    piInstallCountPath,
    repoRoot,
    scriptPath,
  };
}

async function invoke(state: BootstrapState) {
  const result = spawnSync("/bin/bash", [state.scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: state.homeDir,
      PATH: `${state.binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      BOOTSTRAP_COMMAND_LOG: state.commandLogPath,
      BOOTSTRAP_FAIL_PI_INSTALL_AT: String(state.failPiInstallAt ?? 0),
      BOOTSTRAP_FAKE_HEAD: fakeHead,
      BOOTSTRAP_FAKE_REPO: state.repoRoot,
      BOOTSTRAP_INSTALLED_FORMULAS: state.installedFormulas.join(" "),
      BOOTSTRAP_PI_INSTALL_COUNT_PATH: state.piInstallCountPath,
      BOOTSTRAP_REAL_NODE: process.execPath,
    },
  });

  return {
    commandLog: await readCommandLog(state.commandLogPath),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

test("bootstrap fails before mutating state when Homebrew is missing", async (t) => {
  const state = await fixture(t);
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Homebrew is required before bootstrapping Pi/);
  assert.equal(await pathExists(join(state.homeDir, ".pi")), false);
  assert.equal(await pathExists(join(state.homeDir, "beads")), false);
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
  assert.deepEqual(result.commandLog, ["uname -s"]);
});

test("bootstrap rejects non-macOS hosts before checking Homebrew", async (t) => {
  const state = await fixture(t, { fakeUname: "Linux" });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /macOS is required/);
  assert.equal(await pathExists(join(state.homeDir, ".pi")), false);
  assert.equal(await pathExists(join(state.homeDir, "beads")), false);
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
  assert.deepEqual(result.commandLog, ["uname -s"]);
});

test("bootstrap restores exact settings bytes when a package install fails", async (t) => {
  const originalSettingsBytes = [
    "{",
    '  "defaultProvider": "personal-provider",',
    '  "packages": [',
    '    "npm:some-public-helper@1.2.3"',
    "  ]",
    "}",
    "",
  ].join("\n");
  const state = await fixture(t, {
    failPiInstallAt: 3,
    includeBrew: true,
    initialSettingsBytes: originalSettingsBytes,
  });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Pi install npm:pi-subagents@0\.50\.0 failed/);
  assert.equal(
    await readFile(
      join(state.homeDir, ".pi", "agent", "settings.json"),
      "utf8",
    ),
    originalSettingsBytes,
  );
  assert.equal(await pathExists(join(state.homeDir, "beads")), false);
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
  assert.equal(
    await pathExists(managedPackagePath(state.homeDir, "pi-mcp-adapter")),
    true,
  );
  assert.equal(
    await pathExists(managedPackagePath(state.homeDir, "pi-subagents")),
    false,
  );
  assert.deepEqual(await listTreePaths(state.homeDir), [
    ".pi/",
    ".pi/agent/",
    ".pi/agent/npm/",
    ".pi/agent/npm/node_modules/",
    ".pi/agent/npm/node_modules/pi-mcp-adapter/",
    ".pi/agent/npm/node_modules/pi-mcp-adapter/package.json",
    ".pi/agent/settings.json",
  ]);
});

test("bootstrap runs the happy path in the reviewed command order", async (t) => {
  const state = await fixture(t, { includeBrew: true });
  const result = await invoke(state);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.commandLog, await expectedHappyPathCommandLog(state));
  assert.match(result.stdout, /\/login/);
  assert.match(result.stdout, /\/reload/);
  assert.match(result.stdout, /git pull --ff-only/);
  assert.match(result.stdout, new RegExp(fakeHead));

  const canonicalHomeDir = await realpath(state.homeDir);
  const settings = JSON.parse(
    await readFile(
      join(canonicalHomeDir, ".pi", "agent", "settings.json"),
      "utf8",
    ),
  );
  assert.deepEqual(settings.packages, [state.repoRoot, ...managedSources]);
  assert.equal(
    await pathExists(join(canonicalHomeDir, "beads", ".beads")),
    true,
  );
  assert.equal(await pathExists(join(canonicalHomeDir, ".zshrc")), true);
});

test("bootstrap skips formula installs when Homebrew already has them", async (t) => {
  const state = await fixture(t, {
    includeBrew: true,
    installedFormulas: ["volta", "beads"],
  });
  const result = await invoke(state);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commandLog.includes("brew install volta"), false);
  assert.equal(result.commandLog.includes("brew install beads"), false);
  assert.equal(result.commandLog.includes("node --version"), true);
  assert.equal(
    result.commandLog.includes(
      "bd init --init-if-missing --non-interactive --prefix jp",
    ),
    true,
  );
});

test("bootstrap keeps verified settings when Beads initialization fails", async (t) => {
  const state = await fixture(t, {
    failBd: true,
    includeBrew: true,
  });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes("/login"), false);
  assert.match(result.stderr, /Beads initialization failed/);
  assert.equal(
    result.commandLog.includes(
      `node ${join(state.repoRoot, "scripts", "reconcile-personal-profile.mjs")} verify --agent-dir ${join(state.homeDir, ".pi", "agent")} --repo-dir ${state.repoRoot}`,
    ),
    true,
  );
  assert.equal(
    result.commandLog.includes(
      `node ${join(state.repoRoot, "scripts", "reconcile-personal-profile.mjs")} shell --zshrc ${join(state.homeDir, ".zshrc")}`,
    ),
    false,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(state.homeDir, ".pi", "agent", "settings.json"),
        "utf8",
      ),
    ).packages,
    [state.repoRoot, ...managedSources],
  );
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
});

test("bootstrap leaves shell bytes unchanged and keeps the backup when shell reconciliation fails", async (t) => {
  const originalZshrcBytes = [
    'export PATH="$PATH:$HOME/bin"',
    "alias gs='git status'",
    "",
  ].join("\n");
  const state = await fixture(t, {
    failShellWithBackup: true,
    includeBrew: true,
    initialZshrcBytes: originalZshrcBytes,
  });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes("/login"), false);
  assert.match(result.stderr, /shell reconciliation failed/);
  assert.equal(
    await readFile(join(state.homeDir, ".zshrc"), "utf8"),
    originalZshrcBytes,
  );
  assert.equal(
    await readFile(
      join(state.homeDir, ".zshrc.jpriverar-pi-bootstrap.bak"),
      "utf8",
    ),
    originalZshrcBytes,
  );
});

test("bootstrap reuses an initialized Beads store without changing its bytes", async (t) => {
  const state = await fixture(t, {
    beadsFiles: [
      {
        bytes: ["prefix=jp", "store=personal", ""].join("\n"),
        path: join(".beads", "config.txt"),
      },
    ],
    includeBrew: true,
  });
  const beforeSnapshot = await snapshotDirectory(join(state.homeDir, "beads"));
  const result = await invoke(state);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.commandLog.includes(
      "bd init --init-if-missing --non-interactive --prefix jp",
    ),
    true,
  );
  assert.deepEqual(
    await snapshotDirectory(join(state.homeDir, "beads")),
    beforeSnapshot,
  );
});

test("bootstrap never logs remote-related Beads arguments", async (t) => {
  const state = await fixture(t, { includeBrew: true });
  const result = await invoke(state);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.commandLog.filter((entry) => entry.startsWith("bd ")),
    ["bd init --init-if-missing --non-interactive --prefix jp"],
  );
});

test("bootstrap reruns leave managed configuration byte-identical", async (t) => {
  const state = await fixture(t, { includeBrew: true });
  const first = await invoke(state);

  assert.equal(first.status, 0, first.stderr);

  const settingsPath = join(state.homeDir, ".pi", "agent", "settings.json");
  const zshrcPath = join(state.homeDir, ".zshrc");
  const firstSettingsBytes = await readFile(settingsPath, "utf8");
  const firstZshrcBytes = await readFile(zshrcPath, "utf8");
  const firstBeadsSnapshot = await snapshotDirectory(
    join(state.homeDir, "beads"),
  );
  const firstManagedPackages = JSON.parse(firstSettingsBytes).packages.filter(
    (entry: string) =>
      entry === state.repoRoot || managedSources.includes(entry),
  );

  const second = await invoke(state);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(settingsPath, "utf8"), firstSettingsBytes);
  assert.equal(await readFile(zshrcPath, "utf8"), firstZshrcBytes);
  assert.deepEqual(
    await snapshotDirectory(join(state.homeDir, "beads")),
    firstBeadsSnapshot,
  );
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")).packages.filter(
      (entry: string) =>
        entry === state.repoRoot || managedSources.includes(entry),
    ),
    firstManagedPackages,
  );
  for (const source of [state.repoRoot, ...managedSources]) {
    assert.equal(
      JSON.parse(await readFile(settingsPath, "utf8")).packages.filter(
        (entry: string) => entry === source,
      ).length,
      1,
    );
  }
  assert.equal(second.stdout, first.stdout);
});

test("bootstrap ignores unrelated settings fields containing the work marker during shell preflight", async (t) => {
  const state = await fixture(t, {
    includeBrew: true,
    initialSettingsBytes: `${JSON.stringify({ defaultProvider: `${workMarker}-personal-provider`, packages: ["npm:some-public-helper@1.2.3"] }, null, 2)}\n`,
  });
  const result = await invoke(state);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commandLog.includes("brew list --formula volta"), true);
  assert.equal(
    result.commandLog.includes("pi install npm:pi-mcp-adapter@2.26.0"),
    true,
  );
});

test("bootstrap fails the shell preflight before mutation when work-only settings package sources use split-line JSON", async (t) => {
  const state = await fixture(t, {
    includeBrew: true,
    initialSettingsBytes: [
      "{",
      '  "packages"',
      "  :",
      "  [",
      `    "npm:@${workMarker}/private-plugin@1.0.0"`,
      "  ],",
      '  "defaultProvider": "personal-provider"',
      "}",
      "",
    ].join("\n"),
  });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    new RegExp(
      `Forbidden work-only package source in .*${String.raw`settings\.json`}`,
    ),
  );
  assert.deepEqual(
    result.commandLog,
    await expectedResolveRepoCommandLog(state),
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("brew ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("volta ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("npm ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("pi ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("bd ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.includes(" shell ")),
    false,
  );
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
  assert.equal(await pathExists(join(state.homeDir, "beads")), false);
});

test("bootstrap fails the shell preflight before mutation when work-only MCP bytes are present", async (t) => {
  const state = await fixture(t, {
    includeBrew: true,
    initialMcpBytes: `${JSON.stringify({ servers: [{ url: `https://${workMarker}.example.com` }] }, null, 2)}\n`,
  });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    new RegExp(`Forbidden work-only MCP marker in .*${String.raw`mcp\.json`}`),
  );
  assert.deepEqual(
    result.commandLog,
    await expectedResolveRepoCommandLog(state),
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("brew ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("volta ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("npm ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("pi ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.startsWith("bd ")),
    false,
  );
  assert.equal(
    result.commandLog.some((entry) => entry.includes(" shell ")),
    false,
  );
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
  assert.equal(await pathExists(join(state.homeDir, "beads")), false);
});

test("bootstrap fails before Beads setup when node is not the reviewed version", async (t) => {
  const state = await fixture(t, {
    fakeNodeVersion: "v22.20.0",
    includeBrew: true,
  });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes("/login"), false);
  assert.match(
    result.stderr,
    /expected node version v22\.19\.0, got v22\.20\.0/,
  );
  assert.equal(result.commandLog.includes("node --version"), true);
  assert.equal(result.commandLog.includes("pi --version"), false);
  assert.equal(
    result.commandLog.includes(
      "bd init --init-if-missing --non-interactive --prefix jp",
    ),
    false,
  );
  assert.equal(await pathExists(join(state.homeDir, "beads", ".beads")), false);
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
});

test("bootstrap fails before Beads setup when pi is not the reviewed version", async (t) => {
  const state = await fixture(t, {
    fakePiVersion: "0.84.2",
    includeBrew: true,
  });
  const result = await invoke(state);

  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes("/login"), false);
  assert.match(result.stderr, /expected pi version 0\.84\.1, got 0\.84\.2/);
  assert.equal(result.commandLog.includes("node --version"), true);
  assert.equal(result.commandLog.includes("pi --version"), true);
  assert.equal(
    result.commandLog.includes(
      "bd init --init-if-missing --non-interactive --prefix jp",
    ),
    false,
  );
  assert.equal(await pathExists(join(state.homeDir, "beads", ".beads")), false);
  assert.equal(await pathExists(join(state.homeDir, ".zshrc")), false);
});
