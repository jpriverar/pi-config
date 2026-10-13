import { validateProjectName } from "./project-renames.js";

export const PROJECT_ARCHIVES_CONFIG_KEY = "custom.pi-project-archives";

export interface ProjectArchiveRegistry {
  version: 1;
  archived: string[];
}

export function decodeProjectArchiveRegistry(
  value: unknown,
): ProjectArchiveRegistry {
  if (value === undefined || value === "") return { version: 1, archived: [] };
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.archived) ||
    parsed.archived.some(
      (name: unknown) =>
        typeof name !== "string" ||
        !validateProjectName(name).ok ||
        name !== name.toLowerCase(),
    )
  ) {
    throw new Error("invalid project archive registry");
  }
  return { version: 1, archived: [...new Set<string>(parsed.archived)].sort() };
}

export function encodeProjectArchiveRegistry(
  registry: ProjectArchiveRegistry,
): string {
  return JSON.stringify(decodeProjectArchiveRegistry(registry));
}
