import { readFileSync } from "node:fs";

export interface LifecycleConfig {
  version: 1;
  executionTimeoutMs: number;
  activityWriteIntervalMs: number;
  sessionReconcileLimit: number;
  sessionPrCheckLimit: number;
  prPollIntervalMs: number;
  maxBackoffMs: number;
  warningErrorCount: number;
}

export function loadLifecycleConfig(path: string): LifecycleConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`cannot read task lifecycle config JSON at ${path}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task lifecycle config must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys: Array<keyof LifecycleConfig> = [
    "version",
    "executionTimeoutMs",
    "activityWriteIntervalMs",
    "sessionReconcileLimit",
    "sessionPrCheckLimit",
    "prPollIntervalMs",
    "maxBackoffMs",
    "warningErrorCount",
  ];
  if (record.version !== 1) {
    throw new Error("task lifecycle config version must be 1");
  }
  for (const key of keys.slice(1)) {
    if (!Number.isInteger(record[key]) || (record[key] as number) <= 0) {
      throw new Error(
        `task lifecycle config ${key} must be a positive integer`,
      );
    }
  }
  for (const key of Object.keys(record)) {
    if (!keys.includes(key as keyof LifecycleConfig)) {
      throw new Error(`task lifecycle config has unknown field ${key}`);
    }
  }
  return record as unknown as LifecycleConfig;
}
