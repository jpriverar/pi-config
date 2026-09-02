import { statfs as readStatfs } from "node:fs/promises";
import { homedir } from "node:os";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const GiB = 1024n ** 3n;
const STATUS_KEY = "disk-space";
const POLL_INTERVAL_MILLISECONDS = 60_000;
const WARNING_FREE_BYTES = 150n * GiB;
const ERROR_FREE_BYTES = 80n * GiB;

type DiskSpaceDependencies = {
  homePath: string;
  statfs(path: string): Promise<{ bavail: bigint; bsize: bigint }>;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
};

const runtimeDependencies: DiskSpaceDependencies = {
  homePath: homedir(),
  async statfs(path) {
    const stats = await readStatfs(path, { bigint: true });
    return { bavail: stats.bavail, bsize: stats.bsize };
  },
  setInterval,
  clearInterval,
};

function formatFreeGiB(freeBytes: bigint): string {
  const wholeGiB = freeBytes / GiB;
  const tenths = ((freeBytes % GiB) * 10n) / GiB;
  return tenths === 0n ? `${wholeGiB}G` : `${wholeGiB}.${tenths}G`;
}

export default function diskSpaceStatus(
  pi: ExtensionAPI,
  deps: DiskSpaceDependencies = runtimeDependencies,
): void {
  let sessionContext: ExtensionContext | undefined;
  let pollTimer: unknown;
  let activeGeneration = 0;

  async function sampleAndPublish(generation: number): Promise<void> {
    try {
      const stats = await deps.statfs(deps.homePath);
      if (generation !== activeGeneration) return;
      const freeBytes = stats.bavail * stats.bsize;
      const color =
        freeBytes >= WARNING_FREE_BYTES
          ? "dim"
          : freeBytes >= ERROR_FREE_BYTES
            ? "warning"
            : "error";
      const text = `disk ${formatFreeGiB(freeBytes)}`;
      sessionContext?.ui.setStatus(
        STATUS_KEY,
        sessionContext.ui.theme.fg(color, text),
      );
    } catch {
      if (generation !== activeGeneration) return;
      sessionContext?.ui.setStatus(
        STATUS_KEY,
        sessionContext.ui.theme.fg("error", "disk ?"),
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (pollTimer) {
      deps.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    sessionContext = ctx;
    activeGeneration += 1;
    const generation = activeGeneration;
    await sampleAndPublish(generation);
    if (generation !== activeGeneration) return;
    pollTimer = deps.setInterval(() => {
      void sampleAndPublish(generation);
    }, POLL_INTERVAL_MILLISECONDS);
    (pollTimer as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    activeGeneration += 1;
    sessionContext = undefined;
    if (pollTimer) {
      deps.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });
}
