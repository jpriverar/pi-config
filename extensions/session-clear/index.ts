import {
  SESSION_PROJECT_ENTRY_TYPE,
  latestSessionScopeEntry,
  hasCatalogSessionScope,
  persistSessionWorkScope,
} from "../../lib/session-project.js";

import { workingIdentityName } from "../../lib/session-identity.js";

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
      "Start an empty, unassigned catalog session; preserve legacy workstream behavior",
    async handler(_args, ctx) {
      if (hasCatalogSessionScope(ctx.sessionManager)) {
        await ctx.newSession({
          async setup(sessionManager) {
            persistSessionWorkScope(sessionManager, { kind: "global" });
            sessionManager.appendSessionInfo(
              workingIdentityName({ kind: "unassigned" }, sessionManager)!,
            );
          },
        });
        return;
      }
      const scope = latestSessionScopeEntry(ctx.sessionManager);
      if (!scope) {
        await ctx.newSession();
        return;
      }

      const data = structuredClone(scope.data);
      await ctx.newSession({
        async setup(sessionManager) {
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
