import {
  SESSION_PROJECT_ENTRY_TYPE,
  latestSessionScopeEntry,
  sessionDisplayNameBase,
  generateSessionProjectName,
} from "../../lib/session-project.js";

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

type SessionManager = {
  getEntries(): SessionEntry[];
  getSessionId(): string;
  getSessionName?(): string | undefined;
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
      const scope = latestSessionScopeEntry(ctx.sessionManager);
      if (!scope) {
        await ctx.newSession();
        return;
      }

      const data = structuredClone(scope.data);
      const value = data as
        | { version?: unknown; scope?: { kind?: unknown } }
        | null
        | undefined;
      const scoped =
        value?.version === 2 &&
        (value.scope?.kind === "area" || value.scope?.kind === "project");
      const base = scoped
        ? sessionDisplayNameBase({
            getSessionId: () => ctx.sessionManager.getSessionId(),
            getSessionName: () => ctx.sessionManager.getSessionName?.(),
          })
        : undefined;
      await ctx.newSession({
        async setup(sessionManager) {
          sessionManager.appendCustomEntry(SESSION_PROJECT_ENTRY_TYPE, data);

          const workstream = scopeWorkstream(data);
          if (workstream) {
            sessionManager.appendSessionInfo(
              `${workstream}-${sessionManager.getSessionId().slice(0, 8)}`,
            );
          } else if (base) {
            sessionManager.appendSessionInfo(
              generateSessionProjectName(sessionManager, base),
            );
          }
        },
      });
    },
  });
}
