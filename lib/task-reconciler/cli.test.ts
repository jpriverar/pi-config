import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli, type CliDependencies } from "./cli.js";

test("CLI dispatch is explicit and never runs administration during help", async () => {
  const calls: unknown[][] = [];
  const output: string[] = [];
  const deps: CliDependencies = {
    output: (line) => output.push(line),
    manage: async (...args) => {
      calls.push(args);
    },
    run: async (path) => {
      calls.push(["run", path]);
    },
  };
  assert.equal(await runCli(["--help"], { deps }), 0);
  assert.equal(calls.length, 0);
  for (const action of [
    "install",
    "start",
    "stop",
    "status",
    "update",
    "uninstall",
    "run",
  ]) {
    assert.equal(
      await runCli([action, "--config", "/fixture/config.json"], { deps }),
      0,
    );
    assert.equal(calls.at(-1)?.[0], action);
    assert.equal(calls.at(-1)?.[1], "/fixture/config.json");
  }
  assert.ok(output.length > 0);
});

test("invalid or ambiguous arguments cannot dispatch an operation", async () => {
  const deps: CliDependencies = {
    output() {},
    manage: async () => {
      throw new Error("must not dispatch");
    },
    run: async () => {
      throw new Error("must not run");
    },
  };
  for (const argv of [
    [],
    ["unknown"],
    ["start"],
    ["start", "--config", "relative"],
    ["start", "--config", "/a", "--config", "/b"],
    ["start", "--config", "/a", "--force"],
    ["install", "--config", "/a", "--rollback"],
  ])
    assert.notEqual(await runCli(argv, { deps }), 0);
});

test("rollback is an explicit update option rather than automatic fallback", async () => {
  const calls: unknown[][] = [];
  const deps: CliDependencies = {
    output() {},
    manage: async (...args) => {
      calls.push(args);
    },
    run: async () => {},
  };
  assert.equal(
    await runCli(["update", "--config", "/fixture/config.json", "--rollback"], {
      deps,
    }),
    0,
  );
  assert.deepEqual(calls, [
    ["update", "/fixture/config.json", { rollback: true }],
  ]);
});

test("CLI reports an operation failure without claiming success", async () => {
  const output: string[] = [];
  const deps: CliDependencies = {
    output: (line) => output.push(line),
    manage: async () => {
      throw new Error("fixture update stayed stopped");
    },
    run: async () => {},
  };
  assert.equal(
    await runCli(["update", "--config", "/fixture/config.json"], { deps }),
    1,
  );
  assert.ok(
    output.some((line) => line.includes("fixture update stayed stopped")),
  );
});
