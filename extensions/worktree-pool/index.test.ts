import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/expect.js";
import { resolve } from "node:path";

import {
  createWorktreePoolExtension,
  poolGitArguments,
  type WorktreePoolRuntime,
} from "./index.js";
import type { OwnerIdentity } from "./operation-lock.js";
import type {
  AcquireRequest,
  AcquireResult,
  PoolListing,
  ReleaseResult,
  RepairReport,
} from "./pool.js";
import type { ResolvedRepository } from "./types.js";

const CONFIG_PATH =
  "/tmp/test-home/.pi/agent/extensions/worktree-pool/config.json";
const POOLED_PATH =
  "/tmp/test-home/dd/.worktree-pools/demo/worktree-22222222-2222-4222-8222-222222222222";
const CLAIM_ID = "11111111-1111-4111-8111-111111111111";
const ACQUIRED_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Context = { cwd: string; sessionManager: { getSessionId(): string } };
type Handler = (event: any, ctx: Context) => unknown;
type Tool = {
  parameters: unknown;
  prepareArguments?(args: unknown): unknown;
  execute(
    id: string,
    params: any,
    signal: unknown,
    update: unknown,
    ctx: Context,
  ): Promise<any>;
};

test("every internal pool Git command bypasses fsmonitor", () => {
  expect(poolGitArguments("/repo", ["switch", "-c", "topic", "HEAD"])).toEqual([
    "-C",
    "/repo",
    "-c",
    "core.fsmonitor=false",
    "switch",
    "-c",
    "topic",
    "HEAD",
  ]);
});

class FakePool {
  calls: Array<{ name: string; args: unknown[] }> = [];

  async list(repository?: string): Promise<PoolListing> {
    this.calls.push({ name: "list", args: [repository] });
    return {
      repositories: [
        { name: repository ?? "demo", capacity: 3, used: 0, worktrees: [] },
      ],
    };
  }

  async acquire(
    request: AcquireRequest,
    owner: OwnerIdentity,
    identity?: { claimId: string; pathId: string },
  ): Promise<AcquireResult> {
    this.calls.push({
      name: "acquire",
      args:
        identity === undefined ? [request, owner] : [request, owner, identity],
    });
    return {
      claimId: CLAIM_ID,
      path: POOLED_PATH,
      branch: request.branch,
      reused: false,
      head: ACQUIRED_HEAD,
      startPoint: "origin/main",
      startPointHead: ACQUIRED_HEAD,
      startPointFetched: true,
      relationship: "equal",
    };
  }

  async release(
    repository: string,
    claimId: string,
    owner: OwnerIdentity,
  ): Promise<ReleaseResult> {
    this.calls.push({ name: "release", args: [repository, claimId, owner] });
    return { path: POOLED_PATH, released: true };
  }

  async repair(
    repository: string,
    slot: string,
    owner: OwnerIdentity,
  ): Promise<RepairReport> {
    this.calls.push({ name: "repair", args: [repository, slot, owner] });
    return {
      claimId: CLAIM_ID,
      path: POOLED_PATH,
      repaired: false,
      state: "claimed",
      evidence: {
        pathExists: true,
        registered: true,
        nativeClaimMatches: true,
      },
    };
  }
}

const repository: ResolvedRepository = {
  name: "demo",
  path: "/tmp/test-home/dd/demo",
  canonicalPath: "/tmp/test-home/dd/demo",
  commonDir: "/tmp/test-home/dd/demo/.git",
  poolRoot: "/tmp/test-home/dd/.worktree-pools",
  poolDir: "/tmp/test-home/dd/.worktree-pools/demo",
  capacity: 3,
  defaultStartPoint: "origin/main",
};

const originalDepth = process.env.PI_SUBAGENT_DEPTH;
beforeEach(() => {
  process.env.PI_SUBAGENT_DEPTH = "0";
});
afterAll(() => {
  if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
  else process.env.PI_SUBAGENT_DEPTH = originalDepth;
});

