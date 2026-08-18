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

test("reports questionnaire waits as Herdr blocked state", async () => {
  const loaded = await import("./index.js").catch(() => undefined);
  assert.equal(typeof loaded?.createHerdrAskUserBridge, "function");

  const events = createEventBus();
  const reports: unknown[] = [];
  events.on("herdr:blocked", (payload) => reports.push(payload));
  (loaded as unknown as BridgeModule).createHerdrAskUserBridge()({ events });

  events.emit("rpiv:ask-user:blocked", { active: true });
  events.emit("rpiv:ask-user:blocked", { active: false });

  assert.deepEqual(reports, [
    { active: true, label: "Waiting for user input" },
    { active: false },
  ]);
});
