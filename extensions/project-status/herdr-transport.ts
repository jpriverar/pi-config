import { execFile } from "node:child_process";

import { normalizeMetadata, type PaneTokens } from "./herdr-values.js";

export type MetadataSender = (
  tokens: PaneTokens,
  sequence: number,
  signal: AbortSignal,
) => Promise<boolean>;

type Execute = (
  command: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    signal: AbortSignal;
    killSignal: "SIGKILL";
    encoding: "utf8";
  },
) => Promise<{ stdout: string }>;

const execute: Execute = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });

export function createHerdrMetadataSender(
  environment: NodeJS.ProcessEnv,
  run: Execute = execute,
): MetadataSender | undefined {
  const env = { ...environment };
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !pane || !env.HERDR_SOCKET_PATH)
    return undefined;
  const binary = env.HERDR_BIN_PATH || "herdr";
  let refreshedAssignment: string | undefined;
  return async (tokens, sequence, signal) => {
    if (signal.aborted) return false;
    const args = [
      "pane",
      "report-metadata",
      pane,
      "--source",
      "jp:pi-sidebar",
      "--seq",
      String(sequence),
    ];
    for (const key of [
      "pi_model",
      "pi_task",
      "pi_task_state",
      "pi_task_id",
      "pi_task_expires_at",
      "pi_context_warning",
      "pi_context_critical",
    ] as const) {
      const value = tokens[key] === null ? "" : normalizeMetadata(tokens[key]);
      args.push(
        ...(value ? ["--token", `${key}=${value}`] : ["--clear-token", key]),
      );
    }
    try {
      const options = {
        env,
        signal,
        timeout: 1500,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL" as const,
        encoding: "utf8" as const,
      };
      const { stdout } = await run(binary, args, options);
      // Herdr 0.8's metadata CLI acknowledges success with exit 0 and no output.
      if (stdout.trim()) {
        const reply = JSON.parse(stdout);
        if (
          reply.error ||
          reply.result === null ||
          typeof reply.result !== "object" ||
          Array.isArray(reply.result)
        )
          return false;
      }
      const assignment = JSON.stringify([
        tokens.pi_task_state,
        tokens.pi_task_id,
        tokens.pi_task_expires_at,
      ]);
      if (assignment === refreshedAssignment) return true;

      // Do not rely on metadata-change hooks to refresh the optional plugin.
      const listed = JSON.parse(
        (await run(binary, ["plugin", "list", "--json"], options)).stdout,
      );
      const plugins = listed.result?.plugins;
      if (listed.error || !Array.isArray(plugins)) return false;
      const plugin = plugins.find(
        (entry) => entry?.plugin_id === "jp.space-tabs",
      );
      if (plugin && typeof plugin.enabled !== "boolean") return false;
      if (plugin?.enabled) {
        const invoked = JSON.parse(
          (
            await run(
              binary,
              ["plugin", "action", "invoke", "jp.space-tabs.refresh"],
              options,
            )
          ).stdout,
        );
        if (invoked.error || invoked.result?.type !== "plugin_action_invoked")
          return false;
      }
      refreshedAssignment = assignment;
      return true;
    } catch {
      // Display delivery is best effort; the next meaningful event can retry.
      return false;
    }
  };
}
