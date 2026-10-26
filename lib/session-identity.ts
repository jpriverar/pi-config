import type { BeadsIssue } from "./beads.js";
import {
  generateSessionProjectName,
  type SessionProjectIdentity,
} from "./session-project.js";
import { resolveTaskMembership } from "./work-catalog/membership.js";
import type { WorkCatalog } from "./work-catalog/model.js";

export type WorkingIdentity =
  | {
      kind: "assigned";
      taskId: string;
      taskTitle: string;
      projectId: string;
      projectName: string;
      areaId: string;
      areaName: string;
    }
  | { kind: "unassigned" }
  | { kind: "unavailable"; reason: string };

export type OwnedTaskSelection =
  | { kind: "owned"; issue: BeadsIssue }
  | { kind: "unassigned" }
  | { kind: "ambiguous" | "unavailable"; reason: string };

export function resolveOwnedTask(
  issues: readonly BeadsIssue[],
  sessionId: string,
): OwnedTaskSelection {
  if (!sessionId.trim())
    return { kind: "unavailable", reason: "Session identity is unavailable" };
  const owned: BeadsIssue[] = [];
  for (const issue of issues) {
    if (
      issue.status !== "closed" &&
      (issue.lifecycleWarning || issue.lifecycle === null)
    )
      return {
        kind: "unavailable",
        reason: "Task ownership is unavailable; inspect lifecycle metadata",
      };
    if (issue.lifecycle?.phase !== "active") {
      if (issue.lifecycle?.execution)
        return {
          kind: "unavailable",
          reason: "Task execution conflicts with its non-active lifecycle",
        };
      continue;
    }
    const owner = issue.lifecycle.execution?.sessionId;
    if (!owner)
      return {
        kind: "unavailable",
        reason: "Active task ownership is missing; inspect lifecycle metadata",
      };
    if (owner !== sessionId) continue;
    if (issue.status !== "in_progress")
      return {
        kind: "unavailable",
        reason: "Owned task status conflicts with its active lifecycle",
      };
    owned.push(issue);
  }
  if (owned.length === 0) return { kind: "unassigned" };
  if (owned.length !== 1)
    return {
      kind: "ambiguous",
      reason: "Multiple active tasks are owned by this session",
    };
  return { kind: "owned", issue: owned[0] };
}

export function resolveWorkingIdentity(
  issues: readonly BeadsIssue[],
  catalog: WorkCatalog,
  sessionId: string,
): WorkingIdentity {
  if (catalog.state !== "active")
    return {
      kind: "unavailable",
      reason: "Working identity requires an active catalog",
    };
  const owned = resolveOwnedTask(issues, sessionId);
  if (owned.kind === "unassigned") return owned;
  if (owned.kind !== "owned")
    return { kind: "unavailable", reason: owned.reason };
  const issue = owned.issue;
  const membership = resolveTaskMembership(catalog, issue);
  if (membership.kind !== "project")
    return {
      kind: "unavailable",
      reason:
        membership.kind === "invalid"
          ? membership.reason
          : "Owned task has no registered project",
    };
  const project = catalog.projects[membership.projectId];
  const area =
    project.areaId === null ? undefined : catalog.areas[project.areaId];
  if (!area)
    return {
      kind: "unavailable",
      reason: "Owned task project has no registered area",
    };
  return {
    kind: "assigned",
    taskId: issue.id,
    taskTitle: issue.title,
    projectId: project.id,
    projectName: project.name,
    areaId: area.id,
    areaName: area.name,
  };
}

export function workingIdentityName(
  identity: WorkingIdentity,
  session: SessionProjectIdentity,
): string | undefined {
  if (identity.kind === "unavailable") return undefined;
  return generateSessionProjectName(
    session,
    identity.kind === "assigned" ? identity.projectName : "unassigned",
  );
}
