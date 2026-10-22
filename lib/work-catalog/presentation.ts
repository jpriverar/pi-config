import { normalizeMetadata } from "../beads.js";
import {
  buildWorkView,
  selectWorkIssues,
  resolveTaskMembership,
} from "./membership.js";
import { issuesForProject, hasDestinationMismatch } from "./service.js";
import {
  catalogId,
  type AreaRecord,
  type CatalogIssue,
  type WorkCatalog,
} from "./model.js";

export type CatalogEntityKind = "area" | "project";
export interface CatalogEntitySummary {
  id: string;
  name: string;
  description: string;
  descriptionMissing: boolean;
  descriptionTruncated: boolean;
  archived: boolean;
  hidden: boolean;
  areaId?: string | null;
  areaName?: string;
  areaArchived?: boolean;
  publication: string;
  unfinished: number;
  destinationMismatches: number;
}
export interface CatalogListOptions {
  query?: string;
  areaId?: string;
  offset?: number;
  limit?: number;
  includeArchived?: boolean;
}
export function publicationSummary(
  area: Pick<AreaRecord, "publication"> | undefined,
): string {
  if (!area) return "Unclassified: choose an area before creating tasks";
  if (area.publication.mode === "local") return "Local-only";
  const target = area.publication.target;
  return `Datadog ${target.site} · org ${target.orgUuid} · project ${target.projectId} · type ${target.typeId}`;
}
export function catalogEntitySummaries(
  catalog: WorkCatalog,
  issues: readonly CatalogIssue[],
  entity: CatalogEntityKind,
): CatalogEntitySummary[] {
  const view = buildWorkView(catalog, issues, { kind: "global" });
  if (entity === "project")
    return view.projects.map(
      ({ project, area, hidden, unfinished, destinationMismatches }) => ({
        id: project.id,
        name: normalizeMetadata(project.name, 128),
        description: normalizeMetadata(project.description ?? "", 1024),
        descriptionMissing: project.description === null,
        descriptionTruncated: false,
        archived: project.archived,
        hidden,
        areaId: project.areaId,
        areaName: area ? normalizeMetadata(area.name, 128) : undefined,
        areaArchived: area?.archived,
        publication: publicationSummary(area),
        unfinished,
        destinationMismatches,
      }),
    );
  if (entity !== "area") throw new Error("Invalid catalog entity kind");
  return view.areas.map(({ area, hidden }) => {
    const children = view.projects.filter((p) => p.project.areaId === area.id);
    const members = [
      ...new Map(
        children
          .flatMap((p) => issuesForProject(p.project, issues))
          .map((issue) => [issue.id, issue]),
      ).values(),
    ];
    return {
      id: area.id,
      name: normalizeMetadata(area.name, 128),
      description: normalizeMetadata(area.description ?? "", 1024),
      descriptionMissing: area.description === null,
      descriptionTruncated: false,
      archived: area.archived,
      hidden,
      publication: publicationSummary(area),
      unfinished: members.filter((issue) => issue.status !== "closed").length,
      destinationMismatches: members.filter((issue) =>
        hasDestinationMismatch(area.publication, issue),
      ).length,
    };
  });
}
export function listCatalogEntities(
  catalog: WorkCatalog,
  issues: readonly CatalogIssue[],
  entity: CatalogEntityKind,
  options: CatalogListOptions = {},
) {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 10;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error(
      "Catalog listing requires offset >= 0 and limit between 1 and 20",
    );
  if (
    options.query !== undefined &&
    (typeof options.query !== "string" || options.query.length > 256)
  )
    throw new Error("Catalog query must be a string of at most 256 characters");
  if (
    options.areaId !== undefined &&
    !Object.hasOwn(catalog.areas, options.areaId)
  )
    throw new Error(`Unknown area ${options.areaId}`);
  const query = options.query?.toLowerCase() ?? "";
  const rows = catalogEntitySummaries(catalog, issues, entity)
    .filter(
      (row) =>
        (options.includeArchived || !row.hidden) &&
        (options.areaId === undefined || row.areaId === options.areaId) &&
        (!query ||
          `${row.name} ${row.description} ${row.areaName ?? ""}`
            .toLowerCase()
            .includes(query)),
    )
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const page = {
    revision: catalog.revision,
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    items: rows.slice(offset, offset + limit).map((row) => ({
      ...row,
      description: [...row.description].slice(0, 256).join(""),
      descriptionTruncated: [...row.description].length > 256,
    })),
  };
  while (
    page.items.length > 1 &&
    Buffer.byteLength(JSON.stringify(page)) > 16 * 1024
  ) {
    page.items.pop();
    page.nextOffset = offset + page.items.length;
  }
  if (Buffer.byteLength(JSON.stringify(page)) > 16 * 1024)
    throw new Error("Catalog summary exceeds the output budget");
  return page;
}
export function getCatalogEntity(
  catalog: WorkCatalog,
  issues: readonly CatalogIssue[],
  entity: CatalogEntityKind,
  id: string,
): CatalogEntitySummary {
  id = catalogId(id);
  const row = catalogEntitySummaries(catalog, issues, entity).find(
    (row) => row.id === id,
  );
  if (!row) throw new Error(`Catalog ${entity} ${id} does not exist`);
  return row;
}

export function presentWorkIssues(
  selection: import("../session-project.js").SessionWorkSelection,
  issues: readonly import("../beads.js").ClassifiedIssue[],
): import("../beads.js").ClassifiedIssue[] {
  if (selection.kind === "legacy") return selectWorkIssues(selection, issues);
  const view = buildWorkView(selection.catalog, issues, selection.scope);
  return view.issues.map((issue) => {
    const projectName = view.projectNames.get(issue.id);
    const diagnostic = view.diagnostics.find((d) => d.taskId === issue.id);
    const membership = resolveTaskMembership(selection.catalog, issue);
    const project =
      membership.kind === "project"
        ? selection.catalog.projects[membership.projectId]
        : undefined;
    const area = project?.areaId
      ? selection.catalog.areas[project.areaId]
      : undefined;
    const mismatch = area && hasDestinationMismatch(area.publication, issue);
    const warnings = [...issue.warnings];
    if (diagnostic) warnings.push(`Project membership: ${diagnostic.reason}`);
    if (project?.archived)
      warnings.push(
        "Project is archived; restore it before creating new tasks",
      );
    if (area?.archived)
      warnings.push("Area is archived; restore it before creating new tasks");
    if (mismatch)
      warnings.push(
        "Existing WM binding keeps its previous destination; only new tasks use the area's policy",
      );
    return {
      ...issue,
      workstreams: projectName
        ? [projectName]
        : diagnostic
          ? ["Unresolved project"]
          : [],
      warnings: [...new Set(warnings)],
      ...(mismatch && issue.workManagement
        ? {
            workManagement: {
              ...issue.workManagement,
              text: `${issue.workManagement.text} · previous destination`,
            },
          }
        : {}),
    };
  });
}
