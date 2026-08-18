export const SESSION_PROJECT_ENTRY_TYPE = "jp-project-scope";

export interface SessionProjectReader {
  getEntries(): readonly unknown[];
  getSessionName(): string | undefined;
}

export interface SessionProjectWriter {
  appendCustomEntry(customType: string, data: unknown): unknown;
}

export interface SessionProjectIdentity {
  getSessionId(): string;
}

export type SessionProjectSource =
  | "explicit"
  | "legacy-display-name"
  | "malformed-explicit"
  | "none";

export interface ResolvedSessionProject {
  workstream: string | undefined;
  source: SessionProjectSource;
}

export interface SessionProjectData {
  version: 1;
  workstream: string | null;
}

interface CustomEntry {
  type: "custom";
  customType: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProjectEntry(value: unknown): value is CustomEntry {
  return (
    isRecord(value) &&
    value.type === "custom" &&
    value.customType === SESSION_PROJECT_ENTRY_TYPE
  );
}

function decodeProjectData(value: unknown): SessionProjectData | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (value.workstream === null) {
    return { version: 1, workstream: null };
  }
  if (typeof value.workstream !== "string" || value.workstream.length === 0) {
    return undefined;
  }
  return { version: 1, workstream: value.workstream };
}

export function resolveSessionProject(
  session: SessionProjectReader,
): ResolvedSessionProject {
  const entries = session.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isProjectEntry(entry)) continue;

    const data = decodeProjectData(entry.data);
    if (!data) {
      return { workstream: undefined, source: "malformed-explicit" };
    }
    return {
      workstream: data.workstream ?? undefined,
      source: "explicit",
    };
  }

  const workstream = session.getSessionName();
  if (workstream !== undefined) {
    return { workstream, source: "legacy-display-name" };
  }
  return { workstream: undefined, source: "none" };
}

export function persistSessionProject(
  session: SessionProjectWriter,
  workstream: string | null,
): void {
  session.appendCustomEntry(SESSION_PROJECT_ENTRY_TYPE, {
    version: 1,
    workstream,
  } satisfies SessionProjectData);
}

export function generateSessionProjectName(
  session: SessionProjectIdentity,
  workstream: string,
): string {
  const normalizedId = session
    .getSessionId()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const suffix = normalizedId.slice(-8);
  return suffix ? `${workstream}-${suffix}` : workstream;
}
