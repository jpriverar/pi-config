import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { test } from "node:test";
import { hostFixture } from "./host-fixtures.js";
import { serveReconciler } from "./server.js";
import { resolveRuntimePaths } from "./files.js";
import { encodeFrame, MAX_FRAME_BYTES } from "./protocol.js";
import { requestReconciliation } from "./client.js";

test("canonical aliases share one host and a rejected host cannot remove its socket", async (t) => {
  const f = await hostFixture(t);
  const host = await f.start();
  const paths = await f.paths();
  const inode = (await stat(paths.socket)).ino;
  const alias = join(f.root, "alias");
  await symlink(f.config.store, alias);
  await assert.rejects(
    serveReconciler(
      { ...f.config, store: alias },
      f.runner,
      { ...f.owner, sessionId: "second" },
      new AbortController().signal,
    ),
    /owner|running|lock/,
  );
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.stop, 0);
  assert.equal((await stat(paths.socket)).ino, inode);
  const reply = await requestReconciliation(
    { ...f.config, store: alias },
    { requestId: "r", taskId: "jp-a" },
  );
  assert.deepEqual(reply, {
    requestId: "r",
    outcome: "unchanged",
    task: { id: "jp-a", status: "blocked", phase: "waiting" },
  });
  assert.ok(!JSON.stringify(reply).includes("not-for-the-client"));
  await host.stop();
  assert.equal(f.calls.stop, 1);
  await assert.rejects(access(paths.socket));
});

test("startup failure after ownership acquisition releases only its own resources", async (t) => {
  const f = await hostFixture(t);
  await assert.rejects(
    serveReconciler(
      f.config,
      {
        ...f.runner,
        start() {
          throw new Error("fixture start failure");
        },
      },
      f.owner,
      new AbortController().signal,
    ),
    /fixture start failure/,
  );
  const paths = await f.paths();
  await assert.rejects(access(paths.socket));
  await assert.rejects(access(paths.identity));
  await assert.rejects(access(join(paths.lockRoot, "operation.lock", "held")));
  const host = await f.start();
  await host.stop();
});

test("unsafe directories, symlinks, and foreign ownership are refused before starting", async (t) => {
  const f = await hostFixture(t);
  await mkdir(f.config.runtimeRoot, { mode: 0o755 });
  await assert.rejects(
    serveReconciler(f.config, f.runner, f.owner, new AbortController().signal),
    /mode|private/,
  );
  await chmod(f.config.runtimeRoot, 0o700);
  const link = join(f.root, "runtime-link");
  await symlink(f.config.runtimeRoot, link);
  await assert.rejects(
    serveReconciler(
      { ...f.config, runtimeRoot: link },
      f.runner,
      f.owner,
      new AbortController().signal,
    ),
    /symlink|directory/,
  );
  if (process.getuid?.() !== 0)
    await assert.rejects(
      serveReconciler(
        { ...f.config, runtimeRoot: "/" },
        f.runner,
        f.owner,
        new AbortController().signal,
      ),
      /owner/,
    );
  assert.equal(f.calls.start, 0);
});

test("ambiguous ownership fails closed", async (t) => {
  const f = await hostFixture(t);
  const paths = await resolveRuntimePaths(f.config, true);
  const held = join(paths.lockRoot, "operation.lock", "held");
  await mkdir(held, { recursive: true });
  await writeFile(
    join(held, "owner-foreign.json"),
    JSON.stringify({ ...f.owner, host: "another-host", pid: 999999999 }),
  );
  await assert.rejects(
    serveReconciler(f.config, f.runner, f.owner, new AbortController().signal),
    /owner|lock/,
  );
  assert.equal(f.calls.start, 0);
  assert.equal(
    JSON.parse(await readFile(join(held, "owner-foreign.json"), "utf8")).host,
    "another-host",
  );
});

