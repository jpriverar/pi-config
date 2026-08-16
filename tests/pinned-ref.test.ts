import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const pi = join(repository, "node_modules", ".bin", "pi");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "pinned-ref-test",
      GIT_AUTHOR_EMAIL: "pinned-ref@example.invalid",
      GIT_COMMITTER_NAME: "pinned-ref-test",
      GIT_COMMITTER_EMAIL: "pinned-ref@example.invalid",
    },
  }).trim();
}

async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

function guardedCleanup(path: string) {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(path);
  if (!target.startsWith(`${temporaryRoot}/`)) {
    throw new Error(`refusing unsafe cleanup: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function findGitCheckouts(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name === ".git") result.push(directory);
      else if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return result;
}

test("pi update preserves an exact configured commit SHA", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-pinned-ref-"));
  let daemon: ReturnType<typeof spawn> | undefined;
  try {
    const source = join(root, "source");
    // Pi 0.84.1 requires two managed-path segments for non-hosted Git URLs.
    const bare = join(root, "fixtures", "fixture.git");
    const profile = join(root, "agent");
    const workspace = join(root, "workspace");
    mkdirSync(source);
    mkdirSync(dirname(bare), { recursive: true });
    mkdirSync(profile);
    mkdirSync(workspace);
    git(source, ["init", "-q", "-b", "main"]);
    writeFileSync(
      join(source, "package.json"),
      `${JSON.stringify(
        {
          name: "pi-pinned-fixture",
          version: "0.0.0",
          type: "module",
          pi: { extensions: ["./index.js"] },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(source, "index.js"),
      "export default function fixture() {}\n",
    );
    git(source, ["add", "."]);
    git(source, ["commit", "-q", "-m", "Initial fixture"]);
    const initial = git(source, ["rev-parse", "HEAD"]);

    writeFileSync(
      join(source, "index.js"),
      "export default function fixture() { return 'newer'; }\n",
    );
    git(source, ["add", "index.js"]);
    git(source, ["commit", "-q", "-m", "Newer fixture"]);
    const newer = git(source, ["rev-parse", "HEAD"]);
    assert.notEqual(initial, newer);

    git(root, ["clone", "-q", "--bare", source, bare]);
    git(bare, ["config", "daemon.export", "ok"]);
    assert.equal(git(bare, ["rev-parse", `${initial}^{commit}`]), initial);
    assert.equal(git(bare, ["rev-parse", `${newer}^{commit}`]), newer);

    const port = await ephemeralPort();
    daemon = spawn(
      "git",
      [
        "daemon",
        "--reuseaddr",
        "--export-all",
        `--base-path=${root}`,
        "--listen=127.0.0.1",
        `--port=${port}`,
        root,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let daemonError = "";
    daemon.stderr?.setEncoding("utf8");
    daemon.stderr?.on("data", (chunk) => (daemonError += chunk));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    assert.equal(daemon.exitCode, null, daemonError);

    git(workspace, ["init", "-q", "-b", "main"]);
    const spec = `git:git://127.0.0.1:${port}/fixtures/fixture.git@${initial}`;
    const environment = {
      ...process.env,
      PI_CODING_AGENT_DIR: profile,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
    };
    const installed = spawnSync(pi, ["install", spec], {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    const settings = JSON.parse(
      readFileSync(join(profile, "settings.json"), "utf8"),
    );
    assert.deepEqual(settings.packages, [spec]);
    const checkouts = findGitCheckouts(join(profile, "git"));
    assert.equal(checkouts.length, 1);
    const checkout = checkouts[0];
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), initial);

    const updated = spawnSync(pi, ["update", "--extensions"], {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), initial);
    assert.deepEqual(
      JSON.parse(readFileSync(join(profile, "settings.json"), "utf8")).packages,
      [spec],
    );
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          daemon?.kill("SIGKILL");
          resolveExit();
        }, 2_000);
        daemon?.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    guardedCleanup(root);
  }
});
