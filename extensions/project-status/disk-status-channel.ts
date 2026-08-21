import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const DISK_STATUS_CHANNEL_KEY = Symbol.for(
  "jpriverar.pi.disk-guardian-status",
);

export interface DiskStatusSnapshot {
  text: string;
  color: Extract<ThemeColor, "dim" | "warning" | "error">;
}

export interface DiskStatusChannel {
  snapshot?: DiskStatusSnapshot;
  listeners: Set<() => void>;
}

export function getDiskStatusChannel(): DiskStatusChannel {
  const scope = globalThis as typeof globalThis & {
    [DISK_STATUS_CHANNEL_KEY]?: DiskStatusChannel;
  };
  return (scope[DISK_STATUS_CHANNEL_KEY] ??= { listeners: new Set() });
}