function harness(options: { runtimeError?: Error } = {}) {
  const pool = new FakePool();
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Array<(event: any) => unknown>>();
  const tools = new Map<string, Tool>();
  const commands: string[] = [];
  const statuses: unknown[] = [];
  let runtimeLoads = 0;
  const runtimeRequests: string[][] = [];
  const runtimePurposes: Array<"identity" | "acquire" | undefined> = [];
  const ctx: Context = {
    cwd: repository.path,
    sessionManager: { getSessionId: () => "session-a" },
  };

  createWorktreePoolExtension({
    configPath: CONFIG_PATH,
    now: () => 1_700_000_000_000,
    pid: 4242,
    hostname: "test-host",
    async loadRuntime(
      repositoryIdentifiers: string[],
      purpose: "identity" | "acquire" | undefined,
    ): Promise<WorktreePoolRuntime> {
      runtimeLoads += 1;
      runtimeRequests.push(repositoryIdentifiers);
      runtimePurposes.push(purpose);
      if (options.runtimeError) throw options.runtimeError;
      return {
        root: repository.poolRoot,
        pool: pool as never,
        repositories: [repository],
      };
    },
    realpath: async (path: string) => resolve(path),
  } as never)({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: (event: any) => unknown) {
        busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
      },
    },
    registerTool(tool: Tool & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerStatus(value: unknown) {
      statuses.push(value);
    },
  } as never);

  return {
    pool,
    handlers,
    busHandlers,
    tools,
    commands,
    statuses,
    ctx,
    get runtimeLoads() {
      return runtimeLoads;
    },
    get runtimeRequests() {
      return runtimeRequests;
    },
    get runtimePurposes() {
      return runtimePurposes;
    },
    async emit(name: string, event: any) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? [])
        result = await handler(event, ctx);
      return result;
    },
    async call(params: any) {
      const { action, ...input } = params;
      const tool = tools.get(`worktree_${action}`)!;
      const prepared = tool.prepareArguments?.(input) ?? input;
      return await tool.execute(
        "pool-call",
        prepared,
        undefined,
        undefined,
        ctx,
      );
    },
  };
}

async function acquire(h: ReturnType<typeof harness>) {
  return await h.call({
    action: "acquire",
    repository: "demo",
    branch: "topic",
  });
}

