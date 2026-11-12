import { describe, expect, test } from "../../tests/expect.js";
import { stopExactWatch } from "./watchman.js";

const path = "/pool/repo/worktree-123";

describe("exact Watchman watch cleanup", () => {
  test("deletes only the exact root and checks it is gone", async () => {
    const calls: string[][] = [];
    await stopExactWatch(path, async (args) => {
      calls.push(args);
      if (args[0] === "watch-del")
        return JSON.stringify({ root: path, "watch-del": true });
      return JSON.stringify({
        roots:
          calls.length === 1
            ? ["/pool", path, path + "-other"]
            : ["/pool", path + "-other"],
      });
    });
    expect(calls).toEqual([
      ["watch-list"],
      ["watch-del", path],
      ["watch-list"],
    ]);
  });

  test("does not stop parent, child or neighboring watches", async () => {
    const calls: string[][] = [];
    await stopExactWatch(path, async (args) => {
      calls.push(args);
      return JSON.stringify({
        roots: ["/pool", path + "/child", path + "-other"],
      });
    });
    expect(calls).toEqual([["watch-list"]]);
  });

  for (const reply of [
    "not json",
    "null",
    "[]",
    "{}",
    '{"roots":[12]}',
    '{"error":"denied","roots":[]}',
  ]) {
    test(`refuses malformed/error watch-list reply: ${reply}`, async () => {
      await expect(stopExactWatch(path, async () => reply)).rejects.toThrow(
        /Watchman/,
      );
    });
  }

  for (const reply of [
    { root: path, "watch-del": false },
    { root: "/elsewhere", "watch-del": true },
    { error: "denied", root: path, "watch-del": true },
  ]) {
    test(`refuses unconfirmed watch deletion: ${JSON.stringify(reply)}`, async () => {
      await expect(
        stopExactWatch(path, async (args) =>
          JSON.stringify(args[0] === "watch-list" ? { roots: [path] } : reply),
        ),
      ).rejects.toThrow(/Watchman/);
    });
  }

  test("refuses a watch that remains after deletion", async () => {
    await expect(
      stopExactWatch(path, async (args) =>
        JSON.stringify(
          args[0] === "watch-list"
            ? { roots: [path] }
            : { root: path, "watch-del": true },
        ),
      ),
    ).rejects.toThrow(/still watches/);
  });

  test("does not mask missing CLI, daemon failure or command timeout", async () => {
    for (const reason of [
      "ENOENT",
      "daemon unavailable",
      "command timed out",
    ]) {
      await expect(
        stopExactWatch(path, async () => {
          throw new Error(reason);
        }),
      ).rejects.toThrow(reason);
    }
  });
});
