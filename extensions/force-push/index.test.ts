import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, test } from "node:test";

import forcePush from "./index.js";

const execFileAsync = promisify(execFile);

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
};
type Tool = {
  name: string;
  description: string;
  executionMode?: string;
  parameters: any;
  promptGuidelines: string[];
  promptSnippet: string;
  execute(
    id: string,
    params: any,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: any,
  ): Promise<any>;
};
type ConfirmHandler = (
  title: string,
  message: string,
) => boolean | Promise<boolean>;
type HarnessOptions = {
  responses?: ExecResult[];
  execImpl?: (
    command: string,
    args: string[],
    options?: any,
  ) => Promise<ExecResult>;
};

type EmittedEvent = { name: string; data: unknown };

type Harness = ReturnType<typeof harness>;

const SHA_LOCAL = "1111111111111111111111111111111111111111";
const SHA_REMOTE = "2222222222222222222222222222222222222222";
const ROOT = "/repo";
const WEB_PROTOCOL = ["https", "://"].join("");
const SSH_PROTOCOL = ["ssh", "://"].join("");
const EXAMPLE_HOST = ["example", ".com"].join("");
const URL_USER = ["to", "ken"].join("");
const URL_PASS = ["sec", "ret"].join("");
const QUERY_KEY = ["credential"].join("");
const PUSH_TARGET = `${WEB_PROTOCOL}${EXAMPLE_HOST}/org/repo.git`;
const UNSANITIZED_REMOTE_URL = `${WEB_PROTOCOL}${URL_USER}:${URL_PASS}@${EXAMPLE_HOST}/org/repo.git?${QUERY_KEY}=hidden#fragment`;
const SANITIZED_REMOTE_URL = `${WEB_PROTOCOL}${EXAMPLE_HOST}/org/repo.git`;
const SCP_USER = ["sensitive", "-user"].join("");
const SCP_REMOTE_URL = `${SCP_USER}@${EXAMPLE_HOST}:org/repo.git`;
const SANITIZED_SCP_REMOTE_URL = `${EXAMPLE_HOST}:org/repo.git`;

const ok = (stdout = ""): ExecResult => ({
  code: 0,
  stdout,
  stderr: "",
  killed: false,
});
const exit = (code: number, stderr: string, stdout = ""): ExecResult => ({
  code,
  stdout,
  stderr,
  killed: false,
});

function inspectionResponses(
  overrides: Partial<Record<string, ExecResult>> = {},
) {
  return [
    overrides.root ?? ok(`${ROOT}\n`),
    overrides.branch ?? ok("topic\n"),
    overrides.remote ?? ok("origin\n"),
    overrides.pushUrl ?? ok(`${PUSH_TARGET}\n`),
    overrides.destination ?? ok("refs/heads/topic\n"),
    overrides.refFormat ?? ok(),
    overrides.localSha ?? ok(`${SHA_LOCAL}\n`),
    overrides.remoteHead ??
      ok(
        `ref: refs/heads/main\tHEAD\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\n`,
      ),
    overrides.fetch ?? ok(),
    overrides.remoteSha ?? ok(`${SHA_REMOTE}\n`),
  ];
}

function revalidationResponses(
  overrides: Partial<Record<string, ExecResult>> = {},
) {
  return [
    overrides.root ?? ok(`${ROOT}\n`),
    overrides.branch ?? ok("topic\n"),
    overrides.remote ?? ok("origin\n"),
    overrides.pushUrl ?? ok(`${PUSH_TARGET}\n`),
    overrides.destination ?? ok("refs/heads/topic\n"),
    overrides.localSha ?? ok(`${SHA_LOCAL}\n`),
    overrides.remoteHead ??
      ok(
        `ref: refs/heads/main\tHEAD\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\n`,
      ),
  ];
}

function noOpResponses() {
  return [
    ...inspectionResponses({ remoteSha: ok(`${SHA_LOCAL}\n`) }),
    ok("0\n"),
    ok("0\n"),
  ];
}

function fastForwardResponses() {
  return [...inspectionResponses(), ok(), ok("3\n"), ok("0\n")];
}

function rewindResponses() {
  return [...inspectionResponses(), exit(1, ""), ok(), ok("0\n"), ok("4\n")];
}

