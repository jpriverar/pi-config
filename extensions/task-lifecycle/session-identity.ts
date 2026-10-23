import {
  workingIdentityName,
  type WorkingIdentity,
} from "../../lib/session-identity.js";
import {
  latestSessionScopeEntry,
  persistSessionWorkScope,
  type SessionProjectReader,
  type SessionProjectIdentity,
} from "../../lib/session-project.js";
import { decodeWorkScope } from "../../lib/work-catalog/membership.js";
import {
  catalogId,
  fields,
  type WorkScope,
} from "../../lib/work-catalog/model.js";

export const WORKING_IDENTITY_ENTRY_TYPE = "jp-working-identity";
export type IdentityProjectionSession = SessionProjectReader &
  SessionProjectIdentity;
export interface IdentityProjectionInput {
  identity: WorkingIdentity;
  session: IdentityProjectionSession;
  recover: boolean;
  allowBrowseReset: boolean;
  current(): boolean;
}
export interface IdentityProjectionHost {
  setSessionName(name: string): void;
  appendEntry(type: string, data: unknown): void;
}
interface TransitionMarker {
  version: 1;
  sessionId: string;
  taskId: string | null;
  projectId: string | null;
}

function latestMarker(
  session: IdentityProjectionSession,
): TransitionMarker | undefined {
  const entries = session.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      !entry ||
      typeof entry !== "object" ||
      !("type" in entry) ||
      entry.type !== "custom" ||
      !("customType" in entry) ||
      entry.customType !== WORKING_IDENTITY_ENTRY_TYPE
    )
      continue;
    try {
      const row = fields("data" in entry ? entry.data : undefined, [
        "version",
        "sessionId",
        "taskId",
        "projectId",
      ]);
      if (row.version !== 1 || row.sessionId !== session.getSessionId())
        return undefined;
      if (row.taskId === null && row.projectId === null)
        return {
          version: 1,
          sessionId: row.sessionId,
          taskId: null,
          projectId: null,
        };
      if (typeof row.taskId !== "string" || !row.taskId.trim())
        return undefined;
      return {
        version: 1,
        sessionId: row.sessionId,
        taskId: row.taskId,
        projectId: catalogId(row.projectId),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function alreadyBrowsing(
  session: IdentityProjectionSession,
  target: WorkScope,
): boolean {
  try {
    const row = fields(latestSessionScopeEntry(session)?.data, [
      "version",
      "scope",
    ]);
    if (row.version !== 2) return false;
    const scope = decodeWorkScope(row.scope);
    return (
      (scope.kind === "global" && target.kind === "global") ||
      (scope.kind === "project" &&
        target.kind === "project" &&
        scope.projectId === target.projectId)
    );
  } catch {
    return false;
  }
}

export function applySessionIdentity(
  input: IdentityProjectionInput,
  host: IdentityProjectionHost,
): { applied: boolean; browseChanged: boolean } {
  let browseChanged = false;
  if (!input.current() || input.identity.kind === "unavailable")
    return { applied: false, browseChanged };
  const { session, identity } = input;
  const marker: TransitionMarker = {
    version: 1,
    sessionId: session.getSessionId(),
    taskId: identity.kind === "assigned" ? identity.taskId : null,
    projectId: identity.kind === "assigned" ? identity.projectId : null,
  };
  const previous = latestMarker(session);
  const changed =
    !previous ||
    previous.taskId !== marker.taskId ||
    previous.projectId !== marker.projectId;
  const scope: WorkScope =
    identity.kind === "assigned"
      ? { kind: "project", projectId: identity.projectId }
      : { kind: "global" };
  if (
    input.allowBrowseReset &&
    (input.recover || changed) &&
    !alreadyBrowsing(session, scope)
  ) {
    if (!input.current()) return { applied: false, browseChanged };
    persistSessionWorkScope(
      { appendCustomEntry: (type, data) => host.appendEntry(type, data) },
      scope,
    );
    browseChanged = true;
  }
  if (!input.current()) return { applied: false, browseChanged };
  // Record navigation independently so a failed name write cannot undo later browsing.
  if (changed) host.appendEntry(WORKING_IDENTITY_ENTRY_TYPE, marker);
  if (!input.current()) return { applied: false, browseChanged };
  const name = workingIdentityName(identity, session)!;
  if (session.getSessionName() !== name) {
    if (!input.current()) return { applied: false, browseChanged };
    host.setSessionName(name);
  }
  return { applied: input.current(), browseChanged };
}
