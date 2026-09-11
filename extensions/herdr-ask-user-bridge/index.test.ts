import assert from "node:assert/strict";
import test from "node:test";

type Listener = (payload: unknown) => void;

type BridgeModule = {
  createHerdrAskUserBridge: () => (pi: {
    events: {
      on: (channel: string, listener: Listener) => void;
      emit: (channel: string, payload: unknown) => void;
    };
  }) => void;
};

function createEventBus() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(channel: string, listener: Listener) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
    emit(channel: string, payload: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

async function loadBridge() {
  const loaded = await import("./index.js").catch(() => undefined);
  assert.equal(typeof loaded?.createHerdrAskUserBridge, "function");
  return loaded as unknown as BridgeModule;
}

test("reports questionnaire waits as Herdr blocked state", async () => {
  const loaded = await loadBridge();
  const events = createEventBus();
  const reports: unknown[] = [];
  events.on("herdr:blocked", (payload) => reports.push(payload));
  loaded.createHerdrAskUserBridge()({ events });

  events.emit("rpiv:ask-user:blocked", { active: true });
  events.emit("rpiv:ask-user:blocked", { active: false });

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for user input" },
    { active: false },
  ]);
});

test("aggregates research-web waits by tool-call ID", async () => {
  const loaded = await loadBridge();
  const events = createEventBus();
  const reports: unknown[] = [];
  events.on("herdr:blocked", (payload) => reports.push(payload));
  loaded.createHerdrAskUserBridge()({ events });

  const emit = (toolCallId: string, phase: "started" | "finished"): void => {
    events.emit("research-web:blocked", {
      toolCallId,
      phase,
      reason: "high_context",
    });
  };

  emit("call-1", "started");
  emit("call-1", "started");
  emit("call-2", "started");
  emit("call-1", "finished");
  emit("call-1", "finished");
  emit("unknown", "finished");
  emit("call-2", "finished");
  emit("call-2", "finished");

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for web search approval" },
    { active: false },
  ]);
});

test("ignores malformed blocked-state payloads", async () => {
  const loaded = await loadBridge();
  const events = createEventBus();
  const reports: unknown[] = [];
  events.on("herdr:blocked", (payload) => reports.push(payload));
  loaded.createHerdrAskUserBridge()({ events });

  events.emit("rpiv:ask-user:blocked", null);
  events.emit("research-web:blocked", null);
  events.emit("research-web:blocked", {
    toolCallId: "call-1",
    phase: "waiting",
    reason: "high_context",
  });
  events.emit("research-web:blocked", {
    toolCallId: "",
    phase: "started",
    reason: "high_context",
  });
  events.emit("research-web:blocked", {
    toolCallId: "call-1",
    phase: "started",
    reason: "unknown",
  });

  assert.deepEqual(reports, []);
});
