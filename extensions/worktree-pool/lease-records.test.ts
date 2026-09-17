import { describe, expect, test } from "../../tests/expect.js";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLeaseRecord,
  listLeaseRecords,
  listSessionLeaseRecords,
  removeLeaseRecord,
  replaceLeaseRecord,
  type LeaseRecord,
} from "./lease-records.js";

const CLAIM = "123e4567-e89b-42d3-a456-426614174000";
const NEXT_CLAIM = "223e4567-e89b-42d3-a456-426614174001";
const PATH_ID = "323e4567-e89b-42d3-a456-426614174002";

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pool-leases-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(
  root: string,
  overrides: Partial<LeaseRecord> = {},
): LeaseRecord {
  return {
    version: 1,
    claimId: CLAIM,
    pathId: PATH_ID,
    repository: "team/repo",
    repositoryCommonDir: "/tmp/repos/team/repo/.git",
    path: join(root, "team/repo", `worktree-${PATH_ID}`),
    branch: "jpriverar/change",
    sessionId: "session-1",
    host: "host-1",
    pid: 1234,
    started: 1_788_123_456_000,
    state: "creating",
    ...overrides,
  };
}

function recordPath(root: string): string {
  return join(root, ".leases", `${PATH_ID}.json`);
}

describe("lease discovery records", () => {
  test("creates, lists, replaces, filters, and removes exact records", async () =>
    withRoot(async (root) => {
      await createLeaseRecord(root, record(root));
      expect(await listLeaseRecords(root)).toEqual([
        { path: recordPath(root), state: "valid", record: record(root) },
      ]);
      expect(
        await listSessionLeaseRecords(root, "host-1", "session-1"),
      ).toHaveLength(1);
      expect(
        await listSessionLeaseRecords(root, "host-2", "session-1"),
      ).toEqual([]);

      const active = record(root, {
        claimId: NEXT_CLAIM,
        state: "active",
        pid: 5678,
      });
      await replaceLeaseRecord(root, CLAIM, active);
      expect(await listLeaseRecords(root)).toEqual([
        { path: recordPath(root), state: "valid", record: active },
      ]);
      await removeLeaseRecord(root, NEXT_CLAIM);
      expect(await listLeaseRecords(root)).toEqual([]);
    }));

  test("refuses duplicate creation and mismatched replacement or removal", async () =>
    withRoot(async (root) => {
      await createLeaseRecord(root, record(root));
      await expect(createLeaseRecord(root, record(root))).rejects.toThrow(
        "already exists",
      );
      await expect(
        replaceLeaseRecord(root, NEXT_CLAIM, record(root, { state: "active" })),
      ).rejects.toThrow("expected claim");
      await expect(
        removeLeaseRecord(root, NEXT_CLAIM),
      ).resolves.toBeUndefined();
      expect(await listLeaseRecords(root)).toHaveLength(1);
    }));

  test("returns malformed, oversized, nested, and symlink entries as ambiguous gates", async () =>
    withRoot(async (root) => {
      const leases = join(root, ".leases");
      await mkdir(leases);
      await writeFile(join(leases, `${CLAIM}.json`), "not-json");
      await writeFile(
        join(leases, `${NEXT_CLAIM}.json`),
        "x".repeat(16 * 1024 + 1),
      );
      await mkdir(join(leases, "nested.json"));
      await symlink(join(leases, `${CLAIM}.json`), join(leases, "link.json"));
      await writeFile(join(leases, "bad-name.json"), "{}\n");

      const gates = await listLeaseRecords(root);
      expect(gates).toHaveLength(5);
      expect(gates.every((gate) => gate.state === "ambiguous")).toBe(true);
      expect(
        gates
          .filter((gate) => gate.state === "ambiguous")
          .map((gate) => gate.reason),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("malformed JSON"),
          expect.stringContaining("exceeds 16384 bytes"),
          expect.stringContaining("not a regular file"),
          expect.stringContaining("invalid lease filename"),
        ]),
      );
    }));

  test("rejects unknown fields, unsafe identities, paths, and invalid states before writing", async () =>
    withRoot(async (root) => {
      for (const invalid of [
        { ...record(root), extra: true },
        record(root, { repository: "../escape" }),
        record(root, { path: "relative" }),
        record(root, { path: join(root, "..", `worktree-${PATH_ID}`) }),
        record(root, { pid: 0 }),
        record(root, { state: "idle" as LeaseRecord["state"] }),
      ]) {
        await expect(
          createLeaseRecord(root, invalid as LeaseRecord),
        ).rejects.toThrow("lease record");
      }
      expect(await readdir(root)).toEqual([]);
    }));

  test("does not create an absent hierarchy while listing", async () =>
    withRoot(async (root) => {
      expect(await listLeaseRecords(root)).toEqual([]);
      await expect(lstat(join(root, ".leases"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  test("preserves a symlinked lease root and refuses mutation", async () =>
    withRoot(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "pool-leases-outside-"));
      try {
        await symlink(outside, join(root, ".leases"));
        const gates = await listLeaseRecords(root);
        expect(gates).toEqual([
          expect.objectContaining({
            state: "ambiguous",
            reason: expect.stringContaining("plain directory"),
          }),
        ]);
        await expect(createLeaseRecord(root, record(root))).rejects.toThrow(
          "plain directory",
        );
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    }));
});