function divergentResponses(added = 2, removed = 1) {
  return [
    ...inspectionResponses(),
    exit(1, ""),
    exit(1, ""),
    ok(`${added}\n`),
    ok(`${removed}\n`),
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(options: HarnessOptions = {}) {
  const tools = new Map<string, Tool>();
  const execCalls: Array<{ command: string; args: string[]; options: any }> =
    [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const emittedEvents: EmittedEvent[] = [];
  const pending = [...(options.responses ?? [])];
  const execImpl =
    options.execImpl ??
    (async (
      command: string,
      args: string[],
      execOptions?: any,
    ): Promise<ExecResult> => {
      const response = pending.shift();
      if (!response)
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      return response;
    });
  const pi = {
    async exec(
      command: string,
      args: string[],
      execOptions?: any,
    ): Promise<ExecResult> {
      execCalls.push({ command, args, options: execOptions });
      return await execImpl(command, args, execOptions);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    events: {
      emit(name: string, data: unknown) {
        emittedEvents.push({ name, data });
      },
    },
  };
  forcePush(pi as any);
  return {
    tool: tools.get("force_push_current_branch")!,
    tools,
    execCalls,
    confirmCalls,
    emittedEvents,
    ctx(mode = "tui", confirm: boolean | ConfirmHandler = false) {
      const confirmHandler: ConfirmHandler =
        typeof confirm === "function" ? confirm : async () => confirm;
      return {
        cwd: "/repo/subdir",
        mode,
        ui: {
          confirm: async (title: string, message: string) => {
            confirmCalls.push({ title, message });
            return await confirmHandler(title, message);
          },
        },
      };
    },
  };
}

function pushCalls(h: Harness) {
  return h.execCalls.filter(
    ({ command, args }) => command === "git" && args[2] === "push",
  );
}

function commandCalls(h: Harness, match: (args: string[]) => boolean) {
  return h.execCalls.filter(
    ({ command, args }) => command === "git" && match(args),
  );
}

function expectNoPushAndNoConfirm(h: Harness) {
  assert.deepEqual(pushCalls(h), []);
  assert.deepEqual(h.confirmCalls, []);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function configureIdentity(repo: string) {
  await git(repo, ["config", "user.name", "Pi Force Push Test"]);
  await git(repo, ["config", "user.email", "pi-force-push@example.com"]);
}

async function commitFile(
  repo: string,
  name: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(repo, name), content);
  await git(repo, ["add", name]);
  await git(repo, ["commit", "-m", message]);
  return await git(repo, ["rev-parse", "HEAD"]);
}

async function createDistinctPushRemoteFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-force-push-remotes-"));
  const fetchRemote = join(tempRoot, "fetch.git");
  const pushRemote = join(tempRoot, "push.git");
  const primary = join(tempRoot, "primary");

  await git(tempRoot, ["init", "--bare", fetchRemote]);
  await git(tempRoot, ["init", "--bare", pushRemote]);
  await git(tempRoot, ["clone", fetchRemote, primary]);
  await configureIdentity(primary);
  await git(primary, ["checkout", "-b", "main"]);
  await commitFile(primary, "history.txt", "main\n", "seed main");
  await git(primary, ["push", "-u", "origin", "main"]);
  await git(tempRoot, [
    "--git-dir",
    fetchRemote,
    "symbolic-ref",
    "HEAD",
    "refs/heads/main",
  ]);
  await git(primary, ["checkout", "-b", "topic"]);
  await commitFile(primary, "history.txt", "topic\n", "seed topic");
  await git(primary, ["push", "-u", "origin", "topic"]);
  await git(primary, ["push", pushRemote, "topic"]);
  await git(tempRoot, [
    "--git-dir",
    pushRemote,
    "symbolic-ref",
    "HEAD",
    "refs/heads/topic",
  ]);
  await git(primary, ["remote", "set-url", "--push", "origin", pushRemote]);

  return { tempRoot, primary };
}

async function createLinkedWorktreeFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-force-push-linked-"));
  const remote = join(tempRoot, "remote.git");
  const primary = join(tempRoot, "primary");
  const linkedWorktree = join(tempRoot, "linked-topic");

  await git(tempRoot, ["init", "--bare", remote]);
  await git(tempRoot, ["clone", remote, primary]);
  await configureIdentity(primary);
  await git(primary, ["checkout", "-b", "main"]);
  await commitFile(primary, "history.txt", "main\n", "seed main");
  await git(primary, ["push", "-u", "origin", "main"]);
  await git(tempRoot, [
    "--git-dir",
    remote,
    "symbolic-ref",
    "HEAD",
    "refs/heads/main",
  ]);
  await git(primary, [
    "worktree",
    "add",
    linkedWorktree,
    "-b",
    "topic",
    "HEAD",
  ]);
  await configureIdentity(linkedWorktree);
  await commitFile(linkedWorktree, "history.txt", "topic 1\n", "seed topic");
  await git(linkedWorktree, ["push", "-u", "origin", "topic"]);

  return { tempRoot, remote, primary, linkedWorktree };
}

async function execResult(
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal },
) {
  // This real-Git adapter does not need concurrency.
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    encoding: "utf8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
    killed: result.signal !== null,
  } satisfies ExecResult;
}

function expectCredentialScrubbed(text: string) {
  assert.ok(!text.includes("token"));
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("credential"));
  assert.ok(!text.includes("fragment"));
}

