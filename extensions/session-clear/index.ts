import {
  SESSION_PROJECT_ENTRY_TYPE,
  latestSessionScopeEntry,
  hasCatalogSessionScope,
  persistSessionWorkScope,
} from "../../lib/session-project.js";

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

type SessionManager = {
  getEntries(): SessionEntry[];
  appendCustomEntry(customType: string, data?: unknown): string;
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

export default function sessionClearExtension(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description:
      "Start an empty, unassigned catalog session; preserve legacy workstream behavior",
    async handler(_args, ctx) {
      if (hasCatalogSessionScope(ctx.sessionManager)) {
        await ctx.newSession({
          async setup(sessionManager) {
            persistSessionWorkScope(sessionManager, { kind: "global" });
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
        },
      });
    },
  });
}
