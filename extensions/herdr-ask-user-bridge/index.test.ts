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

test("ignores malformed blocked-state payloads", () => {
  const { events, reports } = setupBridge();

  events.emit("rpiv:ask-user:blocked", null);
  events.emit("research-web:blocked", null);
  events.emit("research-web:blocked", { active: "yes" });
  events.emit("force-push:blocked", null);

  assert.deepEqual(reports, []);
});