describe("force_push_current_branch boundary", () => {
  test("registers one sequential reason-only tool", () => {
    const h = harness();
    assert.deepEqual([...h.tools.keys()], ["force_push_current_branch"]);
    assert.equal(h.tool.executionMode, "sequential");
    assert.ok(h.tool.description.includes("updating rewritten branch history"));
    assert.ok(h.tool.promptSnippet.includes("terminal-confirmed"));
    assert.ok(h.tool.promptSnippet.includes("rewritten history"));
    assert.equal(h.tool.promptGuidelines.length, 1);
    assert.ok(
      h.tool.promptGuidelines[0].includes(
        "Use force_push_current_branch instead of Bash",
      ),
    );
    assert.ok(
      h.tool.promptGuidelines[0].includes(
        "rebase, amend, squash, commit re-signing, or history cleanup",
      ),
    );
    assert.ok(
      h.tool.promptGuidelines[0].includes(
        "never retry a denial or failed push",
      ),
    );
    assert.ok(h.tool.promptGuidelines[0].includes("never fall back to Bash"));
    assert.equal(
      typeof h.tool.parameters.properties.reason.description,
      "string",
    );
    assert.ok(
      h.tool.parameters.properties.worktree.description.includes(
        "linked worktree",
      ),
    );
    assert.deepEqual(h.tool.parameters, {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          description: h.tool.parameters.properties.reason.description,
        },
        worktree: {
          type: "string",
          minLength: 1,
          description: h.tool.parameters.properties.worktree.description,
        },
      },
      required: ["reason"],
      additionalProperties: false,
    });
  });

  test(
    "targets an explicit linked worktree even when the parent cwd is outside the repository",
    { timeout: 20_000 },
    async () => {
      const { tempRoot, linkedWorktree } = await createLinkedWorktreeFixture();

      try {
        const canonicalLinkedWorktree = await realpath(linkedWorktree);
        const h = harness({
          execImpl: async (command, args, options) =>
            await execResult(command, args, {
              cwd: options?.cwd ?? tempRoot,
              signal: options?.signal,
            }),
        });

        const result = await h.tool.execute(
          "call-linked",
          { reason: "rewrite feature history", worktree: linkedWorktree },
          undefined,
          undefined,
          {
            cwd: tempRoot,
            mode: "tui",
            ui: {
              confirm: async (title: string, message: string) => {
                h.confirmCalls.push({ title, message });
                return false;
              },
            },
          },
        );

        assert.partialDeepStrictEqual(result.details, {
          status: "denied",
          reason: "user-declined",
          state: {
            root: await git(canonicalLinkedWorktree, [
              "rev-parse",
              "--show-toplevel",
            ]),
          },
        });
        assert.equal(h.confirmCalls.length, 1);
        assert.deepEqual(pushCalls(h), []);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  test(
    "rejects an explicit primary checkout target before confirmation",
    { timeout: 20_000 },
    async () => {
      const { tempRoot, primary } = await createLinkedWorktreeFixture();

      try {
        const h = harness({
          execImpl: async (command, args, options) =>
            await execResult(command, args, {
              cwd: options?.cwd ?? primary,
              signal: options?.signal,
            }),
        });

        await assert.rejects(
          h.tool.execute(
            "call-primary",
            { reason: "rewrite feature history", worktree: primary },
            undefined,
            undefined,
            { cwd: primary, mode: "tui", ui: { confirm: async () => false } },
          ),
          /explicit target is not a linked worktree/,
        );
        expectNoPushAndNoConfirm(h);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  test(
    "scrubs credential-bearing diagnostics and push results for an explicit linked worktree target",
    { timeout: 20_000 },
    async () => {
      const { tempRoot, linkedWorktree } = await createLinkedWorktreeFixture();

      try {
        const h = harness({
          execImpl: async (command, args, options) => {
            if (command === "git" && args.includes("ls-remote")) {
              return exit(
                128,
                `fatal: unable to access '${UNSANITIZED_REMOTE_URL}': could not read Username\n`,
              );
            }
            return await execResult(command, args, {
              cwd: options?.cwd ?? tempRoot,
              signal: options?.signal,
            });
          },
        });

        await assert.rejects(
          h.tool.execute(
            "call-linked-error",
            { reason: "rewrite feature history", worktree: linkedWorktree },
            undefined,
            undefined,
            { cwd: tempRoot, mode: "tui", ui: { confirm: async () => false } },
          ),
          /https:\/\/example\.com\/org\/repo\.git/,
        );

        await assert.rejects(
          h.tool.execute(
            "call-linked-error",
            { reason: "rewrite feature history", worktree: linkedWorktree },
            undefined,
            undefined,
            { cwd: tempRoot, mode: "tui", ui: { confirm: async () => false } },
          ),
          (error: Error) => {
            assert.doesNotMatch(
              error.message,
              /token|secret|credential|fragment/,
            );
            return true;
          },
        );
        expectNoPushAndNoConfirm(h);

        let confirmationMessage = "";
        const h2 = harness({
          execImpl: async (command, args, options) => {
            if (command === "git" && args[2] === "push") {
              return exit(
                1,
                `fatal: unable to access '${UNSANITIZED_REMOTE_URL}': rejected\n`,
                `${UNSANITIZED_REMOTE_URL}\n`,
              );
            }
            return await execResult(command, args, {
              cwd: options?.cwd ?? tempRoot,
              signal: options?.signal,
            });
          },
        });

        const result = await h2.tool.execute(
          "call-linked-push-failure",
          { reason: "rewrite feature history", worktree: linkedWorktree },
          undefined,
          undefined,
          {
            cwd: tempRoot,
            mode: "tui",
            ui: {
              confirm: async (title: string, message: string) => {
                h2.confirmCalls.push({ title, message });
                confirmationMessage = message;
                return true;
              },
            },
          },
        );

        assert.partialDeepStrictEqual(result.details, {
          status: "failed",
          code: 1,
        });
        expectCredentialScrubbed(confirmationMessage);
        expectCredentialScrubbed(result.content[0].text);
        expectCredentialScrubbed(result.details.stdout);
        expectCredentialScrubbed(result.details.stderr);
        expectCredentialScrubbed(JSON.stringify(result.details));
        assert.ok(result.details.stdout.includes(SANITIZED_REMOTE_URL));
        assert.ok(result.details.stderr.includes(SANITIZED_REMOTE_URL));
        assert.equal(h2.confirmCalls.length, 1);
        assert.equal(pushCalls(h2).length, 1);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  for (const mode of ["rpc", "print", "json"]) {
    test(`denies ${mode} mode without running Git`, async () => {
      const h = harness();
      const result = await h.tool.execute(
        "call-1",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx(mode),
      );
      assert.partialDeepStrictEqual(result.details, {
        status: "denied",
        reason: "terminal-ui-required",
      });
      assert.deepEqual(h.execCalls, []);
    });
  }

  const resolutionCases = [
    [
      "outside a repository",
      { root: exit(128, "fatal: not a git repository") },
      "resolve repository root",
      "fatal: not a git repository",
    ],
    [
      "detached HEAD",
      { branch: exit(1, "") },
      "resolve current branch",
      "exit 1",
    ],
    [
      "missing upstream remote",
      { remote: exit(1, "") },
      "resolve upstream remote",
      "exit 1",
    ],
    [
      "missing upstream destination",
      { destination: exit(1, "") },
      "resolve upstream destination",
      "exit 1",
    ],
    [
      "invalid destination ref",
      { refFormat: exit(1, "") },
      "validate upstream destination",
      "exit 1",
    ],
    [
      "unknown default branch",
      { remoteHead: exit(2, "remote HEAD unavailable") },
      "resolve remote default branch",
      "remote HEAD unavailable",
    ],
    [
      "absent remote branch",
      { fetch: exit(128, "couldn't find remote ref") },
      "fetch upstream destination",
      "couldn't find remote ref",
    ],
  ] as const;

  for (const [name, overrides, operation, detail] of resolutionCases) {
    test(`fails closed when ${name}`, async () => {
      const h = harness({ responses: inspectionResponses(overrides) });

      try {
        await h.tool.execute(
          "call-1",
          { reason: "rewrite feature history" },
          undefined,
          undefined,
          h.ctx(),
        );
        throw new Error("expected rejection");
      } catch (error) {
        const message = (error as Error).message;
        assert.ok(message.includes(`${operation} failed`));
        assert.ok(message.includes(detail));
      }

      expectNoPushAndNoConfirm(h);
    });
  }

  test("fails closed when a Git inspection is killed with code zero", async () => {
    const killedBranch = { ...ok("topic\n"), killed: true };
    const h = harness({
      responses: [
        ...inspectionResponses({
          branch: killedBranch,
          remoteSha: ok(`${SHA_LOCAL}\n`),
        }),
        ok("0\n"),
        ok("0\n"),
      ],
    });

    await assert.rejects(
      h.tool.execute(
        "call-1",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx(),
      ),
      /resolve current branch failed: interrupted or timed out/,
    );

    expectNoPushAndNoConfirm(h);
  });

  test("fails closed when the upstream remote has multiple push URLs", async () => {
    const h = harness({
      responses: inspectionResponses({
        pushUrl: ok(
          `${PUSH_TARGET}\n${SSH_PROTOCOL}${EXAMPLE_HOST}/org/repo.git\n`,
        ),
      }),
    });

    await assert.rejects(
      h.tool.execute(
        "call-1",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx(),
      ),
      /expected exactly one push URL/,
    );

    expectNoPushAndNoConfirm(h);
  });

  test("displays only the sanitized push target in confirmation", async () => {
    const h = harness({
      responses: [
        ...inspectionResponses({
          pushUrl: ok(`${UNSANITIZED_REMOTE_URL}\n`),
        }),
        exit(1, ""),
        exit(1, ""),
        ok("2\n"),
        ok("1\n"),
      ],
    });
    let message = "";

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", async (_title, capturedMessage) => {
        message = capturedMessage;
        return false;
      }),
    );

    assert.ok(message.includes(`Push target: ${SANITIZED_REMOTE_URL}`));
    assert.ok(!message.includes(UNSANITIZED_REMOTE_URL));
    assert.partialDeepStrictEqual(result.details, {
      status: "denied",
      reason: "user-declined",
    });
    assert.deepEqual(pushCalls(h), []);
  });

  test("sanitizes SCP-style userinfo in confirmation, diagnostics, and returned arguments", async () => {
    const diagnosticHarness = harness({
      responses: inspectionResponses({
        pushUrl: ok(`${SCP_REMOTE_URL}\n`),
        remoteHead: exit(
          128,
          `fatal: unable to access '${SCP_REMOTE_URL}': unavailable\n`,
        ),
      }),
    });

    await assert.rejects(
      diagnosticHarness.tool.execute(
        "call-scp-diagnostic",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        diagnosticHarness.ctx(),
      ),
      (error: Error) => {
        assert.match(error.message, /example\.com:org\/repo\.git/);
        assert.ok(!error.message.includes(SCP_USER));
        return true;
      },
    );
    expectNoPushAndNoConfirm(diagnosticHarness);

    const pushHarness = harness({
      responses: [
        ...inspectionResponses({ pushUrl: ok(`${SCP_REMOTE_URL}\n`) }),
        exit(1, ""),
        exit(1, ""),
        ok("2\n"),
        ok("1\n"),
        ...revalidationResponses({ pushUrl: ok(`${SCP_REMOTE_URL}\n`) }),
        ok("pushed\n"),
      ],
    });
    let confirmationMessage = "";
    const result = await pushHarness.tool.execute(
      "call-scp-push",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      pushHarness.ctx("tui", async (_title, message) => {
        confirmationMessage = message;
        return true;
      }),
    );

    assert.ok(
      confirmationMessage.includes(`Push target: ${SANITIZED_SCP_REMOTE_URL}`),
    );
    assert.ok(!confirmationMessage.includes(SCP_USER));
    assert.partialDeepStrictEqual(result.details, {
      status: "succeeded",
      pushArgs: [
        "-C",
        ROOT,
        "push",
        `--force-with-lease=refs/heads/topic:${SHA_REMOTE}`,
        "--",
        SANITIZED_SCP_REMOTE_URL,
        `${SHA_LOCAL}:refs/heads/topic`,
      ],
    });
    assert.ok(!JSON.stringify(result.details).includes(SCP_USER));
  });

  test("denies force push to the remote default branch before fetching", async () => {
    const h = harness({
      responses: inspectionResponses({ destination: ok("refs/heads/main\n") }),
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx(),
    );

    assert.deepEqual(result.details, {
      status: "denied",
      reason: "default-branch",
    });
    assert.equal(
      h.execCalls.some(({ args }) => args.includes("fetch")),
      false,
    );
    expectNoPushAndNoConfirm(h);
  });

  test(
    "uses the exact push URL for default-branch protection",
    { timeout: 20_000 },
    async () => {
      const { tempRoot, primary } = await createDistinctPushRemoteFixture();

      try {
        const h = harness({
          execImpl: async (command, args, options) =>
            await execResult(command, args, {
              cwd: options?.cwd ?? primary,
              signal: options?.signal,
            }),
        });
        const result = await h.tool.execute(
          "call-distinct-push-remote",
          { reason: "rewrite feature history" },
          undefined,
          undefined,
          { cwd: primary, mode: "tui", ui: { confirm: async () => false } },
        );

        assert.deepEqual(result.details, {
          status: "denied",
          reason: "default-branch",
        });
        expectNoPushAndNoConfirm(h);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  test("reaches confirmation for no-op updates without ancestry checks", async () => {
    const h = harness({ responses: noOpResponses() });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", false),
    );

    assert.partialDeepStrictEqual(result.details, {
      status: "denied",
      reason: "user-declined",
      state: {
        root: ROOT,
        branch: "topic",
        remote: "origin",
        destination: "refs/heads/topic",
        localSha: SHA_LOCAL,
        remoteSha: SHA_LOCAL,
        kind: "no-op",
        added: 0,
        removed: 0,
      },
    });
    assert.equal(
      h.execCalls.filter(({ args }) => args.includes("merge-base")).length,
      0,
    );
    assert.deepEqual(pushCalls(h), []);
    assert.equal(h.confirmCalls.length, 1);
  });

  const classificationCases = [
    [
      "fast-forward",
      fastForwardResponses(),
      { kind: "fast-forward", added: 3, removed: 0 },
    ],
    ["rewind", rewindResponses(), { kind: "rewind", added: 0, removed: 4 }],
    [
      "divergent",
      divergentResponses(),
      { kind: "divergent", added: 2, removed: 1 },
    ],
  ] as const;

  for (const [kind, responses, summary] of classificationCases) {
    test(`reaches confirmation for ${kind} updates with exact counts`, async () => {
      const h = harness({ responses });

      const result = await h.tool.execute(
        "call-1",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx("tui", false),
      );

      assert.partialDeepStrictEqual(result.details, {
        status: "denied",
        reason: "user-declined",
        state: {
          root: ROOT,
          branch: "topic",
          remote: "origin",
          destination: "refs/heads/topic",
          localSha: SHA_LOCAL,
          remoteSha: SHA_REMOTE,
          kind,
          added: summary.added,
          removed: summary.removed,
        },
      });
      assert.deepEqual(pushCalls(h), []);
      assert.equal(h.confirmCalls.length, 1);
    });
  }

  test("fails closed when an ancestry check is killed with code zero", async () => {
    const killedAncestry = { ...ok(), killed: true };
    const h = harness({
      responses: [
        ...inspectionResponses(),
        killedAncestry,
        ok("3\n"),
        ok("0\n"),
      ],
    });

    await assert.rejects(
      h.tool.execute(
        "call-1",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx(),
      ),
      /check whether remote commit is ancestor failed: interrupted or timed out/,
    );
    expectNoPushAndNoConfirm(h);
  });

  test("publishes blocked state only while awaiting confirmation", async () => {
    const confirmationReady = deferred<void>();
    const releaseConfirmation = deferred<boolean>();
    const h = harness({ responses: divergentResponses() });

    const resultPromise = h.tool.execute(
      "call-wait",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", async () => {
        confirmationReady.resolve();
        return await releaseConfirmation.promise;
      }),
    );

    await confirmationReady.promise;
    try {
      assert.deepEqual(h.emittedEvents, [
        {
          name: "force-push:blocked",
          data: { active: true },
        },
      ]);
    } finally {
      releaseConfirmation.resolve(false);
      await resultPromise;
    }

    assert.deepEqual(h.emittedEvents, [
      {
        name: "force-push:blocked",
        data: { active: true },
      },
      {
        name: "force-push:blocked",
        data: { active: false },
      },
    ]);
  });

  test("ends the authorization wait when confirmation throws", async () => {
    const h = harness({ responses: divergentResponses() });

    await assert.rejects(
      h.tool.execute(
        "call-error",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx("tui", async () => {
          throw new Error("confirmation unavailable");
        }),
      ),
      /confirmation unavailable/,
    );

    assert.deepEqual(h.emittedEvents, [
      {
        name: "force-push:blocked",
        data: { active: true },
      },
      {
        name: "force-push:blocked",
        data: { active: false },
      },
    ]);
  });

  test("binds confirmation to the exact state and trimmed reason", async () => {
    const h = harness({ responses: divergentResponses() });
    let title = "";
    let message = "";

    const result = await h.tool.execute(
      "call-1",
      { reason: "  rewrite feature history  " },
      undefined,
      undefined,
      h.ctx("tui", async (capturedTitle, capturedMessage) => {
        title = capturedTitle;
        message = capturedMessage;
        return false;
      }),
    );

    assert.equal(title, "Authorize one force push?");
    assert.ok(message.includes(ROOT));
    assert.ok(message.includes("origin"));
    assert.ok(message.includes(`Push target: ${PUSH_TARGET}`));
    assert.ok(message.includes("refs/heads/topic"));
    assert.ok(message.includes(SHA_REMOTE));
    assert.ok(message.includes(SHA_LOCAL));
    assert.ok(message.includes("divergent"));
    assert.ok(message.includes("2 added, 1 removed"));
    assert.ok(message.includes("rewrite feature history"));
    assert.ok(message.includes("rewrite the remote ref"));
    assert.partialDeepStrictEqual(result.details, {
      status: "denied",
      reason: "user-declined",
    });
    assert.deepEqual(pushCalls(h), []);
  });

  test("revalidates repository authority after approval before pushing", async () => {
    const h = harness({
      responses: [
        ...divergentResponses(),
        ...revalidationResponses(),
        ok("pushed\n"),
      ],
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", true),
    );

    assert.partialDeepStrictEqual(result.details, {
      status: "succeeded",
      code: 0,
    });
    assert.equal(
      commandCalls(
        h,
        (args) => args[0] === "rev-parse" && args[1] === "--show-toplevel",
      ).length,
      2,
    );
    assert.equal(
      commandCalls(h, (args) => args[2] === "symbolic-ref").length,
      2,
    );
    assert.equal(
      commandCalls(
        h,
        (args) => args[2] === "config" && args[4] === "branch.topic.remote",
      ).length,
      2,
    );
    assert.equal(
      commandCalls(h, (args) => args[2] === "remote" && args[3] === "get-url")
        .length,
      2,
    );
    assert.equal(
      commandCalls(
        h,
        (args) =>
          args[2] === "rev-parse" &&
          args[3] === "--verify" &&
          args[4] === "HEAD^{commit}",
      ).length,
      2,
    );
    assert.equal(
      commandCalls(
        h,
        (args) => args[2] === "ls-remote" && args[3] === "--symref",
      ).length,
      2,
    );
    assert.equal(pushCalls(h).length, 1);
  });

  test("denies the push when the push target changes after approval", async () => {
    let currentPushUrl = PUSH_TARGET;
    const h = harness({
      execImpl: async (_command, args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
          return ok(`${ROOT}\n`);
        if (args[2] === "symbolic-ref") return ok("topic\n");
        if (args[2] === "config" && args[4] === "branch.topic.remote")
          return ok("origin\n");
        if (args[2] === "remote" && args[3] === "get-url")
          return ok(`${currentPushUrl}\n`);
        if (args[2] === "config" && args[4] === "branch.topic.merge")
          return ok("refs/heads/topic\n");
        if (args[2] === "check-ref-format") return ok();
        if (
          args[2] === "rev-parse" &&
          args[3] === "--verify" &&
          args[4] === "HEAD^{commit}"
        )
          return ok(`${SHA_LOCAL}\n`);
        if (args[2] === "ls-remote" && args[3] === "--symref")
          return ok(
            "ref: refs/heads/main\tHEAD\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\n",
          );
        if (args[2] === "fetch") return ok();
        if (args[2] === "rev-parse" && args[4] === "FETCH_HEAD^{commit}")
          return ok(`${SHA_REMOTE}\n`);
        if (args[2] === "merge-base") return exit(1, "");
        if (args[2] === "rev-list" && args[4] === `${SHA_REMOTE}..${SHA_LOCAL}`)
          return ok("2\n");
        if (args[2] === "rev-list" && args[4] === `${SHA_LOCAL}..${SHA_REMOTE}`)
          return ok("1\n");
        throw new Error(`unexpected command: git ${args.join(" ")}`);
      },
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", async () => {
        currentPushUrl = `${SSH_PROTOCOL}${EXAMPLE_HOST}/other/repo.git`;
        return true;
      }),
    );

    assert.partialDeepStrictEqual(result.details, {
      status: "denied",
      reason: "state-changed",
    });
    assert.deepEqual(pushCalls(h), []);
  });

  test("denies the push when the approved destination becomes the default branch after approval", async () => {
    let remoteHead =
      "ref: refs/heads/other\tHEAD\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\n";
    const h = harness({
      execImpl: async (_command, args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
          return ok(`${ROOT}\n`);
        if (args[2] === "symbolic-ref") return ok("topic\n");
        if (args[2] === "config" && args[4] === "branch.topic.remote")
          return ok("origin\n");
        if (args[2] === "remote" && args[3] === "get-url")
          return ok(`${PUSH_TARGET}\n`);
        if (args[2] === "config" && args[4] === "branch.topic.merge")
          return ok("refs/heads/topic\n");
        if (args[2] === "check-ref-format") return ok();
        if (
          args[2] === "rev-parse" &&
          args[3] === "--verify" &&
          args[4] === "HEAD^{commit}"
        )
          return ok(`${SHA_LOCAL}\n`);
        if (args[2] === "ls-remote" && args[3] === "--symref")
          return ok(remoteHead);
        if (args[2] === "fetch") return ok();
        if (args[2] === "rev-parse" && args[4] === "FETCH_HEAD^{commit}")
          return ok(`${SHA_REMOTE}\n`);
        if (args[2] === "merge-base") return exit(1, "");
        if (args[2] === "rev-list" && args[4] === `${SHA_REMOTE}..${SHA_LOCAL}`)
          return ok("2\n");
        if (args[2] === "rev-list" && args[4] === `${SHA_LOCAL}..${SHA_REMOTE}`)
          return ok("1\n");
        throw new Error(`unexpected command: git ${args.join(" ")}`);
      },
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", async () => {
        remoteHead =
          "ref: refs/heads/topic\tHEAD\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\n";
        return true;
      }),
    );

    assert.partialDeepStrictEqual(result.details, {
      status: "denied",
      reason: "default-branch",
    });
    assert.deepEqual(pushCalls(h), []);
  });

  test(
    "pins the approved push URL for the final push even if the remote config changes after revalidation",
    { timeout: 20_000 },
    async () => {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "pi-force-push-pinned-url-"),
      );

      try {
        const remote = join(tempRoot, "remote.git");
        const redirected = join(tempRoot, "redirected.git");
        const agent = join(tempRoot, "agent");

        await git(tempRoot, ["init", "--bare", remote]);
        await git(tempRoot, ["init", "--bare", redirected]);
        await git(tempRoot, ["clone", remote, agent]);
        await configureIdentity(agent);
        await git(agent, ["checkout", "-b", "main"]);
        await commitFile(agent, "history.txt", "main\n", "seed main");
        await git(agent, ["push", "-u", "origin", "main"]);
        await git(tempRoot, [
          "--git-dir",
          remote,
          "symbolic-ref",
          "HEAD",
          "refs/heads/main",
        ]);
        await git(agent, ["checkout", "-b", "topic"]);
        await commitFile(agent, "history.txt", "topic 1\n", "seed topic");
        await git(agent, ["push", "-u", "origin", "topic"]);
        const approvedPushUrl = await git(agent, [
          "remote",
          "get-url",
          "--push",
          "--",
          "origin",
        ]);
        const approvedRemoteSha = await git(tempRoot, [
          "--git-dir",
          remote,
          "rev-parse",
          "refs/heads/topic",
        ]);
        const canonicalAgent = await realpath(agent);

        let pushUrlReads = 0;
        const h = harness({
          execImpl: async (command, args, options) => {
            const result = await execResult(command, args, {
              cwd: options?.cwd ?? agent,
              signal: options?.signal,
            });
            if (
              command === "git" &&
              args[2] === "remote" &&
              args[3] === "get-url"
            ) {
              pushUrlReads += 1;
              if (pushUrlReads === 2) {
                await git(agent, [
                  "config",
                  "remote.origin.pushurl",
                  redirected,
                ]);
              }
            }
            return result;
          },
        });

        const approvedSha = await commitFile(
          agent,
          "history.txt",
          "topic 2\n",
          "agent rewrite 1",
        );
        const result = await h.tool.execute(
          "call-1",
          { reason: "rewrite feature history" },
          undefined,
          undefined,
          {
            cwd: agent,
            mode: "tui",
            ui: { confirm: async () => true },
          },
        );

        assert.partialDeepStrictEqual(result.details, {
          status: "succeeded",
          state: { localSha: approvedSha, destination: "refs/heads/topic" },
        });
        assert.deepEqual(pushCalls(h), [
          {
            command: "git",
            args: [
              "-C",
              canonicalAgent,
              "push",
              `--force-with-lease=refs/heads/topic:${approvedRemoteSha}`,
              "--",
              approvedPushUrl,
              `${approvedSha}:refs/heads/topic`,
            ],
            options: { signal: undefined, timeout: 120_000 },
          },
        ]);
        assert.equal(
          await git(tempRoot, [
            "--git-dir",
            remote,
            "rev-parse",
            "refs/heads/topic",
          ]),
          approvedSha,
        );
        const redirectedResult = await execResult(
          "git",
          [
            "--git-dir",
            redirected,
            "rev-parse",
            "--verify",
            "refs/heads/topic",
          ],
          {},
        );
        assert.notEqual(redirectedResult.code, 0);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  test("rejects concurrent invocations and releases the guard in finally", async () => {
    const firstReady = deferred<void>();
    const releaseFirst = deferred<boolean>();
    const thirdReady = deferred<void>();
    const h = harness({
      responses: [...divergentResponses(), ...divergentResponses()],
    });

    const firstPromise = h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", async () => {
        firstReady.resolve();
        return await releaseFirst.promise;
      }),
    );

    await firstReady.promise;

    const second = await h.tool.execute(
      "call-2",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", false),
    );
    assert.partialDeepStrictEqual(second.details, {
      status: "denied",
      reason: "invocation-active",
    });

    releaseFirst.resolve(false);
    const first = await firstPromise;
    assert.partialDeepStrictEqual(first.details, {
      status: "denied",
      reason: "user-declined",
    });

    const thirdPromise = h.tool.execute(
      "call-3",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", async () => {
        thirdReady.resolve();
        return false;
      }),
    );

    await thirdReady.promise;
    const third = await thirdPromise;
    assert.partialDeepStrictEqual(third.details, {
      status: "denied",
      reason: "user-declined",
    });
    assert.equal(h.confirmCalls.length, 2);
    assert.deepEqual(pushCalls(h), []);
  });

  test("executes one exact SHA-bound force-with-lease push after approval", async () => {
    const h = harness({
      responses: [
        ...divergentResponses(),
        ...revalidationResponses(),
        ok("pushed\n"),
      ],
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", true),
    );

    assert.deepEqual(pushCalls(h), [
      {
        command: "git",
        args: [
          "-C",
          ROOT,
          "push",
          `--force-with-lease=refs/heads/topic:${SHA_REMOTE}`,
          "--",
          PUSH_TARGET,
          `${SHA_LOCAL}:refs/heads/topic`,
        ],
        options: { signal: undefined, timeout: 120_000 },
      },
    ]);
    assert.partialDeepStrictEqual(result.details, {
      status: "succeeded",
      code: 0,
      stdout: "pushed\n",
      stderr: "",
      pushArgs: [
        "-C",
        ROOT,
        "push",
        `--force-with-lease=refs/heads/topic:${SHA_REMOTE}`,
        "--",
        PUSH_TARGET,
        `${SHA_LOCAL}:refs/heads/topic`,
      ],
      state: {
        localSha: SHA_LOCAL,
        remoteSha: SHA_REMOTE,
        destination: "refs/heads/topic",
      },
    });
  });

  test("reports a killed push with code zero as failed", async () => {
    const h = harness({
      responses: [
        ...divergentResponses(),
        ...revalidationResponses(),
        { ...ok(), killed: true },
      ],
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", true),
    );

    assert.equal(pushCalls(h).length, 1);
    assert.partialDeepStrictEqual(result.details, {
      status: "failed",
      code: 0,
      killed: true,
    });
    assert.match(result.content[0].text, /interrupted or timed out/);
  });

  test("keeps returned push arguments sanitized when the configured push URL has credentials", async () => {
    const h = harness({
      responses: [
        ...inspectionResponses({
          pushUrl: ok(`${UNSANITIZED_REMOTE_URL}\n`),
        }),
        exit(1, ""),
        exit(1, ""),
        ok("2\n"),
        ok("1\n"),
        ...revalidationResponses({
          pushUrl: ok(`${UNSANITIZED_REMOTE_URL}\n`),
        }),
        ok("pushed\n"),
      ],
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", true),
    );

    assert.partialDeepStrictEqual(result.details, {
      status: "succeeded",
      pushArgs: [
        "-C",
        ROOT,
        "push",
        `--force-with-lease=refs/heads/topic:${SHA_REMOTE}`,
        "--",
        SANITIZED_REMOTE_URL,
        `${SHA_LOCAL}:refs/heads/topic`,
      ],
    });
    expectCredentialScrubbed(JSON.stringify(result.details));
  });

  test("reports Git push failures unchanged and does not retry", async () => {
    const h = harness({
      responses: [
        ...divergentResponses(),
        ...revalidationResponses(),
        exit(1, "stale info\n", "fetch first\n"),
      ],
    });

    const result = await h.tool.execute(
      "call-1",
      { reason: "rewrite feature history" },
      undefined,
      undefined,
      h.ctx("tui", true),
    );

    assert.equal(pushCalls(h).length, 1);
    assert.partialDeepStrictEqual(result.details, {
      status: "failed",
      code: 1,
      stdout: "fetch first\n",
      stderr: "stale info\n",
      state: {
        localSha: SHA_LOCAL,
        remoteSha: SHA_REMOTE,
        destination: "refs/heads/topic",
      },
    });
    assert.ok(result.content[0].text.includes("stale info"));
  });

  test("rejects ancestry failures with a diagnostic instead of classifying the update", async () => {
    const h = harness({
      responses: [...inspectionResponses(), exit(128, "merge-base exploded")],
    });

    try {
      await h.tool.execute(
        "call-1",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx(),
      );
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(
        message.includes("check whether remote commit is ancestor failed"),
      );
      assert.ok(message.includes("merge-base exploded"));
    }

    expectNoPushAndNoConfirm(h);
  });

  test("rejects malformed commit counts", async () => {
    const h = harness({
      responses: [...inspectionResponses(), ok(), ok("nope\n")],
    });

    try {
      await h.tool.execute(
        "call-1",
        { reason: "rewrite feature history" },
        undefined,
        undefined,
        h.ctx(),
      );
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(message.includes("count added commits failed"));
      assert.ok(message.includes("expected non-negative integer"));
    }

    expectNoPushAndNoConfirm(h);
  });

  test(
    "enforces the explicit lease against a local bare remote",
    { timeout: 20_000 },
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), "pi-force-push-"));

      try {
        const remote = join(tempRoot, "remote.git");
        const agent = join(tempRoot, "agent");
        const competitor = join(tempRoot, "competitor");

        await git(tempRoot, ["init", "--bare", remote]);
        await git(tempRoot, ["clone", remote, agent]);
        await configureIdentity(agent);
        await git(agent, ["checkout", "-b", "main"]);
        await commitFile(agent, "history.txt", "main\n", "seed main");
        await git(agent, ["push", "-u", "origin", "main"]);
        await git(tempRoot, [
          "--git-dir",
          remote,
          "symbolic-ref",
          "HEAD",
          "refs/heads/main",
        ]);
        await git(agent, ["checkout", "-b", "topic"]);
        await commitFile(agent, "history.txt", "topic 1\n", "seed topic");
        await git(agent, ["push", "-u", "origin", "topic"]);
        await git(tempRoot, ["clone", remote, competitor]);
        await configureIdentity(competitor);
        await git(competitor, ["checkout", "-b", "topic", "origin/topic"]);

        const h = harness({
          // pi.exec inherits the session cwd; keep this fixture isolated when the command itself uses git -C.
          execImpl: async (command, args, options) =>
            await execResult(command, args, {
              cwd: options?.cwd ?? agent,
              signal: options?.signal,
            }),
        });

        const approvedSha = await commitFile(
          agent,
          "history.txt",
          "topic 2\n",
          "agent rewrite 1",
        );
        const first = await h.tool.execute(
          "call-1",
          { reason: "rewrite feature history" },
          undefined,
          undefined,
          {
            cwd: agent,
            mode: "tui",
            ui: { confirm: async () => true },
          },
        );

        assert.partialDeepStrictEqual(first.details, {
          status: "succeeded",
          state: { localSha: approvedSha, destination: "refs/heads/topic" },
        });
        assert.equal(
          await git(tempRoot, [
            "--git-dir",
            remote,
            "rev-parse",
            "refs/heads/topic",
          ]),
          approvedSha,
        );

        const staleAgentSha = await commitFile(
          agent,
          "history.txt",
          "topic 3\n",
          "agent rewrite 2",
        );
        let competitorSha = "";
        const second = await h.tool.execute(
          "call-2",
          { reason: "rewrite feature history" },
          undefined,
          undefined,
          {
            cwd: agent,
            mode: "tui",
            ui: {
              confirm: async () => {
                await git(competitor, ["fetch", "origin", "topic"]);
                await git(competitor, ["reset", "--hard", "origin/topic"]);
                competitorSha = await commitFile(
                  competitor,
                  "history.txt",
                  "competitor\n",
                  "competitor rewrite",
                );
                await git(competitor, ["push", "origin", "topic"]);
                return true;
              },
            },
          },
        );

        assert.partialDeepStrictEqual(second.details, {
          status: "failed",
          state: { localSha: staleAgentSha, destination: "refs/heads/topic" },
        });
        assert.match(
          `${second.details.stderr}${second.details.stdout}`,
          /stale info|fetch first/i,
        );
        assert.equal(
          await git(tempRoot, [
            "--git-dir",
            remote,
            "rev-parse",
            "refs/heads/topic",
          ]),
          competitorSha,
        );
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
