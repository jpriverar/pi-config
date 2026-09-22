import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  createGitArtifactObserver,
  type GitArtifactExecutionResult,
  type GitArtifactExecutor,
} from "./git-artifact-observer.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

const realExecutor: GitArtifactExecutor = {
  async run(executable, args, cwd) {
    try {
      const result = await execFileAsync(executable, [...args], {
        cwd,
        maxBuffer: 128 * 1024,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const value = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof value.code === "number" ? value.code : 1,
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? "",
      };
    }
  },
};

async function repository(): Promise<{ directory: string; head: string }> {
  const directory = await temporaryDirectory("git-artifact-observer-");
  await git(directory, "init", "-q", "-b", "topic");
  await git(directory, "config", "user.email", "test@example.com");
  await git(directory, "config", "user.name", "Test User");
  await writeFile(join(directory, "README.md"), "first\n");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-q", "-m", "first");
  await git(
    directory,
    "remote",
    "add",
    "origin",
    "https://github.com/DataDog/example.git",
  );
  return { directory, head: await git(directory, "rev-parse", "HEAD") };
}

async function cleanup() {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

test("observes attached, detached, and amended commits as minimal facts", async (t) => {
  t.after(cleanup);
  const fixture = await repository();
  const observer = createGitArtifactObserver({ executor: realExecutor });

  assert.deepEqual(
    await observer.observe([
      {
        kind: "git-head",
        operation: "commit",
        cwd: fixture.directory,
        ref: "HEAD",
      },
    ]),
    [
      {
        id: "branch:example:refs/heads/topic",
        kind: "branch",
        uri: "git://example/refs/heads/topic",
        title: "example topic",
        role: "evidence",
        sourceArtifactIds: [],
        supersededAt: null,
      },
      {
        id: `commit:example:${fixture.head}`,
        kind: "commit",
        uri: `git://example/commit/${fixture.head}`,
        title: `example ${fixture.head.slice(0, 12)}`,
        role: "evidence",
        sourceArtifactIds: [],
        supersededAt: null,
      },
    ],
  );

  await git(fixture.directory, "checkout", "-q", "--detach");
  assert.deepEqual(
    (
      await observer.observe([
        {
          kind: "git-head",
          operation: "commit",
          cwd: fixture.directory,
          ref: "HEAD",
        },
      ])
    ).map((artifact) => artifact.kind),
    ["commit"],
  );

  await git(fixture.directory, "switch", "-q", "topic");
  await writeFile(join(fixture.directory, "README.md"), "amended\n");
  await git(fixture.directory, "add", "README.md");
  await git(fixture.directory, "commit", "-q", "--amend", "--no-edit");
  const amended = await git(fixture.directory, "rev-parse", "HEAD");
  const observed = await observer.observe([
    {
      kind: "git-head",
      operation: "commit",
      cwd: fixture.directory,
      ref: "HEAD",
    },
  ]);
  assert.equal(observed.at(-1)?.id, `commit:example:${amended}`);
  assert.notEqual(amended, fixture.head);
});

test("observes an explicit pushed branch instead of the checked-out branch", async (t) => {
  t.after(cleanup);
  const fixture = await repository();
  const bare = await temporaryDirectory("git-artifact-remote-");
  await git(bare, "init", "-q", "--bare");
  await git(fixture.directory, "remote", "set-url", "--push", "origin", bare);
  await git(fixture.directory, "switch", "-q", "-c", "other");
  await git(fixture.directory, "push", "-q", "origin", "topic");

  const observer = createGitArtifactObserver({ executor: realExecutor });
  const observed = await observer.observe([
    {
      kind: "git-head",
      operation: "push",
      cwd: fixture.directory,
      ref: "topic",
    },
  ]);

  assert.equal(observed[0]?.uri, "git://example/refs/heads/topic");
  assert.equal(observed[1]?.uri, `git://example/commit/${fixture.head}`);
});

test("rejects invalid Git state and curates executor failures", async () => {
  const results = new Map<string, GitArtifactExecutionResult>();
  const executor: GitArtifactExecutor = {
    async run(_executable, args) {
      const key = args.join(" ");
      const result = results.get(key);
      return result ?? { code: 1, stdout: "", stderr: "not found" };
    },
  };
  const observer = createGitArtifactObserver({ executor });
  const intent = {
    kind: "git-head" as const,
    operation: "commit" as const,
    cwd: "/repo",
    ref: "HEAD",
  };

  assert.deepEqual(await observer.observe([intent]), []);

  results.set("rev-parse --show-toplevel", {
    code: 0,
    stdout: "/repo\n",
    stderr: "",
  });
  results.set("config --get remote.origin.url", {
    code: 0,
    stdout: "https://secret@github.com/DataDog/example.git\n",
    stderr: "",
  });
  assert.deepEqual(await observer.observe([intent]), []);

  results.set("config --get remote.origin.url", {
    code: 0,
    stdout: "https://github.com/DataDog/example.git\n",
    stderr: "",
  });
  results.set("rev-parse --symbolic-full-name --verify HEAD", {
    code: 0,
    stdout: "refs/evil/topic\n",
    stderr: "",
  });
  results.set("rev-parse --verify HEAD^{commit}", {
    code: 0,
    stdout: `${"a".repeat(40)}\n`,
    stderr: "",
  });
  assert.deepEqual(await observer.observe([intent]), []);

  results.set("rev-parse --symbolic-full-name --verify HEAD", {
    code: 0,
    stdout: "refs/heads/topic\n",
    stderr: "",
  });
  results.set("symbolic-ref --quiet --short HEAD", {
    code: 0,
    stdout: "topic\n",
    stderr: "",
  });
  results.set("rev-parse --verify HEAD^{commit}", {
    code: 0,
    stdout: "not-a-sha\n",
    stderr: "",
  });
  assert.deepEqual(await observer.observe([intent]), []);

  results.set("config --get remote.origin.url", {
    code: 0,
    stdout: `/tmp/${"x".repeat(131_073)}\n`,
    stderr: "",
  });
  assert.deepEqual(await observer.observe([intent]), []);

  const secret = "private stdout and stderr";
  const throwing = createGitArtifactObserver({
    executor: {
      async run() {
        throw new Error(secret);
      },
    },
  });
  await assert.rejects(
    throwing.observe([intent]),
    (error: Error) =>
      error.message === "Git artifact observation failed" &&
      !error.message.includes(secret),
  );
});

test("verifies and observes a GitHub pull request and branch", async () => {
  const calls: Array<{
    executable: "git" | "gh";
    args: readonly string[];
    cwd: string;
  }> = [];
  const observer = createGitArtifactObserver({
    executor: {
      async run(executable, args, cwd) {
        calls.push({ executable, args: [...args], cwd });
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 15955,
            url: "https://github.com/ddoghq/dd-go/pull/15955",
            headRefName: "topic",
          }),
          stderr: "",
        };
      },
    },
  });

  assert.deepEqual(
    await observer.observe([
      {
        kind: "github-pr",
        operation: "pr-create",
        cwd: "/repo",
        repository: "ddoghq/dd-go",
        head: "topic",
      },
    ]),
    [
      {
        id: "branch:dd-go:refs/heads/topic",
        kind: "branch",
        uri: "git://dd-go/refs/heads/topic",
        title: "dd-go topic",
        role: "evidence",
        sourceArtifactIds: [],
        supersededAt: null,
      },
      {
        id: "pull_request:ddoghq/dd-go:15955",
        kind: "pull_request",
        uri: "https://github.com/ddoghq/dd-go/pull/15955",
        title: "ddoghq/dd-go#15955",
        role: "evidence",
        sourceArtifactIds: [],
        supersededAt: null,
      },
    ],
  );
  assert.deepEqual(calls, [
    {
      executable: "gh",
      args: [
        "pr",
        "view",
        "topic",
        "--repo",
        "ddoghq/dd-go",
        "--json",
        "number,url,headRefName",
      ],
      cwd: "/repo",
    },
  ]);
});

