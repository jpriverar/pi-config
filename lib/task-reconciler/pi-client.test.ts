import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hostFixture } from "./host-fixtures.js";
import { requestPiReconciliation, readPiDaemonHealth } from "./pi-client.js";
import taskLifecycle from "../../extensions/task-lifecycle/index.js";

function restoreEnv(
  t: import("node:test").TestContext,
  name: string,
  value: string,
) {
  const before = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}
test("Pi client binds requests and health to its Beads store", async (t) => {
  const f = await hostFixture(t);
  await f.start();
  restoreEnv(t, "PI_TASK_RECONCILER_CONFIG", f.configPath);
  assert.equal((await readPiDaemonHealth(f.config.store)).state, "available");
  await requestPiReconciliation(
    { requestId: "same-store", taskId: "jp-1" },
    undefined,
    f.config.store,
  );
  const other = join(f.root, "other-store");
  await mkdir(other);
  await assert.rejects(
    requestPiReconciliation(
      { requestId: "wrong-store", taskId: "jp-1" },
      undefined,
      other,
    ),
    /configuration unavailable/,
  );
  assert.equal(f.calls.requests.length, 1);
});
test("default extension captures its store rather than following later environment changes", async (t) => {
  const f = await hostFixture(t);
  await f.start();
  restoreEnv(t, "PI_TASK_RECONCILER_CONFIG", f.configPath);
  restoreEnv(t, "BEADS_DIR", f.config.store);
  const tools = new Map<string, any>();
  taskLifecycle({
    exec: async () => {
      throw new Error("no local commands expected");
    },
    on() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {},
    sendMessage() {},
  } as any);
  const other = join(f.root, "other-store");
  await mkdir(other);
  process.env.BEADS_DIR = other;
  const result = await tools
    .get("task_reconcile")
    .execute("captured-store", { taskId: "jp-1" }, undefined, undefined, {
      cwd: other,
      sessionManager: { getSessionId: () => "fixture" },
    });
  assert.notEqual(result.isError, true);
  assert.equal(f.calls.requests.length, 1);
});
