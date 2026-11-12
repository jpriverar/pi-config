import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type WatchmanRunner = (args: string[]) => Promise<string>;

async function runWatchman(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "watchman",
    ["--no-spawn", "--no-local", "--output-encoding=json", ...args],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
  );
  return stdout;
}

export async function stopExactWatch(
  path: string,
  run: WatchmanRunner = runWatchman,
): Promise<void> {
  const command = async (args: string[]): Promise<Record<string, unknown>> => {
    try {
      const result: unknown = JSON.parse(await run(args));
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        "error" in result
      )
        throw new Error("invalid or error response");
      return result as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Watchman ${args[0]} failed for ${path}: ${String(error)}`,
      );
    }
  };
  const roots = async (): Promise<string[]> => {
    const result = await command(["watch-list"]);
    if (
      !Array.isArray(result.roots) ||
      !result.roots.every((root) => typeof root === "string")
    ) {
      throw new Error(`Watchman watch-list returned invalid roots for ${path}`);
    }
    return result.roots;
  };
  if (!(await roots()).includes(path)) return;
  const result = await command(["watch-del", path]);
  if (result.root !== path || result["watch-del"] !== true) {
    throw new Error(
      `Watchman did not confirm deleting the exact watch for ${path}`,
    );
  }
  if ((await roots()).includes(path)) {
    throw new Error(`Watchman still watches ${path} after watch-del`);
  }
}