describe("worktree tools", () => {
  test("registers action-specific tools and only the Bash command guard", () => {
    const h = harness();
    expect([...h.tools.keys()]).toEqual([
      "worktree_list",
      "worktree_acquire",
      "worktree_release",
      "worktree_repair",
    ]);
    expect(h.commands).toEqual([]);
    expect(h.statuses).toEqual([]);
    expect(h.handlers.get("session_start") ?? []).toHaveLength(0);
    expect(h.handlers.get("session_shutdown") ?? []).toHaveLength(0);
    expect(h.handlers.get("tool_result") ?? []).toHaveLength(0);
    expect(
      h.busHandlers.get("subagent:foreground-complete") ?? [],
    ).toHaveLength(0);
    expect(h.handlers.get("tool_call") ?? []).toHaveLength(1);
    expect(h.runtimeLoads).toBe(0);
  });

  test("schemas expose only valid inputs and require operation identities", () => {
    const h = harness();
    for (const [action, fields, required] of [
      ["list", ["repository"], []],
      [
        "acquire",
        ["repository", "branch", "startPoint"],
        ["repository", "branch"],
      ],
      [
        "release",
        ["repository", "claimId", "force"],
        ["repository", "claimId"],
      ],
      ["repair", ["repository", "slot"], ["repository", "slot"]],
    ] as const) {
      const schema = h.tools.get(`worktree_${action}`)!.parameters as any;
      expect(Object.keys(schema.properties)).toEqual([...fields]);
      expect(schema.required).toEqual([...required]);
      expect(schema.additionalProperties).toBe(false);
      for (const field of required)
        expect(schema.properties[field].minLength).toBe(1);
    }
  });

  test("rejects foreign fields with correction guidance before loading the runtime", async () => {
    const h = harness();
    await expect(
      h.call({
        action: "release",
        repository: "demo",
        claimId: CLAIM_ID,
        branch: "topic",
      }),
    ).rejects.toThrow(
      "worktree_release does not accept branch. Allowed inputs: repository, claimId, force",
    );
    await expect(
      h.call({ action: "release", claimId: CLAIM_ID }),
    ).rejects.toThrow("worktree_release.repository must be a non-empty string");
    expect(h.runtimeLoads).toBe(0);
  });

  test("force is a boolean opt-in for release only", async () => {
    const h = harness();
    for (const force of ["true", 1, null]) {
      await expect(
        h.call({
          action: "release",
          repository: "demo",
          claimId: CLAIM_ID,
          force,
        }),
      ).rejects.toThrow("release.force");
    }
    await expect(h.call({ action: "list", force: true })).rejects.toThrow(
      "does not accept force",
    );
    expect(h.runtimeLoads).toBe(0);
  });

  test("does not expose stable identity inputs through raw acquire", async () => {
    const h = harness();
    const parameters = h.tools.get("worktree_acquire")!.parameters as {
      properties: Record<string, unknown>;
    };
    expect(parameters.properties).not.toHaveProperty("pathId");
    expect(parameters.properties).not.toHaveProperty("__piTaskLifecycle");
    await expect(
      h.call({
        action: "acquire",
        repository: "demo",
        branch: "topic",
        claimId: CLAIM_ID,
      }),
    ).rejects.toThrow("does not accept claimId");
  });

  test("uses pool-generated acquire identities", async () => {
    const h = harness();

    await acquire(h);

    expect(h.pool.calls[0].args).toHaveLength(2);
  });

  test("allows pool actions from child depth", async () => {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const h = harness();
    await expect(acquire(h)).resolves.toMatchObject({
      details: { action: "acquire" },
    });
    expect(h.runtimeLoads).toBe(1);
  });

  test("loads configuration at call time and preserves errors", async () => {
    const error = new Error(
      `${CONFIG_PATH} invalid repositories[0].capacity (6): must be an integer between 3 and 5`,
    );
    const h = harness({ runtimeError: error });
    await expect(
      h.call({ action: "list", repository: "demo" }),
    ).rejects.toThrow(error.message);
    expect(h.runtimeLoads).toBe(1);
  });

  test("lists every configured repository when repository is omitted", async () => {
    const h = harness();
    const response = await h.call({ action: "list" });
    expect(response.details).toMatchObject({
      action: "list",
      repositories: [{ name: "demo" }],
    });
    expect(h.runtimeRequests).toEqual([[]]);
    expect(h.pool.calls[0]).toEqual({ name: "list", args: [undefined] });
  });

  test("accepts an empty repository placeholder when listing all pools", async () => {
    const h = harness();
    await h.call({ action: "list", repository: "" });
    expect(h.runtimeRequests).toEqual([[]]);
    expect(h.pool.calls[0]).toEqual({ name: "list", args: [undefined] });
  });

  test("lists actionable identities, ownership, capacity and blocker reasons in model-facing text", async () => {
    const h = harness();
    h.pool.list = async () => ({
      repositories: [
        {
          name: "demo",
          capacity: 3,
          used: 1,
          worktrees: [
            {
              claimId: CLAIM_ID,
              path: POOLED_PATH,
              branch: "topic",
              currentBranch: "topic",
              head: ACQUIRED_HEAD,
              clean: false,
              branchProtectsHead: true,
              state: "needs-attention",
              reason: "worktree is dirty",
              owner: {
                sessionId: "session-a",
                host: "test-host",
                pid: 4242,
                started: 1700000000000,
              },
              evidence: {
                pathExists: true,
                registered: true,
                nativeClaimMatches: true,
              },
            },
          ],
        },
      ],
    });
    const result = await h.call({ action: "list", repository: "demo" });
    for (const value of [
      CLAIM_ID,
      POOLED_PATH,
      "session-a",
      "test-host",
      "4242",
      "topic",
      "needs-attention",
      "worktree is dirty",
      "1/3",
    ])
      expect(result.content[0].text).toContain(value);
  });

  test("returns readable acquire text and structured fields", async () => {
    const h = harness();
    const result = await acquire(h);
    expect(result.content[0].text).toContain(POOLED_PATH);
    expect(result.content[0].text).toContain(`HEAD ${ACQUIRED_HEAD}`);
    expect(result.content[0].text).toContain(
      `worktree_release(${JSON.stringify({ repository: "demo", claimId: CLAIM_ID })})`,
    );
    expect(result.details).toMatchObject({
      action: "acquire",
      claimId: CLAIM_ID,
      path: POOLED_PATH,
      branch: "topic",
      reused: false,
      head: ACQUIRED_HEAD,
      startPoint: "origin/main",
      startPointHead: ACQUIRED_HEAD,
      startPointFetched: true,
      relationship: "equal",
    });
    expect(h.pool.calls[0]).toMatchObject({
      name: "acquire",
      args: [
        { repository: "demo", branch: "topic" },
        {
          pid: 4242,
          sessionId: "session-a",
          host: "test-host",
          started: 1_700_000_000_000,
        },
      ],
    });
  });

  test("treats an empty optional start point as omitted", async () => {
    const h = harness();
    await h.call({
      action: "acquire",
      repository: "demo",
      branch: "topic",
      startPoint: "",
    });
    expect(h.pool.calls[0]?.args[0]).toEqual({
      repository: "demo",
      branch: "topic",
    });
  });

  test("dispatches list, release, and repair with structured details", async () => {
    const h = harness();
    expect(
      (await h.call({ action: "list", repository: "demo" })).details.action,
    ).toBe("list");
    expect(
      (
        await h.call({
          action: "release",
          repository: "demo",
          claimId: CLAIM_ID,
        })
      ).details,
    ).toMatchObject({ action: "release", released: true });
    expect(
      (
        await h.call({
          action: "repair",
          repository: "demo",
          slot: POOLED_PATH,
        })
      ).details,
    ).toMatchObject({ action: "repair", state: "claimed" });
    expect(h.runtimeRequests).toEqual([["demo"], ["demo"], ["demo"]]);
    expect(h.runtimePurposes).toEqual(["identity", "identity", "identity"]);
  });

  test("does not inspect or block subagent execution", async () => {
    const h = harness();
    await acquire(h);
    for (const input of [
      { agent: "worker", cwd: POOLED_PATH, async: true },
      {
        workflowScript:
          "return await runs.run('x', { agent: 'worker', task: 'x' });",
        async: true,
      },
      { workflow: "review", args: { task: "review" } },
    ]) {
      expect(
        await h.emit("tool_call", {
          toolName: "subagent",
          toolCallId: "child",
          input,
        }),
      ).toBeUndefined();
    }
  });

  test("hooks cooperative Bash guidance for parent and child", async () => {
    const h = harness();
    process.env.PI_SUBAGENT_DEPTH = "0";
    expect(
      await h.emit("tool_call", {
        toolName: "bash",
        input: { command: "git worktree add target HEAD" },
      }),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("Use worktree_acquire"),
    });
    process.env.PI_SUBAGENT_DEPTH = "2";
    expect(
      await h.emit("tool_call", {
        toolName: "bash",
        input: { command: "git worktree remove target" },
      }),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("Ask the parent"),
    });
  });

  test("allows checkout, switch, and read-only worktree inspection without loading configuration", async () => {
    const h = harness({
      runtimeError: new Error("configuration must not load"),
    });
    for (const command of [
      "git checkout topic",
      "git -C /tmp switch topic",
      "git worktree list --porcelain",
    ]) {
      await expect(
        h.emit("tool_call", { toolName: "bash", input: { command } }),
      ).resolves.toBeUndefined();
    }
    expect(h.runtimeLoads).toBe(0);
  });
});
