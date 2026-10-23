import type {
  WorkManagementConfig,
  WorkManagementTarget,
} from "../work-management/model.js";
import {
  catalogId,
  catalogName,
  findProject,
  type ProjectRecord,
  type WorkCatalog,
} from "./model.js";

export function workRoutingMode(
  config: WorkManagementConfig | null | undefined,
  catalog: WorkCatalog | null,
): "legacy" | "catalog" {
  if (config?.version === 2) {
    if (catalog?.state !== "active")
      throw new Error(
        "Catalog routing configuration requires an active work catalog; inspect activation before creating tasks",
      );
    return "catalog";
  }
  if (catalog?.state === "active")
    throw new Error(
      "Active work catalog requires version-2 routing configuration; no legacy fallback is allowed",
    );
  return "legacy";
}
function availableProject(catalog: WorkCatalog, id: string): ProjectRecord {
  if (catalog.state !== "active") throw new Error("Work catalog is not active");
  const project = catalog.projects[catalogId(id)];
  if (!project)
    throw new Error(
      `Project ${id} does not exist; choose a registered project`,
    );
  if (project.archived)
    throw new Error(`Project ${project.name} is archived; restore it first`);
  const area =
    project.areaId === null ? undefined : catalog.areas[project.areaId];
  if (!area)
    throw new Error(
      `Project ${project.name} has no registered area; classify it before creating tasks`,
    );
  if (area.archived)
    throw new Error(`Area ${area.name} is archived; restore it first`);
  return project;
}
export function resolveCreateProject(
  catalog: WorkCatalog,
  selection: { projectId?: string; workstream?: string },
): ProjectRecord {
  const named =
    selection.workstream === undefined
      ? undefined
      : findProject(catalog, catalogName(selection.workstream));
  if (selection.workstream !== undefined && !named)
    throw new Error(
      `Project ${JSON.stringify(selection.workstream)} is not registered; choose or create it first`,
    );
  if (
    selection.projectId !== undefined &&
    named &&
    selection.projectId !== named.id
  )
    throw new Error("Project ID conflicts with the supplied workstream");
  const id = selection.projectId ?? named?.id;
  if (id === undefined)
    throw new Error("Choose an explicit project when creating a task");
  return availableProject(catalog, id);
}
export function resolveNewTaskTarget(
  catalog: WorkCatalog,
  project: ProjectRecord,
): WorkManagementTarget | null {
  const current = availableProject(catalog, project.id);
  const publication = catalog.areas[current.areaId!].publication;
  return publication.mode === "local" ? null : publication.target;
}
