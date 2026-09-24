import assert from "node:assert/strict";
import test from "node:test";
import herdrAskUserBridge from "./index.js";

type Listener = (payload: unknown) => void;

function createEventBus() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(channel: string, listener: Listener) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((entry) => entry !== listener),
        );
      };
    },
    emit(channel: string, payload: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

function setupBridge() {
  const events = createEventBus();
  const reports: unknown[] = [];
  events.on("herdr:blocked", (payload) => reports.push(payload));
  herdrAskUserBridge({ events });
  return { events, reports };
}

test("reports questionnaire waits as Herdr blocked state", () => {
  const { events, reports } = setupBridge();

  events.emit("rpiv:ask-user:blocked", { active: true });
  events.emit("rpiv:ask-user:blocked", { active: false });

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for user input" },
    { active: false },
  ]);
});

test("reports research-web waits as Herdr blocked state", () => {
  const { events, reports } = setupBridge();

  events.emit("research-web:blocked", { active: true });
  events.emit("research-web:blocked", { active: false });

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for web search approval" },
    { active: false },
  ]);
});

test("reports force-push waits as Herdr blocked state", () => {
  const { events, reports } = setupBridge();

  events.emit("force-push:blocked", { active: true });
  events.emit("force-push:blocked", { active: false });

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for force-push approval" },
    { active: false },
  ]);
});

test("reports APM Recommendations insert approval as Herdr blocked state", () => {
  const { events, reports } = setupBridge();

  events.emit("apm-recs:blocked", { active: true });
  events.emit("apm-recs:blocked", { active: false });

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for APM Recommendations insert approval" },
    { active: false },
  ]);
});

test("aggregates auth challenges by challenge ID", () => {
  const { events, reports } = setupBridge();

  const auth = (
    challengeId: string,
    phase: "started" | "finished",
    outcome: "succeeded" | "failed" | "tool-ended" = "succeeded",
    method: "browser" | "device-code" = "browser",
  ): void => {
    events.emit("auth-aware-bash:challenge", {
      challengeId,
      toolCallId: challengeId.split(":")[0],
      phase,
      method,
      ...(phase === "finished" ? { outcome } : {}),
    });
  };

  auth("call-1:1", "started");
  auth("call-1:1", "started");
  auth("call-2:1", "started", "succeeded", "device-code");
  auth("call-3:1", "started");
  auth("call-1:1", "finished");
  auth("unknown:1", "finished");
  auth("call-2:1", "finished", "tool-ended", "device-code");
  auth("call-3:1", "finished", "failed");

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for browser authentication" },
    { active: false },
  ]);
});

test("ignores malformed auth challenge events", () => {
  const { events, reports } = setupBridge();

  const malformed: unknown[] = [
    null,
    {},
    {
      challengeId: "",
      toolCallId: "call-1",
      phase: "started",
      method: "browser",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "",
      phase: "started",
      method: "browser",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "call-1",
      phase: "waiting",
      method: "browser",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "call-1",
      phase: "started",
      method: "password",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "call-1",
      phase: "started",
      method: "browser",
      outcome: "succeeded",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "call-1",
      phase: "finished",
      method: "browser",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "call-1",
      phase: "finished",
      method: "browser",
      outcome: "cancelled",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "call-1",
      phase: "started",
      method: "device-code",
      url: "https://github.com/login/device",
    },
    {
      challengeId: "call-1:1",
      toolCallId: "call-1",
      phase: "finished",
      method: "device-code",
      outcome: "failed",
      deviceCode: "ABCD-EFGH",
    },
  ];

  for (const payload of malformed) {
    events.emit("auth-aware-bash:challenge", payload);
  }

  assert.deepEqual(reports, []);
});

test("ignores malformed blocked-state payloads", () => {
  const { events, reports } = setupBridge();

  events.emit("rpiv:ask-user:blocked", null);
  events.emit("research-web:blocked", null);
  events.emit("research-web:blocked", { active: "yes" });
  events.emit("force-push:blocked", null);
  events.emit("apm-recs:blocked", null);
  events.emit("apm-recs:blocked", { active: "yes" });

  assert.deepEqual(reports, []);
});
