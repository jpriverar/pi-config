import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { test } from "node:test";
import { hostFixture } from "./host-fixtures.js";
import { fixturePolicy } from "./test-fixtures.js";
import { parseDaemonHealth, readDaemonHealth } from "./health.js";
import {
  encodeFrame,
  FrameReader,
  parseRequest,
  parseResponse,
} from "./protocol.js";
import { ProtocolError } from "./schema.js";
import { requestReconciliation, ReconciliationClientError } from "./client.js";

const health = {
  state: "available",
  protocolVersion: 2,
  supportedLifecycleVersions: [1, 2],
  lifecycleWriteVersion: 2,
  runtimeVersion: "fixture",
  pid: process.pid,
  startedAt: "2026-10-01T00:00:00Z",
  heartbeatAt: "2026-10-01T00:00:00Z",
  queue: {
    lastScanAttemptAt: null,
    lastScanSuccessAt: null,
    queued: 0,
    localRunning: 0,
    externalRunning: 0,
    diagnostics: [],
  },
};
const incompatible = (error: unknown) =>
  error instanceof ProtocolError && error.code === "incompatible";
const clientIncompatible = (error: unknown) =>
  error instanceof ReconciliationClientError && error.code === "incompatible";

test("v2 health reports readable schemas separately from its configured writer", () => {
  assert.deepEqual(parseDaemonHealth(health), health);
  assert.deepEqual(parseDaemonHealth({ ...health, lifecycleWriteVersion: 1 }), {
    ...health,
    lifecycleWriteVersion: 1,
  });
  for (const capabilities of [[], [1, 1], [0], ["2"], [1]])
    assert.throws(() =>
      parseDaemonHealth({
        ...health,
        supportedLifecycleVersions: capabilities,
      }),
    );
});

test("old health and protocol peers fail explicitly rather than dropping new fields", () => {
  const {
    supportedLifecycleVersions: _s,
    lifecycleWriteVersion: _w,
    ...old
  } = health;
  assert.throws(
    () => parseDaemonHealth({ ...old, protocolVersion: 1 }),
    incompatible,
  );
  assert.throws(
    () => parseRequest({ version: 1, kind: "status", store: "/fixture" }),
    incompatible,
  );
  assert.throws(
    () =>
      parseResponse({
        version: 1,
        ok: false,
        code: "incompatible",
        outcomeUnknown: false,
      }),
    incompatible,
  );
});

test("wire v2 requires an explicit schema for reconciliation, but not status", () => {
  const request = {
    version: 2,
    kind: "reconcile",
    store: "/fixture",
    lifecycleVersion: 2,
    request: { taskId: "jp-1", requestId: "r" },
  };
  assert.deepEqual(parseRequest(request), request);
  const { lifecycleVersion: _v, ...missing } = request;
  assert.throws(() => parseRequest(missing));
  assert.throws(() => parseRequest({ ...request, lifecycleVersion: "2" }));
  assert.deepEqual(
    parseRequest({ version: 2, kind: "status", store: "/fixture" }),
    { version: 2, kind: "status", store: "/fixture" },
  );
  assert.throws(() =>
    parseRequest({
      version: 2,
      kind: "status",
      store: "/fixture",
      lifecycleVersion: 2,
    }),
  );
});

async function exchange(path: string, value: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const reader = new FrameReader();
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("fixture RPC timeout"));
    }, 2000);
    socket.on("connect", () => socket.write(encodeFrame(value)));
    socket.on("error", reject);
    socket.on("close", () => clearTimeout(timer));
    socket.on("data", (chunk: Buffer) => {
      try {
        const result = reader.push(chunk);
        if (result !== undefined) {
          resolve(result);
          socket.destroy();
        }
      } catch (error) {
        reject(error);
        socket.destroy();
      }
    });
  });
}

test("server rejects a mismatched writer before queue admission", async (t) => {
  const f = await hostFixture(t);
  await f.start();
  const paths = await f.paths();
  const base = {
    version: 2,
    kind: "reconcile",
    store: f.config.store,
    request: { taskId: "jp-1", requestId: "r" },
  };
  assert.deepEqual(
    await exchange(paths.socket, { ...base, lifecycleVersion: 2 }),
    {
      version: 2,
      ok: false,
      code: "incompatible",
      outcomeUnknown: false,
    },
  );
  assert.equal(f.calls.requests.length, 0);
  const accepted = parseResponse(
    await exchange(paths.socket, { ...base, lifecycleVersion: 1 }),
  );
  assert.equal(accepted.ok, true);
  assert.equal(f.calls.requests.length, 1);
});

test("a v2 client rejects a v1 writer without a local fallback", async (t) => {
  const f = await hostFixture(t);
  await writeFile(
    f.config.lifecycleConfigPath,
    JSON.stringify({ ...fixturePolicy, lifecycleWriteVersion: 2 }),
  );
  await f.start();
  await assert.rejects(
    requestReconciliation(f.config, { taskId: "jp-1", requestId: "r" }),
    clientIncompatible,
  );
  assert.equal(f.calls.requests.length, 0);
});

test("a compatible v2 host serves a v2 client and preserves private identity format", async (t) => {
  const f = await hostFixture(t);
  await writeFile(
    f.config.lifecycleConfigPath,
    JSON.stringify({ ...fixturePolicy, lifecycleWriteVersion: 2 }),
  );
  await f.start({ ...f.runner, lifecycleWriteVersion: 2 });
  const observed = await readDaemonHealth(f.config);
  assert.equal(observed.state, "available");
  if (observed.state !== "available") throw new Error("missing host");
  assert.deepEqual(observed.supportedLifecycleVersions, [1, 2]);
  assert.equal(observed.lifecycleWriteVersion, 2);
  const paths = await f.paths();
  assert.equal(JSON.parse(await readFile(paths.identity, "utf8")).version, 1);
  assert.equal(JSON.parse(await readFile(paths.health, "utf8")).version, 2);
  assert.equal(
    (await requestReconciliation(f.config, { taskId: "jp-1", requestId: "r" }))
      .task.id,
    "jp-1",
  );
});

test("client respects advertised writer capability even when the socket would accept the request", async (t) => {
  const f = await hostFixture(t);
  f.config.limits.heartbeatIntervalMs = 60_000;
  await writeFile(
    f.config.lifecycleConfigPath,
    JSON.stringify({ ...fixturePolicy, lifecycleWriteVersion: 2 }),
  );
  await f.start({ ...f.runner, lifecycleWriteVersion: 2 });
  const paths = await f.paths();
  const saved = JSON.parse(await readFile(paths.health, "utf8"));
  saved.health.supportedLifecycleVersions = [1];
  saved.health.lifecycleWriteVersion = 1;
  await writeFile(paths.health, JSON.stringify(saved));
  await assert.rejects(
    requestReconciliation(f.config, { taskId: "jp-1", requestId: "r" }),
    clientIncompatible,
  );
  assert.equal(f.calls.requests.length, 0);
});

test("Pi's explicit writer mode cannot be replaced by a daemon's separate v1 policy file", async (t) => {
  const f = await hostFixture(t);
  await f.start();
  await assert.rejects(
    requestReconciliation(
      f.config,
      { taskId: "jp-1", requestId: "pi-v2" },
      undefined,
      2,
    ),
    clientIncompatible,
  );
  assert.equal(f.calls.requests.length, 0);
});
