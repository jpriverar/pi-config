import { spawn } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import type { BeadsExecResult } from "../beads.js";
import { DEFAULT_DAEMON_LIMITS } from "./config.js";

export type CommandFailureReason =
  | "spawn_failed"
  | "timeout"
  | "aborted"
  | "output_limit"
  | "output_pipe_retained";

export class CommandExecutionError extends Error {
  constructor(
    file: string,
    readonly reason: CommandFailureReason,
  ) {
    super(
      `command ${basename(file)} failed (${reason}); its result may be unknown`,
    );
    this.name = "CommandExecutionError";
  }
}

export async function runBoundedCommand(
  file: string,
  args: readonly string[],
  options: {
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
): Promise<BeadsExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_LIMITS.commandTimeoutMs;
  const maxOutputBytes =
    options.maxOutputBytes ?? DEFAULT_DAEMON_LIMITS.maxOutputBytes;
  for (const [name, value] of Object.entries({ timeoutMs, maxOutputBytes })) {
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647)
      throw new Error(`${name} must be a positive bounded integer`);
  }
  if (!isAbsolute(file)) throw new Error("command path must be absolute");
  if (options.signal?.aborted) throw new CommandExecutionError(file, "aborted");

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: false,
      });
    } catch {
      reject(new CommandExecutionError(file, "spawn_failed"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let exited = false;
    let settled = false;
    let exitCode = 1;
    let failure: CommandFailureReason | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let commandTimer: NodeJS.Timeout | undefined;
    const onAbort = () => terminate("aborted");

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(commandTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (failure !== undefined)
        reject(new CommandExecutionError(file, failure));
      else
        resolve({
          code: exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    }

    function terminate(reason: CommandFailureReason): void {
      if (settled) return;
      failure ??= reason;
      if (exited) {
        finish();
        return;
      }
      if (killTimer !== undefined) return;
      killTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 250);
      child.kill("SIGTERM");
    }

    function capture(target: Buffer[], data: Buffer): void {
      if (failure !== undefined || settled) return;
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        terminate("output_limit");
        return;
      }
      target.push(data);
    }
    child.stdout?.on("data", (data: Buffer) => capture(stdout, data));
    child.stderr?.on("data", (data: Buffer) => capture(stderr, data));
    child.on("error", () => {
      if (child.pid === undefined) {
        failure = "spawn_failed";
        finish();
      } else terminate("spawn_failed");
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code ?? 1;
      clearTimeout(killTimer);
      if (failure !== undefined) {
        finish();
        return;
      }
      // Descendants can retain pipes after the direct child has been reaped.
      drainTimer = setTimeout(() => terminate("output_pipe_retained"), 250);
    });
    child.on("close", () => {
      if (exited) finish();
    });
    commandTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
