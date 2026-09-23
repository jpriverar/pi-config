import assert from "node:assert/strict";
import { describe, test } from "node:test";

import sessionClearExtension from "./index.js";

type Entry = {
  type: string;
  customType?: string;
  data?: unknown;
};

type SessionAction =
  | { type: "custom"; customType: string; data: unknown }
  | { type: "session_info"; name: string };

type SessionManager = {
  getEntries(): Entry[];
  getSessionId(): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo(name: string): string;
};

type NewSessionOptions = {
  setup?: (sessionManager: SessionManager) => Promise<void>;
};

type CommandContext = {
  sessionManager: SessionManager;
  newSession(options?: NewSessionOptions): Promise<{ cancelled: boolean }>;
};

type Command = {
  description: string;
  handler(args: string, ctx: CommandContext): Promise<void>;
};

function manager(
  entries: Entry[],
  sessionId: string,
  actions: SessionAction[] = [],
): SessionManager {
  return {
    getEntries: () => entries,
    getSessionId: () => sessionId,
    appendCustomEntry(customType, data) {
      actions.push({ type: "custom", customType, data });
      return `entry-${actions.length}`;
    },
    appendSessionInfo(name) {
      actions.push({ type: "session_info", name });
      return `entry-${actions.length}`;
    },
  };
}

function harness(
  entries: Entry[],
  newSessionIds = ["12345678-aaaa-bbbb-cccc-000000000000"],
) {
  const commands = new Map<string, Command>();
  const newSessionCalls: Array<NewSessionOptions | undefined> = [];
  const sessions: SessionAction[][] = [];
  let nextSession = 0;
  let cancelled = false;

  sessionClearExtension({
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
  });

  const ctx: CommandContext = {
    sessionManager: manager(entries, "old-session"),
    async newSession(options) {
      newSessionCalls.push(options);
      if (cancelled) return { cancelled: true };
      const actions: SessionAction[] = [];
      sessions.push(actions);
      const sessionId = newSessionIds[nextSession++] ?? newSessionIds.at(-1)!;
      await options?.setup?.(manager([], sessionId, actions));
      return { cancelled: false };
    },
  };

  return {
    commands,
    newSessionCalls,
    sessions,
    setCancelled(value: boolean) {
      cancelled = value;
    },
    async clear() {
      await commands.get("clear")!.handler("", ctx);
    },
  };
}

describe("/clear", () => {
  test("registers the project-preserving command", () => {
    const h = harness([]);

    assert.deepEqual([...h.commands.keys()], ["clear"]);
    assert.match(h.commands.get("clear")!.description, /current workstream/);
  });

  test("transfers only the latest project scope and derives a fresh name", async () => {
    const oldScope = {
      version: 1,
      workstream: "old-project",
      nested: { keep: false },
    };
    const latestScope = {
      version: 2,
      workstream: "payments",
      nested: { keep: true },
    };
    const h = harness([
      {
        type: "custom",
        customType: "jp-work-startup",
        data: { stale: true },
      },
      {
        type: "custom",
        customType: "jp-project-scope",
        data: oldScope,
      },
      {
        type: "custom_message",
        customType: "jp-work",
        data: { stale: true },
      },
      {
        type: "custom",
        customType: "jp-project-scope",
        data: latestScope,
      },
      { type: "session_info", data: { name: "stale-name" } },
    ]);

    await h.clear();

    assert.deepEqual(h.sessions, [
      [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: latestScope,
        },
        { type: "session_info", name: "payments-12345678" },
      ],
    ]);
    assert.notEqual((h.sessions[0][0] as { data: unknown }).data, latestScope);
  });

  test("uses each replacement session ID in the derived name", async () => {
    const h = harness(
      [
        {
          type: "custom",
          customType: "jp-project-scope",
          data: { version: 1, workstream: "payments" },
        },
      ],
      [
        "11111111-aaaa-bbbb-cccc-000000000000",
        "22222222-aaaa-bbbb-cccc-000000000000",
      ],
    );

    await h.clear();
    await h.clear();

    assert.deepEqual(
      h.sessions.map((actions) => actions[1]),
      [
        { type: "session_info", name: "payments-11111111" },
        { type: "session_info", name: "payments-22222222" },
      ],
    );
  });

  test("delegates exactly to newSession when no project scope exists", async () => {
    const h = harness([
      {
        type: "custom",
        customType: "jp-work-startup",
        data: { stale: true },
      },
    ]);

    await h.clear();

    assert.deepEqual(h.newSessionCalls, [undefined]);
    assert.deepEqual(h.sessions, [[]]);
  });

  test("does not run setup when session replacement is cancelled", async () => {
    const h = harness([
      {
        type: "custom",
        customType: "jp-project-scope",
        data: { version: 1, workstream: "payments" },
      },
    ]);
    h.setCancelled(true);

    await h.clear();

    assert.equal(typeof h.newSessionCalls[0]?.setup, "function");
    assert.deepEqual(h.sessions, []);
  });
});
