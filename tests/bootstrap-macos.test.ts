import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
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

type BootstrapState = {
  binDir: string;
  commandLogPath: string;
  homeDir: string;
  installedFormulas: string[];
  repoRoot: string;
  scriptPath: string;
};

type FixtureOptions = {
  fakeUname?: string;
  includeBrew?: boolean;
  installedFormulas?: string[];
  fakeNodeVersion?: string;
  fakePiVersion?: string;
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

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "bootstrap-macos-test-"));
  const canonicalRoot = await realpath(root);
  t.after(() => rm(canonicalRoot, { recursive: true, force: true }));

  const repoRoot = join(canonicalRoot, "fixture repo with spaces");
  const scriptsDir = join(repoRoot, "scripts");
  const binDir = join(canonicalRoot, "bin");
  const homeDir = join(canonicalRoot, "home");
  const commandLogPath = join(canonicalRoot, "command.log");

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
  source=$2
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
    homeDir,
    installedFormulas: options.installedFormulas ?? [],
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
      BOOTSTRAP_REAL_NODE: process.execPath,
      BOOTSTRAP_FAKE_HEAD: fakeHead,
      BOOTSTRAP_FAKE_REPO: state.repoRoot,
      BOOTSTRAP_INSTALLED_FORMULAS: state.installedFormulas.join(" "),
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    commandLog: await readCommandLog(state.commandLogPath),
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
