import {
  issuesForProject,
  isCatalogProjectHidden,
  isCatalogAreaHidden,
  destinationMismatchCount,
} from "./service.js";
import {
  catalogId,
  fields,
  findProject,
  type CatalogIssue,
  type Membership,
  type ProjectReference,
  type WorkCatalog,
  type WorkScope,
} from "./model.js";

export function decodeProjectReference(
  metadata: Record<string, unknown>,
): ProjectReference {
  if (!Object.hasOwn(metadata, "piProject")) return { kind: "absent" };
  try {
    const row = fields(metadata.piProject, ["version", "projectId"]);
    if (row.version !== 1)
      throw new Error("unsupported project reference version");
    return { kind: "valid", projectId: catalogId(row.projectId) };
  } catch {
    return {
      kind: "invalid",
      reason: "Invalid task project reference; inspect its metadata",
    };
  }
}
export function resolveTaskMembership(
  catalog: WorkCatalog,
  issue: CatalogIssue,
): Membership {
  const ref = issue.projectReference ?? { kind: "absent" as const };
  if (ref.kind === "invalid") return ref;
  if (ref.kind === "valid" && !Object.hasOwn(catalog.projects, ref.projectId))
    return { kind: "invalid", reason: "Task references an unknown project" };
  const ids = new Set<string>();
  for (const label of issue.labels.filter((label) =>
    label.startsWith("workstream:"),
  )) {
    const project = findProject(catalog, label.slice(11));
    if (!project)
      return {
        kind: "invalid",
        reason: "Task has an unregistered workstream label",
      };
    ids.add(project.id);
  }
  if (ids.size > 1)
    return {
      kind: "invalid",
      reason: "Task belongs to multiple legacy projects",
    };
  if (ref.kind === "valid") {
    if (ids.size && !ids.has(ref.projectId))
      return {
        kind: "invalid",
        reason: "Task project reference conflicts with its workstream label",
      };
    return { kind: "project", projectId: ref.projectId };
  }
  const [projectId] = ids;
  return projectId ? { kind: "project", projectId } : { kind: "unscoped" };
}
export function decodeWorkScope(value: unknown): WorkScope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid work scope; select /area or /project");
  const row = value as Record<string, unknown>;
  switch (row.kind) {
    case "global":
      fields(row, ["kind"]);
      return { kind: "global" };
    case "area":
      fields(row, ["kind", "areaId"]);
      return { kind: "area", areaId: catalogId(row.areaId) };
    case "project":
      fields(row, ["kind", "projectId"]);
      return { kind: "project", projectId: catalogId(row.projectId) };
    default:
      throw new Error("Invalid work scope; select /area or /project");
  }
}
export function validateWorkScope(
  catalog: WorkCatalog,
  value: unknown,
): WorkScope {
  const scope = decodeWorkScope(value);
  if (scope.kind === "area" && !Object.hasOwn(catalog.areas, scope.areaId))
    throw new Error(`Area ${scope.areaId} does not exist; select /area`);
  if (
    scope.kind === "project" &&
    !Object.hasOwn(catalog.projects, scope.projectId)
  )
    throw new Error(
      `Project ${scope.projectId} does not exist; select /project`,
    );
  return scope;
}
export function matchesWorkScope(
  catalog: WorkCatalog,
  membership: Membership,
  value: WorkScope,
): boolean {
  const scope = validateWorkScope(catalog, value);
  if (scope.kind === "global") return true;
  if (membership.kind !== "project") return false;
  const project = catalog.projects[membership.projectId];
  if (!project) return false;
  return scope.kind === "project"
    ? project.id === scope.projectId
    : project.areaId === scope.areaId;
}
export function scopeKey(value: WorkScope): string {
  const scope = decodeWorkScope(value);
  return scope.kind === "global"
    ? "global"
    : scope.kind === "area"
      ? "area:" + scope.areaId
      : "project:" + scope.projectId;
}

export function buildWorkView<T extends CatalogIssue>(
  catalog: WorkCatalog,
  issues: readonly T[],
  value: WorkScope,
) {
  const scope = validateWorkScope(catalog, value);
  const memberships = new Map(
    issues.map((issue) => [issue.id, resolveTaskMembership(catalog, issue)]),
  );
  const selected = issues.filter((issue) =>
    matchesWorkScope(catalog, memberships.get(issue.id)!, scope),
  );
  const projects = Object.values(catalog.projects).map((project) => {
    const area =
      project.areaId === null ? undefined : catalog.areas[project.areaId];
    return {
      project,
      area,
      hidden: isCatalogProjectHidden(project, issues),
      unfinished: issuesForProject(project, issues).filter(
        (issue) => issue.status !== "closed",
      ).length,
      destinationMismatches: area
        ? destinationMismatchCount(project, area.publication, issues)
        : 0,
    };
  });
  return {
    scope,
    key: scopeKey(scope),
    label: workScopeLabel(catalog, scope),
    issues: selected,
    projects,
    areas: Object.values(catalog.areas).map((area) => ({
      area,
      hidden: isCatalogAreaHidden(catalog, area, issues),
    })),
    projectNames: new Map(
      issues.flatMap((issue) => {
        const membership = memberships.get(issue.id)!;
        return membership.kind === "project"
          ? [[issue.id, catalog.projects[membership.projectId].name] as const]
          : [];
      }),
    ),
    diagnostics: selected.flatMap((issue) => {
      const membership = memberships.get(issue.id)!;
      return membership.kind === "invalid"
        ? [{ taskId: issue.id, reason: membership.reason }]
        : [];
    }),
  };
}

export function selectWorkIssues<T extends CatalogIssue>(
  selection: import("../session-project.js").SessionWorkSelection,
  issues: readonly T[],
): T[] {
  if (selection.kind === "catalog")
    return buildWorkView(selection.catalog, issues, selection.scope).issues;
  const project = selection.project?.toLowerCase();
  return issues.filter(
    (issue) =>
      !project ||
      issue.labels
        .find((label) => label.startsWith("workstream:"))
        ?.slice("workstream:".length)
        .toLowerCase() === project,
  );
}
export function workSelectionLabel(
  selection: import("../session-project.js").SessionWorkSelection,
): string | undefined {
  if (selection.kind === "legacy") return selection.project;
  return workScopeLabel(selection.catalog, selection.scope);
}

export function workScopeLabel(
  catalog: WorkCatalog,
  scope: WorkScope,
): string | undefined {
  validateWorkScope(catalog, scope);
  return scope.kind === "global"
    ? undefined
    : scope.kind === "area"
      ? `Area: ${catalog.areas[scope.areaId].name}`
      : catalog.projects[scope.projectId].name;
}
