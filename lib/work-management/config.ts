import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  decodeTarget,
  record,
  type WorkManagementConfig,
  type WorkManagementTarget,
} from "./model.js";

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
    const r = record(JSON.parse(content));
    if (
      r.version !== 1 ||
      Object.keys(r).some(
        (k) =>
          !["version", "ddAuthPath", "curlPath", "workstreams"].includes(k),
      )
    )
      throw new Error("invalid config schema");
    const executable = (value: unknown) => {
      if (
        typeof value !== "string" ||
        !isAbsolute(value) ||
        /[\u0000-\u001f\u007f]/.test(value)
      )
        throw new Error("invalid executable path");
      return value;
    };
    const workstreams: Record<string, WorkManagementTarget> =
      Object.create(null);
    for (const [name, target] of Object.entries(record(r.workstreams))) {
      const key = name.toLowerCase();
      if (
        !key.trim() ||
        /[\u0000-\u001f\u007f,]/.test(key) ||
        Object.hasOwn(workstreams, key)
      )
        throw new Error("invalid or duplicate workstream");
      workstreams[key] = decodeTarget(target);
    }
    return {
      version: 1,
      ddAuthPath: executable(r.ddAuthPath),
      curlPath: executable(r.curlPath),
      workstreams,
    };
  } catch {
    throw new Error(`invalid work management configuration at ${path}`);
  }
}
