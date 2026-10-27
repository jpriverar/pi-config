import {
  fields,
  findProject,
  type WorkCatalog,
  type WorkScope,
} from "./work-catalog/model.js";
import {
  decodeWorkScope,
  validateWorkScope,
  scopeKey,
} from "./work-catalog/membership.js";

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

export type ScopeResolution =
  | { kind: "resolved"; scope: WorkScope; source: SessionProjectSource }
  | { kind: "invalid"; reason: string };

export function resolveSessionWorkScope(
  session: SessionProjectReader,
  catalog: WorkCatalog,
): ScopeResolution {
  const entries = session.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isProjectEntry(entry)) continue;
    if (isRecord(entry.data) && entry.data.version === 2) {
      try {
        const data = fields(entry.data, ["version", "scope"]);
        return {
          kind: "resolved",
          scope: validateWorkScope(catalog, data.scope),
          source: "explicit",
        };
      } catch (error) {
        return {
          kind: "invalid",
          reason: error instanceof Error ? error.message : "Invalid work scope",
        };
      }
    }
    const data = decodeProjectData(entry.data);
    if (!data)
      return {
        kind: "invalid",
        reason: "Malformed project scope; select /area or /project",
      };
    return legacyScope(catalog, data.workstream, "explicit");
  }
  const name = session.getSessionName();
  return name === undefined || name === ""
    ? { kind: "resolved", scope: { kind: "global" }, source: "none" }
    : legacyScope(catalog, name, "legacy-display-name");
}
function legacyScope(
  catalog: WorkCatalog,
  name: string | null,
  source: SessionProjectSource,
): ScopeResolution {
  if (name === null)
    return { kind: "resolved", scope: { kind: "global" }, source };
  const project = findProject(catalog, name);
  return project
    ? {
        kind: "resolved",
        scope: { kind: "project", projectId: project.id },
        source,
      }
    : {
        kind: "invalid",
        reason: `Legacy project ${JSON.stringify(name.slice(0, 128))} is not registered; select /project`,
      };
}
export function persistSessionWorkScope(
  session: SessionProjectWriter,
  scope: WorkScope,
): void {
  session.appendCustomEntry(SESSION_PROJECT_ENTRY_TYPE, {
    version: 2,
    scope: decodeWorkScope(scope),
  });
}

export function hasCatalogSessionScope(
  session: Pick<SessionProjectReader, "getEntries">,
): boolean {
  return session
    .getEntries()
    .some(
      (entry) =>
        isProjectEntry(entry) &&
        isRecord(entry.data) &&
        entry.data.version === 2,
    );
}

export function latestSessionScopeEntry(
  session: Pick<SessionProjectReader, "getEntries">,
): CustomEntry | undefined {
  const entries = session.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    if (isProjectEntry(entries[index])) return entries[index] as CustomEntry;
  }
  return undefined;
}
export function sessionBrowseFingerprint(
  session: SessionProjectReader,
): string {
  return JSON.stringify(latestSessionScopeEntry(session) ?? null);
}

export function sessionScopeFingerprint(session: SessionProjectReader): string {
  const entry = latestSessionScopeEntry(session);
  return JSON.stringify(
    entry ? ["explicit", entry.data] : ["legacy", session.getSessionName()],
  );
}
export type SessionWorkSelection =
  | { kind: "catalog"; catalog: WorkCatalog; scope: WorkScope; key: string }
  | { kind: "legacy"; project: string | undefined; key: string | null };

export function resolveSessionSelection(
  session: SessionProjectReader,
  catalog: WorkCatalog | null,
): SessionWorkSelection {
  if (catalog?.state === "active") {
    const resolved = resolveSessionWorkScope(session, catalog);
    if (resolved.kind === "invalid") throw new Error(resolved.reason);
    return {
      kind: "catalog",
      catalog,
      scope: resolved.scope,
      key: scopeKey(resolved.scope),
    };
  }
  const entry = latestSessionScopeEntry(session);
  if (isRecord(entry?.data) && entry.data.version === 2)
    throw new Error(
      "Work scope requires an active catalog; do not fall back to the global view",
    );
  const project = resolveSessionProject(session).workstream;
  return { kind: "legacy", project, key: project?.toLowerCase() ?? null };
}
