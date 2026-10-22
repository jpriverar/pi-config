import { readFileSync } from "node:fs";
import { normalizeBeadsLabel } from "../beads.js";
import { isAbsolute, join } from "node:path";
import {
  decodeTarget,
  record,
  type WorkManagementConfig,
  type WorkManagementTarget,
} from "./model.js";

export function canonicalWorkstream(value: string): string {
  const prefix = "workstream:";
  return normalizeBeadsLabel(prefix + value)
    .slice(prefix.length)
    .toLowerCase();
}

export function loadWorkManagementConfig(
  storePath: string,
): WorkManagementConfig | null {
  const path = join(storePath, "pi-work-management.json");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read work management configuration at ${path}`);
  }
  try {
    return decodeWorkManagementConfig(JSON.parse(content));
  } catch {
    throw new Error(`invalid work management configuration at ${path}`);
  }
}

export function decodeWorkManagementConfig(
  value: unknown,
): WorkManagementConfig {
  const r = record(value);
  const executable = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !isAbsolute(value) ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new Error("invalid executable path");
    return value;
  };
  if (r.version === 2) {
    if (
      r.routingMode !== "catalog" ||
      Object.keys(r).some(
        (key) =>
          !["version", "routingMode", "ddAuthPath", "curlPath"].includes(key),
      )
    )
      throw new Error("invalid catalog config schema");
    return {
      version: 2,
      routingMode: "catalog",
      ddAuthPath: executable(r.ddAuthPath),
      curlPath: executable(r.curlPath),
    };
  }
  if (
    r.version !== 1 ||
    Object.keys(r).some(
      (key) =>
        ![
          "version",
          "ddAuthPath",
          "curlPath",
          "defaultTarget",
          "workstreams",
        ].includes(key),
    )
  )
    throw new Error("invalid config schema");
  const workstreams: Record<string, WorkManagementTarget | null> =
    Object.create(null);
  for (const [name, target] of Object.entries(record(r.workstreams))) {
    const key = canonicalWorkstream(name);
    if (
      !key.trim() ||
      /[\u0000-\u001f\u007f,]/.test(name) ||
      Object.hasOwn(workstreams, key)
    )
      throw new Error("invalid or duplicate workstream");
    workstreams[key] = target === null ? null : decodeTarget(target);
  }
  return {
    version: 1,
    ddAuthPath: executable(r.ddAuthPath),
    curlPath: executable(r.curlPath),
    ...(Object.hasOwn(r, "defaultTarget")
      ? { defaultTarget: decodeTarget(r.defaultTarget) }
      : {}),
    workstreams,
  };
}
