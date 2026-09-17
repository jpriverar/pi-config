import { describe, expect, test } from "../../tests/expect.js";

import type { LoadedPoolConfig, ResolvedRepository } from "./types.js";
import {
  currentOwner,
  loadWorktreePoolRuntime,
  type WorktreePoolRuntimeDependencies,
} from "./runtime.js";

const config: LoadedPoolConfig = {
  root: "/tmp/pools",
  canonicalRoot: "/tmp/pools",
  repositoryRoot: "/tmp/repos",
  canonicalRepositoryRoot: "/tmp/repos",
  defaultCapacity: 3,
  exclude: [],
  overrides: new Map(),
};

const repository: ResolvedRepository = {
  name: "demo",
  path: "/tmp/repos/demo",
  canonicalPath: "/tmp/repos/demo",
  commonDir: "/tmp/repos/demo/.git",
  poolRoot: "/tmp/pools",
  poolDir: "/tmp/pools/demo",
  capacity: 3,
  defaultStartPoint: "origin/main",
};

function dependencies(): WorktreePoolRuntimeDependencies {
  return {
    configPath: "/tmp/config.json",
    home: "/tmp/home",
    runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
    realpath: async (path) => path,
    operationLock: {
      now: () => 1,
      sleep: async () => undefined,
      isPidAlive: () => "dead",
      hostname: "test-host",
      timeoutMs: 5,
    },
    uuid: () => "123e4567-e89b-42d3-a456-426614174000",
    loadConfig: async () => config,
    resolveRepository: async (_config, identifier, purpose) => ({
      ...repository,
      name: `${identifier}:${purpose}`,
    }),
  };
}

describe("worktree pool runtime", () => {
  test("loads one runtime and resolves unique repository identities", async () => {
    const runtime = await loadWorktreePoolRuntime(
      ["demo", "demo"],
      "identity",
      dependencies(),
    );

    expect(runtime.root).toBe(config.root);
    expect(runtime.repositories.map((item) => item.name)).toEqual([
      "demo:identity",
    ]);
    expect(await runtime.pool.list()).toMatchObject({
      repositories: [{ name: "demo:identity", capacity: 3 }],
    });
  });

  test("builds current owner identity from explicit process inputs", () => {
    expect(
      currentOwner("session-a", {
        pid: 42,
        hostname: "test-host",
        now: () => 1_700_000_000_000,
      }),
    ).toEqual({
      pid: 42,
      sessionId: "session-a",
      host: "test-host",
      started: 1_700_000_000_000,
    });
  });
});
