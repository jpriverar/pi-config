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
      "pi_context_warning",
      "pi_context_critical",
    ] as const) {
      const value = tokens[key] === null ? "" : normalizeMetadata(tokens[key]);
      args.push(
        ...(value ? ["--token", `${key}=${value}`] : ["--clear-token", key]),
      );
    }
    try {
      const { stdout } = await run(binary, args, {
        env,
        signal,
        timeout: 1500,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL",
        encoding: "utf8",
      });
      // Herdr 0.8's metadata CLI acknowledges success with exit 0 and no output.
      if (!stdout.trim()) return true;
      const reply = JSON.parse(stdout);
      return (
        !reply.error &&
        reply.result !== null &&
        typeof reply.result === "object" &&
        !Array.isArray(reply.result)
      );
    } catch {
      // Display delivery is best effort; the next meaningful event can retry.
      return false;
    }
  };
}
