import { describe, expect, test } from "../../tests/expect.js";
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  withOperationLock,
  type OperationLockDependencies,
  type OwnerIdentity,
} from "./operation-lock.js";
import type { ResolvedRepository } from "./types.js";

const execFileAsync = promisify(execFile);

async function withTempRepository<T>(
  fn: (repository: ResolvedRepository) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "worktree-pool-lock-"));
  const repository: ResolvedRepository = {
    name: "demo",
    path: dir,
    canonicalPath: dir,
    commonDir: join(dir, ".git"),
    poolRoot: join(dir, "pool"),
    poolDir: join(dir, "pool", "demo"),
    capacity: 3,
    defaultStartPoint: "origin/main",
  };

  try {
    return await fn(repository);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const owner: OwnerIdentity = {
  pid: 101,
  sessionId: "session-current",
  host: "local-host",
  started: 1_000,
};

function dependencies(
  overrides: Partial<OperationLockDependencies> = {},
): OperationLockDependencies {
  let now = 2_000;
  return {
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    isPidAlive: () => "live",
    hostname: "local-host",
    timeoutMs: 100,
    ...overrides,
  };
}

function lockPath(repository: ResolvedRepository): string {
  return join(repository.commonDir, "pi-worktree-pool", "operation.lock");
}

function heldPath(repository: ResolvedRepository): string {
  return join(lockPath(repository), "held");
}

async function lockOwnerPath(repository: ResolvedRepository): Promise<string> {
  const entries = await readdir(heldPath(repository));
  expect(entries).toHaveLength(1);
  return join(heldPath(repository), entries[0]);
}

async function readLock(repository: ResolvedRepository): Promise<string> {
  return await readFile(await lockOwnerPath(repository), "utf8");
}

async function seedLock(
  repository: ResolvedRepository,
  contents: string,
  token = "seed",
): Promise<void> {
  await mkdir(heldPath(repository), { recursive: true });
  await writeFile(join(heldPath(repository), `owner-${token}.json`), contents, {
    flag: "wx",
  });
}

function replaceLockSync(
  repository: ResolvedRepository,
  recordedOwner: OwnerIdentity,
  token: string,
): void {
  rmSync(heldPath(repository), { recursive: true, force: true });
  mkdirSync(heldPath(repository));
  writeFileSync(
    join(heldPath(repository), `owner-${token}.json`),
    JSON.stringify(recordedOwner),
    { flag: "wx" },
  );
}

describe("withOperationLock", () => {
  test("acquires exclusively, propagates the callback value, and cleans up", async () => {
    await withTempRepository(async (repository) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const first = withOperationLock(
        repository,
        owner,
        async () => {
          markEntered();
          await held;
          return "first-result";
        },
        dependencies(),
      );

      await entered;
      expect(JSON.parse(await readLock(repository))).toEqual(owner);

      let secondCalled = false;
      await expect(
        withOperationLock(
          repository,
          { ...owner, pid: 202 },
          async () => {
            secondCalled = true;
          },
          dependencies({ timeoutMs: 0 }),
        ),
      ).rejects.toThrow("timed out acquiring operation lock");
      expect(secondCalled).toBe(false);

      release();
      expect(await first).toBe("first-result");
      await expect(readdir(heldPath(repository))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(lockPath(repository))).toEqual([]);
    });
  });

  test("does not remove a replacement lock it did not acquire", async () => {
    await withTempRepository(async (repository) => {
      const replacement = { ...owner, pid: 909, sessionId: "replacement" };
      await withOperationLock(
        repository,
        owner,
        async () => {
          replaceLockSync(repository, replacement, "replacement");
        },
        dependencies(),
      );

      expect(await readLock(repository)).toBe(JSON.stringify(replacement));
    });
  });

  test("cleans up its lock and propagates callback failure", async () => {
    await withTempRepository(async (repository) => {
      const failure = new Error("callback failed");
      await expect(
        withOperationLock(
          repository,
          owner,
          async () => {
            throw failure;
          },
          dependencies(),
        ),
      ).rejects.toBe(failure);
      await expect(readdir(heldPath(repository))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(lockPath(repository))).toEqual([]);
    });
  });

  test("bounds retries by the configured timeout and reports readable owner details", async () => {
    await withTempRepository(async (repository) => {
      const recorded = { ...owner, pid: 303, started: 1_500 };
      await seedLock(repository, JSON.stringify(recorded));
      let sleeps = 0;
      const deps = dependencies({
        sleep: async () => {
          sleeps += 1;
        },
        timeoutMs: 0,
      });

      const error = await withOperationLock(
        repository,
        owner,
        async () => undefined,
        deps,
      ).catch((value) => value);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(lockPath(repository));
      expect(error.message).toContain("host local-host");
      expect(error.message).toContain("PID 303");
      expect(error.message).toContain("age 500ms");
      expect(sleeps).toBe(0);
      expect(JSON.parse(await readLock(repository))).toEqual(recorded);
    });
  });

  test.each([
    [
      "valid live metadata",
      JSON.stringify({ ...owner, pid: 310 }),
      "live" as const,
      50,
    ],
    [
      "valid dead metadata",
      JSON.stringify({ ...owner, pid: 311 }),
      "dead" as const,
      0,
    ],
    ["malformed metadata", "not-json", "dead" as const, 0],
  ])(
    "fails closed with bounded diagnostics for a regular-file lock: %s",
    async (_label, contents, liveness, timeoutMs) => {
      await withTempRepository(async (repository) => {
        await mkdir(join(repository.commonDir, "pi-worktree-pool"), {
          recursive: true,
        });
        await writeFile(lockPath(repository), contents, { flag: "wx" });
        let checked = false;
        let now = 2_000;
        let sleeps = 0;
        const deps: OperationLockDependencies = {
          now: () => now,
          sleep: async (milliseconds) => {
            sleeps += 1;
            now += milliseconds;
          },
          isPidAlive: () => {
            checked = true;
            return liveness;
          },
          hostname: "local-host",
          timeoutMs,
        };

        const error = await withOperationLock(
          repository,
          owner,
          async () => undefined,
          deps,
        ).catch((value) => value);

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain(lockPath(repository));
        expect(error.message).toContain(
          "external or ambiguous lock representation",
        );
        expect(checked).toBe(false);
        expect(now).toBe(2_000 + timeoutMs);
        expect(sleeps).toBe(timeoutMs / 25);
        expect(await readFile(lockPath(repository), "utf8")).toBe(contents);
      });
    },
  );

  test("bounds repeated stable-container replacement between retries", async () => {
    await withTempRepository(async (repository) => {
      await mkdir(join(repository.commonDir, "pi-worktree-pool"), {
        recursive: true,
      });
      await writeFile(lockPath(repository), "external-0");
      let now = 0;
      let sleeps = 0;
      let replacements = 0;
      let called = false;
      const deps: OperationLockDependencies = {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps += 1;
          now += milliseconds;
          replacements += 1;
          await rm(lockPath(repository));
          await writeFile(lockPath(repository), `external-${replacements}`);
        },
        isPidAlive: () => "dead",
        hostname: "local-host",
        timeoutMs: 75,
      };

      await expect(
        withOperationLock(
          repository,
          owner,
          async () => {
            called = true;
          },
          deps,
        ),
      ).rejects.toThrow("timed out acquiring operation lock");
      expect(now).toBe(75);
      expect(sleeps).toBe(3);
      expect(replacements).toBe(3);
      expect(called).toBe(false);
      expect(await readFile(lockPath(repository), "utf8")).toBe("external-3");
    });
  });

  test.each([
    "empty held directory",
    "symlink owner entry",
    "FIFO owner entry",
    "oversized owner entry",
    "nested owner directory",
  ])(
    "preserves malformed held shape with a bounded timeout: %s",
    async (shape) => {
      await withTempRepository(async (repository) => {
        await mkdir(heldPath(repository), { recursive: true });
        const ownerEntryPath = join(
          heldPath(repository),
          `owner-${shape.replaceAll(" ", "-")}.json`,
        );
        const targetPath = join(repository.path, "external-owner.json");

        if (shape === "symlink owner entry") {
          await writeFile(targetPath, JSON.stringify({ ...owner, pid: 330 }));
          await symlink(targetPath, ownerEntryPath);
        } else if (shape === "FIFO owner entry") {
          await execFileAsync("mkfifo", [ownerEntryPath]);
        } else if (shape === "oversized owner entry") {
          await writeFile(ownerEntryPath, "x".repeat(16 * 1024 + 1));
        } else if (shape === "nested owner directory") {
          await mkdir(ownerEntryPath);
          await writeFile(
            join(ownerEntryPath, "nested.json"),
            JSON.stringify({ ...owner, pid: 331 }),
          );
        }

        const entriesBefore = await readdir(heldPath(repository));
        const heldBefore = await lstat(heldPath(repository));
        let now = 2_000;
        let sleeps = 0;
        let checked = false;
        let called = false;
        const deps: OperationLockDependencies = {
          now: () => now,
          sleep: async (milliseconds) => {
            sleeps += 1;
            now += milliseconds;
          },
          isPidAlive: () => {
            checked = true;
            return "dead";
          },
          hostname: "local-host",
          timeoutMs: 50,
        };

        const error = await withOperationLock(
          repository,
          owner,
          async () => {
            called = true;
          },
          deps,
        ).catch((value) => value);

        expect(error.message).toContain("unreadable owner metadata");
        expect(now).toBe(2_050);
        expect(sleeps).toBe(2);
        expect(checked).toBe(false);
        expect(called).toBe(false);
        expect(await readdir(heldPath(repository))).toEqual(entriesBefore);
        const heldAfter = await lstat(heldPath(repository));
        expect({ dev: heldAfter.dev, ino: heldAfter.ino }).toEqual({
          dev: heldBefore.dev,
          ino: heldBefore.ino,
        });
        if (shape === "symlink owner entry") {
          expect((await lstat(ownerEntryPath)).isSymbolicLink()).toBe(true);
        } else if (shape === "FIFO owner entry") {
          expect((await lstat(ownerEntryPath)).isFIFO()).toBe(true);
        } else if (shape === "oversized owner entry") {
          expect((await lstat(ownerEntryPath)).size).toBe(16 * 1024 + 1);
        } else if (shape === "nested owner directory") {
          expect((await lstat(ownerEntryPath)).isDirectory()).toBe(true);
          expect(await readdir(ownerEntryPath)).toEqual(["nested.json"]);
        }
      });
    },
  );

  test("accepts regular owner metadata at the exact size bound", async () => {
    await withTempRepository(async (repository) => {
      const recorded = { ...owner, pid: 380 };
      const json = JSON.stringify(recorded);
      const contents = `${json}${" ".repeat(16 * 1024 - json.length)}`;
      await seedLock(repository, contents);
      let checked = false;

      const error = await withOperationLock(
        repository,
        owner,
        async () => undefined,
        dependencies({
          isPidAlive: () => {
            checked = true;
            return "live";
          },
          timeoutMs: 0,
        }),
      ).catch((value) => value);
      expect(error.message).toContain("PID 380");
      expect(checked).toBe(true);
      expect((await lstat(await lockOwnerPath(repository))).size).toBe(
        16 * 1024,
      );
    });
  });

  test("serializes owner metadata before creating held", async () => {
    await withTempRepository(async (repository) => {
      const invalidOwner = { ...owner, started: 1n as unknown as number };
      await expect(
        withOperationLock(
          repository,
          invalidOwner,
          async () => undefined,
          dependencies(),
        ),
      ).rejects.toBeInstanceOf(TypeError);

      await expect(lstat(heldPath(repository))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(lockPath(repository))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  test("reclaims a valid lock owned by an unambiguously dead local PID", async () => {
    await withTempRepository(async (repository) => {
      const recorded = { ...owner, pid: 404, sessionId: "old" };
      await seedLock(repository, JSON.stringify(recorded));
      const checked: number[] = [];

      expect(
        await withOperationLock(
          repository,
          owner,
          async () => "reclaimed",
          dependencies({
            isPidAlive: (pid) => {
              checked.push(pid);
              return "dead";
            },
          }),
        ),
      ).toBe("reclaimed");
      expect(checked).toEqual([404]);
    });
  });

  test("preserves a replacement installed after stale ownership is verified", async () => {
    await withTempRepository(async (repository) => {
      const stale = { ...owner, pid: 410, sessionId: "stale" };
      const replacement = { ...owner, pid: 411, sessionId: "replacement" };
      await seedLock(repository, JSON.stringify(stale), "stale");
      let replaced = false;

      await expect(
        withOperationLock(
          repository,
          owner,
          async () => undefined,
          dependencies({
            isPidAlive: () => {
              replaceLockSync(repository, replacement, "replacement");
              replaced = true;
              return "dead";
            },
            timeoutMs: 0,
          }),
        ),
      ).rejects.toThrow("timed out acquiring operation lock");

      expect(replaced).toBe(true);
      expect(await readLock(repository)).toBe(JSON.stringify(replacement));
    });
  });

  test("bounds repeated ownership churn by the configured deadline", async () => {
    await withTempRepository(async (repository) => {
      await seedLock(
        repository,
        JSON.stringify({ ...owner, pid: 420, started: 0 }),
        "churn-0",
      );
      let now = 0;
      let checks = 0;
      const deps: OperationLockDependencies = {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        isPidAlive: () => {
          checks += 1;
          replaceLockSync(
            repository,
            {
              ...owner,
              pid: 420 + checks,
              sessionId: `churn-${checks}`,
              started: 0,
            },
            `churn-${checks}`,
          );
          return "dead";
        },
        hostname: "local-host",
        timeoutMs: 75,
      };

      await expect(
        withOperationLock(repository, owner, async () => undefined, deps),
      ).rejects.toThrow("timed out acquiring operation lock");
      expect(now).toBe(75);
      expect(checks).toBe(4);
    });
  });

  test.each([
    ["live local PID", JSON.stringify({ ...owner, pid: 505 }), "live" as const],
    [
      "ambiguous local PID",
      JSON.stringify({ ...owner, pid: 506 }),
      "ambiguous" as const,
    ],
    [
      "reused PID reported live",
      JSON.stringify({ ...owner, pid: 101, sessionId: "old", started: 10 }),
      "live" as const,
    ],
  ])("preserves a lock for a %s", async (_label, contents, liveness) => {
    await withTempRepository(async (repository) => {
      await seedLock(repository, contents);
      await expect(
        withOperationLock(
          repository,
          owner,
          async () => undefined,
          dependencies({
            isPidAlive: () => liveness,
            timeoutMs: 0,
          }),
        ),
      ).rejects.toThrow("timed out acquiring operation lock");
      expect(await readLock(repository)).toBe(contents);
    });
  });

  test("refuses to reclaim a valid foreign-host lock without checking its PID", async () => {
    await withTempRepository(async (repository) => {
      const contents = JSON.stringify({
        ...owner,
        pid: 606,
        host: "remote-host",
      });
      await seedLock(repository, contents);
      let checked = false;

      await expect(
        withOperationLock(
          repository,
          owner,
          async () => undefined,
          dependencies({
            isPidAlive: () => {
              checked = true;
              return "dead";
            },
            timeoutMs: 0,
          }),
        ),
      ).rejects.toThrow("host remote-host");
      expect(checked).toBe(false);
      expect(await readLock(repository)).toBe(contents);
    });
  });

  test.each([
    ["invalid JSON", "not-json"],
    ["missing fields", JSON.stringify({ pid: 707, host: "local-host" })],
    ["invalid PID", JSON.stringify({ ...owner, pid: -1 })],
  ])("refuses to reclaim malformed metadata: %s", async (_label, contents) => {
    await withTempRepository(async (repository) => {
      await seedLock(repository, contents);
      let checked = false;

      const error = await withOperationLock(
        repository,
        owner,
        async () => undefined,
        dependencies({
          isPidAlive: () => {
            checked = true;
            return "dead";
          },
          timeoutMs: 0,
        }),
      ).catch((value) => value);
      expect(error.message).toContain(lockPath(repository));
      expect(error.message).toContain("unreadable owner metadata");
      expect(checked).toBe(false);
      expect(await readLock(repository)).toBe(contents);
    });
  });
});
