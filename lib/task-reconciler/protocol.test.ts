import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeFrame,
  FrameReader,
  MAX_FRAME_BYTES,
  parseRequest,
  parseResponse,
} from "./protocol.js";

test("decodes one fragmented length-prefixed JSON frame", () => {
  const value = { version: 1, kind: "status", store: "/fixture/store" };
  const frame = encodeFrame(value);
  const reader = new FrameReader();
  for (let i = 0; i < frame.length - 1; i++)
    assert.equal(reader.push(frame.subarray(i, i + 1)), undefined);
  assert.deepEqual(reader.push(frame.subarray(-1)), value);
  assert.throws(() => reader.push(frame), /frame/);
});

test("bounds the complete frame and rejects malformed encoding before dispatch", () => {
  const full = encodeFrame("x".repeat(MAX_FRAME_BYTES - 6));
  assert.equal(full.length, MAX_FRAME_BYTES);
  assert.equal(new FrameReader().push(full), "x".repeat(MAX_FRAME_BYTES - 6));
  assert.throws(
    () => encodeFrame("x".repeat(MAX_FRAME_BYTES - 5)),
    /large|limit/,
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameReader().push(header), /large|limit/);
  assert.throws(
    () =>
      new FrameReader().push(Buffer.concat([encodeFrame({}), encodeFrame({})])),
    /frame/,
  );
  const invalid = Buffer.from([0, 0, 0, 1, 0xff]);
  assert.throws(() => new FrameReader().push(invalid), /JSON|encoding/);
  assert.throws(
    () => new FrameReader().push(Buffer.from([0, 0, 0, 0])),
    /length/,
  );
});

test("request validation excludes arbitrary fields and unbound manual intent", () => {
  const ordinary = {
    version: 1,
    kind: "reconcile",
    store: "/fixture/store",
    request: { requestId: "r", taskId: "jp-a" },
  };
  assert.deepEqual(parseRequest(ordinary), ordinary);
  const manual = {
    ...ordinary,
    request: {
      ...ordinary.request,
      manualOutcome: "satisfied",
      expectedCheckFingerprint: "a".repeat(64),
    },
  };
  assert.deepEqual(parseRequest(manual), manual);
  for (const value of [
    { ...ordinary, version: 2 },
    { ...ordinary, command: "anything" },
    { ...ordinary, kind: "stop" },
    { ...ordinary, store: "relative" },
    { ...ordinary, request: { ...ordinary.request, extra: true } },
    { ...ordinary, request: { ...ordinary.request, taskId: "--all" } },
    { ...ordinary, request: { ...ordinary.request, requestId: "r\n" } },
    {
      ...ordinary,
      request: { ...ordinary.request, manualOutcome: "satisfied" },
    },
    {
      ...manual,
      request: { ...manual.request, expectedCheckFingerprint: "bad" },
    },
  ])
    assert.throws(() => parseRequest(value));
});

test("reconciliation responses contain only a validated task summary", () => {
  const value = {
    version: 1,
    ok: true,
    kind: "reconcile",
    reply: {
      requestId: "r",
      outcome: "applied",
      task: { id: "jp-a", status: "open", phase: "actionable" },
    },
  };
  assert.deepEqual(parseResponse(value), value);
  assert.throws(() =>
    parseResponse({
      ...value,
      reply: {
        ...value.reply,
        task: { ...value.reply.task, metadata: { private: true } },
      },
    }),
  );
  assert.throws(() => parseResponse({ ...value, version: 99 }));
});

test("response parsing covers every native lifecycle status", () => {
  const phases: Record<
    import("../task-lifecycle/types.js").LifecycleStatus,
    string
  > = {
    open: "actionable",
    in_progress: "active",
    blocked: "waiting",
    deferred: "deferred",
    closed: "done",
  };
  for (const [status, phase] of Object.entries(phases)) {
    const response = {
      version: 1,
      ok: true,
      kind: "reconcile",
      reply: {
        requestId: "fixture",
        outcome: "unchanged",
        task: { id: "jp-1", status, phase },
      },
    };
    assert.deepEqual(parseResponse(response), response);
  }
});
