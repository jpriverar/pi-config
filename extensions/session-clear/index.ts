import { SESSION_PROJECT_ENTRY_TYPE } from "../../lib/session-project.js";

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

type SessionManager = {
  getEntries(): SessionEntry[];
  getSessionId(): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo(name: string): string;
};

type CommandContext = {
  sessionManager: SessionManager;
  newSession(options?: {
    setup?: (sessionManager: SessionManager) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;
};

type ExtensionAPI = {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: CommandContext): Promise<void>;
    },
  ): void;
};

function latestProjectScope(entries: SessionEntry[]): SessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === SESSION_PROJECT_ENTRY_TYPE
    ) {
      return entry;
    }
  }
  return undefined;
}

function scopeWorkstream(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const workstream = (data as Record<string, unknown>).workstream;
  return typeof workstream === "string" && workstream.length > 0
    ? workstream
    : undefined;
}

export default function sessionClearExtension(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description:
      "Start an empty session while preserving the current workstream",
    async handler(_args, ctx) {
      const scope = latestProjectScope(ctx.sessionManager.getEntries());
      if (!scope) {
        await ctx.newSession();
        return;
      }

      await ctx.newSession({
        async setup(sessionManager) {
          const data = structuredClone(scope.data);
          sessionManager.appendCustomEntry(SESSION_PROJECT_ENTRY_TYPE, data);

          const workstream = scopeWorkstream(data);
          if (workstream) {
            sessionManager.appendSessionInfo(
              `${workstream}-${sessionManager.getSessionId().slice(0, 8)}`,
            );
          }
        },
      });
    },
  });
}
