import {
  resolveWorkingIdentity,
  type WorkingIdentity,
} from "../../lib/session-identity.js";
import {
  latestSessionScopeEntry,
  persistSessionWorkScope,
  sessionBrowseFingerprint,
  sessionScopeFingerprint,
  type SessionProjectReader,
  type SessionProjectIdentity,
} from "../../lib/session-project.js";
import { decodeWorkScope } from "../../lib/work-catalog/membership.js";
import {
  catalogId,
  fields,
  type WorkScope,
} from "../../lib/work-catalog/model.js";

import type { SessionFactsResult } from "./task-context.js";

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
  // Consume the ownership transition even when explicit browsing is preserved.
  if (changed) host.appendEntry(WORKING_IDENTITY_ENTRY_TYPE, marker);
  return { applied: input.current(), browseChanged };
}

export function createSessionIdentityController(host: IdentityProjectionHost) {
  let generation = 0;
  let mutationEpoch = 0;
  let mutations = 0;
  let activeSessionId: string | undefined;
  let open = true;
  let failedProjection:
    | { key: string; browse: string; preserveBrowse: boolean }
    | undefined;
  return {
    start(sessionId: string) {
      generation++;
      activeSessionId = sessionId;
      open = true;
      failedProjection = undefined;
    },
    shutdown() {
      generation++;
      activeSessionId = undefined;
      open = false;
      failedProjection = undefined;
    },
    beginMutation() {
      mutationEpoch++;
      mutations++;
      return () => {
        mutationEpoch++;
        mutations--;
      };
    },
    observe(session: IdentityProjectionSession, signal?: unknown) {
      const id = session.getSessionId();
      if (open) activeSessionId ??= id;
      const capturedGeneration = generation;
      const capturedEpoch = mutationEpoch;
      const browse = sessionBrowseFingerprint(session);
      const legacyScope = sessionScopeFingerprint(session);
      const sessionCurrent = () =>
        open &&
        !!id &&
        activeSessionId === id &&
        session.getSessionId() === id &&
        generation === capturedGeneration &&
        !(
          signal &&
          typeof signal === "object" &&
          "aborted" in signal &&
          signal.aborted === true
        );
      const current = () =>
        sessionCurrent() && mutations === 0 && mutationEpoch === capturedEpoch;
      const browseCurrent = () => sessionBrowseFingerprint(session) === browse;
      return {
        current,
        sessionCurrent,
        browseCurrent,
        legacyCurrent: () => sessionScopeFingerprint(session) === legacyScope,
        apply(
          facts: SessionFactsResult,
          options: { recover: boolean; allowBrowseReset: boolean },
        ) {
          if (
            !current() ||
            facts.kind !== "available" ||
            facts.catalog?.state !== "active"
          )
            return { applied: false, browseChanged: false };
          const identity = resolveWorkingIdentity(
            facts.issues,
            facts.catalog,
            id,
          );
          if (identity.kind === "unavailable")
            return { applied: false, browseChanged: false };
          const key = JSON.stringify([
            id,
            identity.kind === "assigned"
              ? [identity.taskId, identity.projectId]
              : null,
          ]);
          const failed =
            failedProjection?.key === key ? failedProjection : undefined;
          const preserveBrowse =
            !!failed &&
            (failed.preserveBrowse ||
              failed.browse !== sessionBrowseFingerprint(session));
          const allowBrowseReset =
            options.allowBrowseReset && browseCurrent() && !preserveBrowse;
          try {
            const result = applySessionIdentity(
              {
                identity,
                session,
                recover: options.recover,
                allowBrowseReset,
                current,
              },
              host,
            );
            if (result.applied) failedProjection = undefined;
            return result;
          } catch (error) {
            // A scope write can succeed before its marker fails; do not replay it over later browsing.
            if (current())
              failedProjection = {
                key,
                browse: sessionBrowseFingerprint(session),
                preserveBrowse: !allowBrowseReset || !browseCurrent(),
              };
            throw error;
          }
        },
      };
    },
  };
}
