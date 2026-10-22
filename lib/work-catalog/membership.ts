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