test("confirmed dead ownership can be reclaimed without waiting for another leader", async (t) => {
  const f = await hostFixture(t);
  const paths = await resolveRuntimePaths(f.config, true);
  const held = join(paths.lockRoot, "operation.lock", "held");
  await mkdir(held, { recursive: true });
  await writeFile(
    join(held, "owner-dead.json"),
    JSON.stringify({ ...f.owner, pid: 999999999 }),
  );
  const host = await f.start();
  assert.equal(f.calls.start, 1);
  await host.stop();
});

test("oversized and malformed input never reaches task reconciliation", async (t) => {
  const f = await hostFixture(t);
  const host = await f.start();
  const paths = await f.paths();
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  for (const data of [
    oversized,
    Buffer.from([0, 0, 0, 1, 0xff]),
    encodeFrame({ version: 2, kind: "status", store: f.config.store }),
    encodeFrame({
      version: 1,
      kind: "reconcile",
      store: f.config.store,
      request: { requestId: "r", taskId: "x", command: "ignored" },
    }),
  ]) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(paths.socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("malformed connection was not closed"));
      }, 2000);
      socket.on("connect", () => socket.write(data));
      socket.on("data", () => {});
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  assert.equal(f.calls.requests.length, 0);
  await host.stop();
});

test("the full canonical store identity prevents key-collision cleanup", async (t) => {
  const f = await hostFixture(t);
  const host = await f.start();
  const paths = await f.paths();
  const identity = JSON.parse(await readFile(paths.identity, "utf8"));
  await host.stop();
  identity.store = "/another-store";
  identity.owner.pid = 999999999;
  const contents = JSON.stringify(identity);
  await writeFile(paths.identity, contents, { mode: 0o600 });
  await assert.rejects(
    serveReconciler(f.config, f.runner, f.owner, new AbortController().signal),
    /store|collision/,
  );
  assert.equal(await readFile(paths.identity, "utf8"), contents);
  assert.equal(f.calls.start, 1);
});

test("overlong socket paths are rejected before starting the runner", async (t) => {
  const f = await hostFixture(t);
  await assert.rejects(
    serveReconciler(
      { ...f.config, runtimeRoot: join(f.config.runtimeRoot, "x".repeat(110)) },
      f.runner,
      f.owner,
      new AbortController().signal,
    ),
    /socket.*long|socket.*limit/,
  );
  assert.equal(f.calls.start, 0);
});

test("shutdown keeps ownership until work drains and handles rejected-client write errors", async (t) => {
  const f = await hostFixture(t);
  let release!: () => void;
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stopping = false;
  const host = await f.start({
    ...f.runner,
    async stop() {
      stopping = true;
      await drained;
    },
  });
  const paths = await f.paths();
  const { Socket } = await import("node:net");
  const originalEnd = Socket.prototype.end;
  let injected = false;
  t.mock.method(
    Socket.prototype,
    "end",
    function (this: InstanceType<typeof Socket>, ...args: unknown[]) {
      if (Buffer.isBuffer(args[0])) {
        let response: unknown;
        try {
          response = JSON.parse(args[0].subarray(4).toString("utf8"));
        } catch {}
        if (
          response !== null &&
          typeof response === "object" &&
          "code" in response &&
          response.code === "not_running"
        ) {
          injected = true;
          queueMicrotask(() =>
            this.emit(
              "error",
              new Error("fixture rejected-client write failure"),
            ),
          );
          return this;
        }
      }
      return Reflect.apply(originalEnd, this, args);
    },
  );
  try {
    host.controller.abort();
    const { waitUntil } = await import("./host-fixtures.js");
    await waitUntil(() => stopping);
    await access(paths.socket);
    await access(join(paths.lockRoot, "operation.lock", "held"));
    await new Promise<void>((resolve) => {
      const socket = createConnection(paths.socket);
      socket.on("error", () => {});
      socket.on("close", () => resolve());
    });
    assert.equal(injected, true);
    release();
    await host.done;
    await assert.rejects(access(paths.socket));
    await assert.rejects(
      access(join(paths.lockRoot, "operation.lock", "held")),
    );
  } finally {
    release();
    await host.done;
  }
});
