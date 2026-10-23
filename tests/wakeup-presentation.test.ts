import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createWakeupPresentation,
  wakeupTime,
} from "../extensions/wakeups/presentation.js";
import type { WakeupState } from "../lib/wakeups.js";

const now = Date.UTC(2026, 1, 1, 15);
const pending = {
  id: "wake-fixture",
  dueAt: now + 300_000,
  deadline: now + 3_600_000,
  prompt: "Check fixture operation",
  reason: "CI\n\x1b]0;unsafe-title\x07 is still running\x1b[31m",
};
const scheduled: WakeupState = {
  status: "scheduled",
  deadline: pending.deadline,
  pending,
};

function harness() {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const renderers = new Map<string, EntryRenderer>();
  const events = new EventEmitter();
  const pi = {
    events,
    registerEntryRenderer(type: string, renderer: EntryRenderer) {
      renderers.set(type, renderer);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as ExtensionContext;
  const view = createWakeupPresentation(pi);
  return { entries, events, pi, context, view, renderers };
}

test("waiting rendering includes duration and reason, sanitizes controls, and fits narrow widths", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const h = harness();
  h.view.update(scheduled, h.context);
  assert.equal(h.entries.length, 1);
  const component = h.renderers.get("wakeup-wait")!(
    {
      type: "custom",
      id: "entry",
      parentId: null,
      timestamp: new Date(now).toISOString(),
      ...h.entries[0],
    },
    { expanded: false },
    { fg: (_color: string, text: string) => text } as Theme,
  )!;
  const text = component.render(100).join("\n");
  assert.match(text, /Waiting 5 min/);
  assert.match(text, /CI is still running/);
  assert.doesNotMatch(text, /unsafe-title|\x1b/);
  for (const width of [1, 12, 40]) {
    component.invalidate();
    assert.ok(
      component.render(width).every((line) => visibleWidth(line) <= width),
    );
  }
});

test("due-now rendering does not invent another minute of sleep", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: pending.dueAt });
  const h = harness();
  h.view.update(scheduled, h.context);
  const component = h.renderers.get("wakeup-wait")!(
    {
      type: "custom",
      id: "entry",
      parentId: null,
      timestamp: new Date(now).toISOString(),
      ...h.entries[0],
    },
    { expanded: false },
    { fg: (_color: string, text: string) => text } as Theme,
  )!;
  assert.match(component.render(100).join("\n"), /due now/);
});

test("clock labels include the date for another day and handle invalid history", () => {
  const old = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const sameDay = wakeupTime(Date.UTC(2026, 1, 1, 15, 5), now);
    const nextDay = wakeupTime(Date.UTC(2026, 1, 2, 15, 5), now);
    assert.match(sameDay, /UTC/);
    assert.match(nextDay, /UTC/);
    assert.ok(nextDay.length > sameDay.length);
    assert.equal(wakeupTime(NaN, now), "unknown time");
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});

test("display persistence and consumer failures cannot interrupt scheduler state updates", (t) => {
  const h = harness();
  t.mock.method(h.pi, "appendEntry", () => {
    throw new Error("fixture storage failure");
  });
  h.events.on("pi:wakeup-waiting", () => {
    throw new Error("fixture consumer failure");
  });
  assert.doesNotThrow(() => h.view.update(scheduled, h.context));
  assert.doesNotThrow(() =>
    h.view.update(
      { status: "cancelled", deadline: pending.deadline },
      h.context,
    ),
  );
});

for (const [minutes, label] of [
  [60, "1 h"],
  [3064, "2 d 3 h 4 min"],
  [10080, "7 d"],
] as const) {
  test(`long waiting notices display ${label} instead of raw minutes`, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now });
    const h = harness();
    h.view.update(
      { ...scheduled, pending: { ...pending, dueAt: now + minutes * 60_000 } },
      h.context,
    );
    const component = h.renderers.get("wakeup-wait")!(
      {
        type: "custom",
        id: "entry",
        parentId: null,
        timestamp: new Date(now).toISOString(),
        ...h.entries[0],
      },
      { expanded: false },
      { fg: (_color: string, text: string) => text } as Theme,
    )!;
    assert.ok(
      component
        .render(160)
        .join("\n")
        .includes(`Waiting ${label} · next check at`),
    );
  });
}

test("a first notice shown overdue preserves the original date instead of saying due now", (t) => {
  const old = process.env.TZ;
  process.env.TZ = "UTC";
  t.after(() => {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  });
  t.mock.timers.enable({ apis: ["Date"], now: now + 3 * 86_400_000 });
  const h = harness();
  h.view.update(scheduled, h.context);
  const component = h.renderers.get("wakeup-wait")!(
    {
      type: "custom",
      id: "entry",
      parentId: null,
      timestamp: new Date(now).toISOString(),
      ...h.entries[0],
    },
    { expanded: false },
    { fg: (_color: string, text: string) => text } as Theme,
  )!;
  const text = component.render(160).join("\n");
  assert.match(text, /overdue since/i);
  assert.match(text, /Feb 1/);
  assert.doesNotMatch(text, /due now/);
});

test("date labels disambiguate an overdue alarm from a previous year", () => {
  assert.match(wakeupTime(now, Date.UTC(2027, 1, 1)), /2026/);
});
