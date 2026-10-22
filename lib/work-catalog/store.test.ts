import assert from "node:assert/strict";
import test from "node:test";
import { createBeadsClient, type BeadsExec } from "../beads.js";
import { createCatalogStore } from "./store.js";
import { catalogFixture } from "./test-fixtures.js";

function fixture(
  options: { rejectWrite?: boolean; corruptReadback?: boolean } = {},
) {
  let value = "";
  const calls: string[][] = [];
  const exec: BeadsExec = async (_command, args) => {
    calls.push([...args]);
    assert.equal(args[0], "config");
    assert.equal(args[2], "custom.pi-work-catalog");
    if (args[1] === "set") {
      if (options.rejectWrite)
        return { code: 1, stdout: "", stderr: "private detail" };
      value = options.corruptReadback ? "{}" : args[3];
      return { code: 0, stdout: "{}", stderr: "" };
    }
    assert.equal(args[1], "get");
    return {
      code: 0,
      stdout: JSON.stringify({ key: args[2], value }),
      stderr: "",
    };
  };
  return {
    calls,
    store: createCatalogStore(
      createBeadsClient(exec, { env: { BEADS_DIR: "/fixture/store" } }),
    ),
  };
}
test("catalog store reads missing config and verifies a persisted round trip", async () => {
  const { store, calls } = fixture();
  assert.equal(await store.read(), null);
  await store.write(catalogFixture());
  assert.deepEqual(await store.read(), catalogFixture());
  assert.equal(calls.filter((c) => c[1] === "set").length, 1);
  assert.ok(calls.every((c) => c.includes("/fixture/store")));
});
test("invalid catalog is rejected before any command", async () => {
  const { store, calls } = fixture();
  await assert.rejects(
    store.write({ ...catalogFixture(), version: 99 } as any),
  );
  assert.equal(calls.length, 0);
});
test("catalog store reports rejected writes and unverifiable readbacks without retry", async () => {
  for (const options of [{ rejectWrite: true }, { corruptReadback: true }]) {
    const { store, calls } = fixture(options);
    await assert.rejects(store.write(catalogFixture()), /catalog/i);
    assert.equal(calls.filter((c) => c[1] === "set").length, 1);
  }
});
