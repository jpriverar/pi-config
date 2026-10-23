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

export function resolveWorkingIdentity(
  issues: readonly BeadsIssue[],
  catalog: WorkCatalog,
  sessionId: string,
): WorkingIdentity {
  if (!sessionId.trim() || catalog.state !== "active")
    return {
      kind: "unavailable",
      reason: "Working identity requires a session ID and active catalog",
    };
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
    if (issue.lifecycle?.phase !== "active") continue;
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
      kind: "unavailable",
      reason: "Multiple active tasks are owned by this session",
    };
  const issue = owned[0];
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
