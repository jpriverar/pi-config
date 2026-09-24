import { existsSync } from "node:fs";

import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  generateSessionProjectName,
  persistSessionProject,
  resolveSessionProject,
} from "../../lib/session-project.js";

const USAGE = "Usage: /herdr-clone [vertical|v|horizontal|h]";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function herdr(
  pi: ExtensionAPI,
  args: string[],
  timeout: number,
): Promise<Record<string, unknown>> {
  const result = await pi.exec("herdr", args, { timeout });
  const operation = `herdr ${args.slice(0, 2).join(" ")}`;
  if (result.killed || result.code !== 0) {
    throw new Error(
      `${operation} failed${result.killed ? " (timed out)" : ""}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${operation} returned invalid JSON: ${result.stdout.slice(0, 300)}`,
    );
  }
  if (record(response) && record(response.error)) {
    throw new Error(
      `${operation}: ${response.error.code}: ${response.error.message}`,
    );
  }
  if (!record(response) || !record(response.result)) {
    throw new Error(`${operation} returned no result`);
  }
  return response.result;
}

export default function herdrCloneExtension(pi: ExtensionAPI): void {
  let launching = false;

  pi.registerCommand("herdr-clone", {
    description:
      "Clone this conversation into a new Herdr pane (vertical/v or horizontal/h)",
    async handler(args, ctx) {
      const directionArg = args.trim().toLowerCase();
      const direction = ["", "vertical", "v"].includes(directionArg)
        ? "right"
        : ["horizontal", "h"].includes(directionArg)
          ? "down"
          : undefined;
      if (!direction) {
        ctx.ui.notify(`${USAGE}; received ${JSON.stringify(args)}`, "error");
        return;
      }
      const sourcePane = process.env.HERDR_PANE_ID;
      if (
        ctx.mode !== "tui" ||
        process.env.HERDR_ENV !== "1" ||
        !sourcePane ||
        !process.env.HERDR_SOCKET_PATH
      ) {
        ctx.ui.notify(
          "/herdr-clone requires an interactive Pi session inside Herdr.",
          "error",
        );
        return;
      }
      if (launching) {
        ctx.ui.notify(
          "A Herdr clone launch is already in progress.",
          "warning",
        );
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Wait for the agent and queued messages to finish before cloning.",
          "warning",
        );
        return;
      }
      const sourceFile = ctx.sessionManager.getSessionFile();
      const leaf = ctx.sessionManager.getLeafId();
      if (!sourceFile || !existsSync(sourceFile) || !leaf) {
        ctx.ui.notify(
          "/herdr-clone requires a saved, non-empty session.",
          "error",
        );
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("Select a model before cloning the session.", "error");
        return;
      }

      const { provider, id: modelId } = ctx.model;
      const thinkingLevel = pi.getThinkingLevel();
      launching = true;
      let sessionFile: string | undefined;
      let paneId: string | undefined;
      try {
        // ctx.fork replaces the source runtime; a separate manager leaves it intact.
        const clone = SessionManager.open(
          sourceFile,
          ctx.sessionManager.getSessionDir(),
          ctx.cwd,
        );
        if (
          !clone
            .getBranch(leaf)
            .some(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            )
        ) {
          throw new Error(
            "Wait for the first assistant response on this branch before cloning.",
          );
        }
        sessionFile = clone.createBranchedSession(leaf);
        if (!sessionFile || !existsSync(sessionFile)) {
          throw new Error(`Could not save a clone of ${sourceFile}`);
        }
        const project = resolveSessionProject(clone);
        const nameBase = project.workstream ?? clone.getSessionName();
        if (nameBase) {
          // Legacy names double as project scope; pin it before renaming.
          if (project.source === "legacy-display-name") {
            persistSessionProject(clone, project.workstream ?? null);
          }
          clone.appendSessionInfo(generateSessionProjectName(clone, nameBase));
        }

        const split = await herdr(
          pi,
          [
            "pane",
            "split",
            sourcePane,
            "--direction",
            direction,
            "--cwd",
            ctx.cwd,
            "--focus",
          ],
          5000,
        );
        if (
          !record(split.pane) ||
          typeof split.pane.pane_id !== "string" ||
          !split.pane.pane_id
        ) {
          throw new Error(
            "herdr pane split returned no pane ID; inspect Herdr before retrying.",
          );
        }
        paneId = split.pane.pane_id;
        // Herdr limits aliases to 32 characters; keep the UUID's random suffix.
        const agentName = `pi-${clone.getSessionId().replaceAll("-", "").slice(-24)}`;
        const started = await herdr(
          pi,
          [
            "agent",
            "start",
            agentName,
            "--kind",
            "pi",
            "--pane",
            paneId,
            "--timeout",
            "30000",
            "--",
            "--session",
            sessionFile,
            "--provider",
            provider,
            "--model",
            modelId,
            "--thinking",
            thinkingLevel,
          ],
          45000,
        );
        if (!record(started.agent) || started.agent.pane_id !== paneId) {
          throw new Error(
            `herdr agent start did not confirm Pi in pane ${paneId}`,
          );
        }
        ctx.ui.notify(
          `Cloned session into Herdr pane ${paneId}. Same directory; use separate worktrees before concurrent edits.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const recovery = [
          sessionFile && `Saved clone: ${sessionFile}`,
          paneId && `Pane: ${paneId}`,
          sessionFile &&
            "Inspect existing panes before retrying; nothing was automatically removed or retried.",
        ]
          .filter(Boolean)
          .join("\n");
        ctx.ui.notify(
          `Herdr clone failed: ${message}${recovery ? `\n${recovery}` : ""}`,
          "error",
        );
      } finally {
        launching = false;
      }
    },
  });
}
