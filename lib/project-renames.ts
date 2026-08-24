import { normalizeBeadsLabel } from "./beads.js";

export const PROJECT_RENAMES_CONFIG_KEY = "custom.pi-project-renames";

const WORKSTREAM_LABEL_PREFIX = "workstream:";
const MAX_WORKSTREAM_NAME_LENGTH = 128 - WORKSTREAM_LABEL_PREFIX.length;

export interface ProjectRenameRegistry {
  version: 1;
  aliases: Record<string, string>;
}

function freezeRegistry(
  registry: ProjectRenameRegistry,
): ProjectRenameRegistry {
  return Object.freeze({
    version: 1,
    aliases: Object.freeze({ ...registry.aliases }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeParsedRegistry(value: unknown): ProjectRenameRegistry {
  if (!isRecord(value)) {
    throw new Error("rename registry must be an object");
  }
  if (value.version !== 1) {
    throw new Error("unsupported registry version");
  }
  if (!isRecord(value.aliases)) {
    throw new Error("rename registry aliases must be an object");
  }

  const aliases: Record<string, string> = {};
  for (const [key, target] of Object.entries(value.aliases)) {
    const validatedKey = validateProjectName(key);
    if (
      !validatedKey.ok ||
      validatedKey.value !== validatedKey.value.toLowerCase()
    ) {
      throw new Error("alias keys must be lowercase valid project names");
    }

    if (typeof target !== "string") {
      throw new Error(`invalid alias target for ${key}`);
    }
    const validatedTarget = validateProjectName(target);
    if (!validatedTarget.ok) {
      throw new Error(
        `invalid alias target for ${key}: ${validatedTarget.message}`,
      );
    }

    aliases[validatedKey.value] = validatedTarget.value;
  }

  return freezeRegistry({ version: 1, aliases });
}

export function emptyProjectRenameRegistry(): ProjectRenameRegistry {
  return freezeRegistry({ version: 1, aliases: {} });
}

export function decodeProjectRenameRegistry(
  value: unknown,
): ProjectRenameRegistry {
  if (value === undefined || value === "") {
    return emptyProjectRenameRegistry();
  }
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("rename registry must be valid JSON");
    }
    return decodeParsedRegistry(parsed);
  }
  return decodeParsedRegistry(value);
}

export function encodeProjectRenameRegistry(
  registry: ProjectRenameRegistry,
): string {
  return JSON.stringify(decodeParsedRegistry(registry));
}

export function resolveProjectRename(
  registry: ProjectRenameRegistry,
  workstream: string,
): string | undefined {
  const visited = new Set<string>();
  let currentKey = workstream.toLowerCase();
  let resolved: string | undefined;

  while (true) {
    const next = registry.aliases[currentKey];
    if (next === undefined) {
      return resolved;
    }

    const nextKey = next.toLowerCase();
    if (nextKey === currentKey) {
      return next;
    }
    if (visited.has(nextKey)) {
      return undefined;
    }

    visited.add(currentKey);
    resolved = next;
    currentKey = nextKey;
  }
}

export function recordProjectRename(
  registry: ProjectRenameRegistry,
  from: string,
  to: string,
): ProjectRenameRegistry {
  const validatedFrom = validateProjectName(from);
  if (!validatedFrom.ok) {
    throw new Error(validatedFrom.message);
  }

  const validatedTo = validateProjectName(to);
  if (!validatedTo.ok) {
    throw new Error(validatedTo.message);
  }

  const aliases = { ...registry.aliases };
  delete aliases[validatedTo.value.toLowerCase()];

  const canonicalTarget =
    resolveProjectRename({ version: 1, aliases }, validatedTo.value) ??
    validatedTo.value;
  aliases[validatedFrom.value.toLowerCase()] = canonicalTarget;

  return freezeRegistry({ version: 1, aliases });
}

export function validateProjectName(
  input: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const next = input.trim();
  if (!next) {
    return { ok: false, message: "Project name cannot be empty" };
  }
  if (input !== next) {
    return {
      ok: false,
      message:
        "Project name contains unsupported whitespace or control characters",
    };
  }
  if (next.includes(",")) {
    return { ok: false, message: "Project name must not contain commas" };
  }
  if ([...next].length > MAX_WORKSTREAM_NAME_LENGTH) {
    return {
      ok: false,
      message: `Project name must be ${MAX_WORKSTREAM_NAME_LENGTH} characters or fewer`,
    };
  }

  const expectedLabel = `${WORKSTREAM_LABEL_PREFIX}${next}`;
  if (
    normalizeBeadsLabel(`${WORKSTREAM_LABEL_PREFIX}${input}`) !== expectedLabel
  ) {
    return {
      ok: false,
      message:
        "Project name contains unsupported whitespace or control characters",
    };
  }

  return { ok: true, value: next };
}