test("rejects malformed or contradictory GitHub verification", async () => {
  const intent = {
    kind: "github-pr" as const,
    operation: "pr-create" as const,
    cwd: "/repo",
    repository: "ddoghq/dd-go",
    head: "topic",
  };
  for (const result of [
    { code: 1, stdout: "", stderr: "private failure" },
    { code: 0, stdout: "not-json", stderr: "" },
    {
      code: 0,
      stdout: JSON.stringify({
        number: 0,
        url: "https://github.com/ddoghq/dd-go/pull/0",
        headRefName: "topic",
      }),
      stderr: "",
    },
    {
      code: 0,
      stdout: JSON.stringify({
        number: 1,
        url: "https://example.com/ddoghq/dd-go/pull/1",
        headRefName: "topic",
      }),
      stderr: "",
    },
    {
      code: 0,
      stdout: JSON.stringify({
        number: 1,
        url: "https://github.com/DataDog/dd-go/pull/1",
        headRefName: "topic",
      }),
      stderr: "",
    },
    { code: 0, stdout: "x".repeat(131_073), stderr: "" },
  ]) {
    const observer = createGitArtifactObserver({
      executor: {
        async run() {
          return result;
        },
      },
    });
    assert.deepEqual(await observer.observe([intent]), []);
  }
});
