import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const execFileAsync = promisify(execFile);
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceScript = join(repository, "scripts", "refresh-superpowers.sh");

async function fixture(
  t: TestContext,
): Promise<{ root: string; script: string }> {
  const root = await mkdtemp(join(tmpdir(), "refresh-superpowers-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  const script = join(root, "scripts", "refresh-superpowers.sh");
  await cp(sourceScript, script);
  await chmod(script, 0o755);
  return { root, script };
}

async function invoke(
  script: string,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    const result = await execFileAsync(script, [version], {
      env,
      timeout: 10_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

test("refresh rejects a symlinked skills parent before cloning", async (t) => {
  const { root, script } = await fixture(t);
  const external = join(root, "external-skills");
  await mkdir(external);
  await symlink(external, join(root, "skills"));
  const result = await invoke(script, "6.3.0");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlinked skills parent/);
});

test("refresh rejects unsupported versions and concurrent writers before cloning", async (t) => {
  const { root, script } = await fixture(t);
  await mkdir(join(root, "skills"));
  const unsupported = await invoke(script, "6.3.1");
  assert.notEqual(unsupported.code, 0);
  assert.match(unsupported.stderr, /reviewed version mapping/);

  await mkdir(join(root, "skills", ".superpowers.refresh.lock"));
  const locked = await invoke(script, "6.3.0");
  assert.notEqual(locked.code, 0);
  assert.match(locked.stderr, /refresh already in progress/);
});

test("refresh verifies pinned tag and commit before replacing existing content", async (t) => {
  const { root, script } = await fixture(t);
  const skills = join(root, "skills");
  const destination = join(skills, "superpowers");
  const bin = join(root, "bin");
  await Promise.all([mkdir(destination, { recursive: true }), mkdir(bin)]);
  await writeFile(join(destination, "marker"), "original\n");
  const fakeGit = join(bin, "git");
  await writeFile(
    fakeGit,
    `#!/bin/sh\nset -eu\ncase " $* " in\n  *" clone "*)\n    eval "checkout=\\\${$#}"\n    mkdir -p "$checkout/skills/example"\n    printf 'MIT License\\n' > "$checkout/LICENSE"\n    printf '%s\\n' '---' 'name: example' 'description: Example skill for refresh tests.' '---' > "$checkout/skills/example/SKILL.md"\n    ;;\n  *" rev-parse v6.3.0^{} "*) printf '%s\\n' "\${FAKE_COMMIT:-b36e0829c6d0140e93cfef2ca599b1b07d4a7797}" ;;\n  *" rev-parse v6.3.0 "*) printf '%s\\n' "\${FAKE_TAG:-86babb696875227929e85420f287d6309374b93f}" ;;\n  *) echo "unexpected git invocation: $*" >&2; exit 2 ;;\nesac\n`,
  );
  await chmod(fakeGit, 0o755);
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const wrongTag = await invoke(script, "6.3.0", {
    ...baseEnv,
    FAKE_TAG: "wrong",
  });
  assert.notEqual(wrongTag.code, 0);
  assert.match(wrongTag.stderr, /tag mismatch/);
  assert.equal(
    await readFile(join(destination, "marker"), "utf8"),
    "original\n",
  );

  const wrongCommit = await invoke(script, "6.3.0", {
    ...baseEnv,
    FAKE_COMMIT: "wrong",
  });
  assert.notEqual(wrongCommit.code, 0);
  assert.match(wrongCommit.stderr, /commit mismatch/);
  assert.equal(
    await readFile(join(destination, "marker"), "utf8"),
    "original\n",
  );
});
