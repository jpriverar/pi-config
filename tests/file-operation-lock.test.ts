import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  withFileOperationLock,
  type FileOperationLockDependencies,
  type LockOwner,
} from "../lib/file-operation-lock.js";

const owner: LockOwner = {
  pid: 42,
  sessionId: "session-a",
  host: "test-host",
  started: 100,
};

async function withRoot<T>(
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "file-operation-lock-"));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function dependencies(
  overrides: Partial<FileOperationLockDependencies> = {},
): FileOperationLockDependencies {
  return {
    now: () => 100,
    sleep: async () => undefined,
    isPidAlive: () => "live",
    hostname: "test-host",
    timeoutMs: 1_000,
    ...overrides,
  };
}

async function seedOwner(root: string, value: unknown): Promise<void> {
  const held = join(root, "operation.lock", "held");
  await mkdir(held, { recursive: true });
  await writeFile(join(held, "owner-seeded.json"), JSON.stringify(value));
}

test("serializes operations against the same explicit lock root", async () => {
  await withRoot(async (root) => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let wakeSecond!: () => void;
    let secondRetried!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      secondRetried = resolve;
    });
    const deps = dependencies({
      sleep: async () => {
        secondRetried();
        await new Promise<void>((resolve) => {
          wakeSecond = resolve;
        });
      },
    });

    const first = withFileOperationLock(
      root,
      owner,
      async () => {
        firstEntered();
        await firstHeld;
        return "first";
      },
      deps,
    );
    await firstStarted;

    let secondEntered = false;
    const second = withFileOperationLock(
      root,
      { ...owner, pid: 43, sessionId: "session-b" },
      async () => {
        secondEntered = true;
        return "second";
      },
      deps,
    );
    await secondBlocked;
    assert.equal(secondEntered, false);

    releaseFirst();
    assert.equal(await first, "first");
    wakeSecond();
    assert.equal(await second, "second");
  });
});

test("reclaims a dead local owner", async () => {
  await withRoot(async (root) => {
    await seedOwner(root, owner);
    const value = await withFileOperationLock(
      root,
      { ...owner, pid: 43 },
      async () => "reclaimed",
      dependencies({ isPidAlive: () => "dead" }),
    );
    assert.equal(value, "reclaimed");
  });
});

test("fails closed for remote and unreadable owner records", async (t) => {
  for (const [name, value, message] of [
    ["remote", { ...owner, host: "remote-host" }, /remote-host/],
    ["unreadable", "not-an-owner", /unreadable owner metadata/],
  ] as const) {
    await t.test(name, () =>
      withRoot(async (root) => {
        await seedOwner(root, value);
        await assert.rejects(
          withFileOperationLock(
            root,
            { ...owner, pid: 43 },
            async () => undefined,
            dependencies({ timeoutMs: 0, isPidAlive: () => "dead" }),
          ),
          message,
        );
      }),
    );
  }
});
