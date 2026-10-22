import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { BeadsClient } from "../beads.js";
import {
  withFileOperationLock,
  type FileOperationLockDependencies,
} from "../file-operation-lock.js";
import { ALL_PROJECT_ISSUE_STATUSES } from "../project-management.js";
import type { LockOwner } from "../task-lifecycle/types.js";
import {
  catalogId,
  catalogName,
  decodePublication,
  decodeWorkCatalog,
  encodeWorkCatalog,
  projectKeys,
  validateDescription,
  type AreaRecord,
  type CatalogIssue,
  type ProjectRecord,
  type Publication,
  type WorkCatalog,
} from "./model.js";
import type { CatalogStore } from "./store.js";

type Entity = "area" | "project";
export type CatalogCommand =
  | {
      kind: "create_area";
      name: string;
      description: string;
      publication: Publication;
    }
  | {
      kind: "create_project";
      name: string;
      description: string;
      areaId: string;
    }
  | { kind: "rename"; entity: Entity; id: string; name: string }
  | { kind: "describe"; entity: Entity; id: string; description: string }
  | { kind: "move_project"; projectId: string; areaId: string }
  | { kind: "set_publication"; areaId: string; publication: Publication }
  | { kind: "archive" | "restore"; entity: Entity; id: string };
export interface CatalogChange {
  revision: number;
  entityId: string;
  warnings: string[];
}
export interface CatalogServiceDependencies {
  client: Pick<BeadsClient, "listIssues">;
  store: CatalogStore;
  storePath: string;
  uuid?: () => string;
  lockDependencies?: FileOperationLockDependencies;
}

export function issuesForProject(
  project: ProjectRecord,
  issues: readonly CatalogIssue[],
): CatalogIssue[] {
  const keys = new Set(projectKeys(project));
  // Archival must consider every legacy label, even when view membership is ambiguous.
  return issues.filter(
    (issue) =>
      (issue.projectReference?.kind === "valid" &&
        issue.projectReference.projectId === project.id) ||
      issue.labels.some(
        (label) =>
          label.startsWith("workstream:") &&
          keys.has(label.slice(11).toLowerCase()),
      ),
  );
}
export function isCatalogProjectHidden(
  project: ProjectRecord,
  issues: readonly CatalogIssue[],
): boolean {
  return (
    project.archived &&
    issuesForProject(project, issues).every(
      (issue) => issue.status === "closed",
    )
  );
}
export function isCatalogAreaHidden(
  catalog: WorkCatalog,
  area: AreaRecord,
  issues: readonly CatalogIssue[],
): boolean {
  return (
    area.archived &&
    Object.values(catalog.projects)
      .filter((project) => project.areaId === area.id)
      .every((project) => isCatalogProjectHidden(project, issues))
  );
}
export function destinationMismatchCount(
  project: ProjectRecord,
  publication: Publication,
  issues: readonly CatalogIssue[],
): number {
  return issuesForProject(project, issues).filter((issue) => {
    const captured = issue.capturedDestination;
    if (!captured) return false;
    if (publication.mode === "local") return true;
    return (["site", "orgUuid", "projectId", "typeId"] as const).some(
      (key) => captured[key] !== publication.target[key],
    );
  }).length;
}
function lockDefaults(): FileOperationLockDependencies {
  return {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hostname: hostname(),
    timeoutMs: 5000,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return "live";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
          ? "dead"
          : "ambiguous";
      }
    },
  };
}
export function createCatalogService(deps: CatalogServiceDependencies) {
  const lock = deps.lockDependencies ?? lockDefaults();
  async function read(): Promise<WorkCatalog> {
    const catalog = decodeWorkCatalog((await deps.store.read()) ?? undefined);
    if (!catalog || catalog.state !== "active")
      throw new Error(
        "Work catalog is not active; review and activate it before managing entities",
      );
    return catalog;
  }
  return {
    read,
    async apply(
      command: CatalogCommand,
      expectedRevision: number,
      owner: LockOwner,
    ): Promise<CatalogChange> {
      return withFileOperationLock(
        join(deps.storePath, "pi-task-lifecycle"),
        owner,
        async () => {
          const catalog = await read();
          if (catalog.revision !== expectedRevision)
            throw new Error(
              `Work catalog changed from revision ${expectedRevision} to ${catalog.revision}; read it again`,
            );
          const area = (id: string) => {
            const result = catalog.areas[catalogId(id)];
            if (!result) throw new Error(`Area ${id} does not exist`);
            return result;
          };
          const availableArea = (id: string) => {
            const result = area(id);
            if (result.archived)
              throw new Error(
                `Area ${result.name} is archived; restore it first`,
              );
            return result;
          };
          const project = (id: string) => {
            const result = catalog.projects[catalogId(id)];
            if (!result) throw new Error(`Project ${id} does not exist`);
            return result;
          };
          const entity = (
            kind: Entity,
            id: string,
          ): AreaRecord | ProjectRecord => {
            if (kind === "area") return area(id);
            if (kind === "project") return project(id);
            throw new Error("Invalid catalog entity kind");
          };
          const newId = () => {
            const id = catalogId((deps.uuid ?? randomUUID)());
            if (
              Object.hasOwn(catalog.areas, id) ||
              Object.hasOwn(catalog.projects, id)
            )
              throw new Error(`Catalog ID ${id} already exists`);
            return id;
          };
          const readIssues = async () => {
            const result = await deps.client.listIssues(
              ALL_PROJECT_ISSUE_STATUSES,
            );
            if (!result.ok)
              throw new Error(
                "Tasks unavailable; catalog mutation cannot be checked",
              );
            return result.value;
          };
          const warnings: string[] = [];
          const warnDestination = (
            value: ProjectRecord,
            publication: Publication,
            issues: readonly CatalogIssue[],
          ) => {
            const count = destinationMismatchCount(value, publication, issues);
            if (count)
              warnings.push(
                `${value.name}: ${count} existing WM bindings keep their previous destination; only new tasks use this policy`,
              );
          };
          let entityId: string;
          switch (command.kind) {
            case "create_area": {
              entityId = newId();
              catalog.areas[entityId] = {
                id: entityId,
                name: catalogName(command.name),
                description: validateDescription(command.description),
                archived: false,
                publication: decodePublication(command.publication),
              };
              break;
            }
            case "create_project": {
              availableArea(command.areaId);
              entityId = newId();
              const name = catalogName(command.name);
              catalog.projects[entityId] = {
                id: entityId,
                name,
                description: validateDescription(command.description),
                areaId: command.areaId,
                archived: false,
                workstreamKey: name.toLowerCase(),
                aliases: [],
              };
              break;
            }
            case "rename": {
              const value = entity(command.entity, command.id);
              const name = catalogName(command.name);
              if (command.entity === "project") {
                const p = value as ProjectRecord;
                if (
                  p.name.toLowerCase() !== name.toLowerCase() &&
                  !p.aliases.some(
                    (alias) => alias.toLowerCase() === p.name.toLowerCase(),
                  )
                )
                  p.aliases.push(p.name);
              }
              value.name = name;
              entityId = value.id;
              break;
            }
            case "describe": {
              const value = entity(command.entity, command.id);
              value.description = validateDescription(command.description);
              entityId = value.id;
              break;
            }
            case "move_project": {
              const destination = availableArea(command.areaId);
              const value = project(command.projectId);
              warnDestination(
                value,
                destination.publication,
                await readIssues(),
              );
              value.areaId = destination.id;
              entityId = value.id;
              break;
            }
            case "set_publication": {
              const value = area(command.areaId);
              const publication = decodePublication(command.publication);
              const issues = await readIssues();
              for (const p of Object.values(catalog.projects).filter(
                (p) => p.areaId === value.id,
              ))
                warnDestination(p, publication, issues);
              value.publication = publication;
              entityId = value.id;
              break;
            }
            case "archive":
            case "restore": {
              const value = entity(command.entity, command.id);
              if (command.kind === "archive") {
                const children =
                  command.entity === "project"
                    ? [value as ProjectRecord]
                    : Object.values(catalog.projects).filter(
                        (p) => p.areaId === value.id,
                      );
                if (
                  command.entity === "area" &&
                  children.some((p) => !p.archived)
                )
                  throw new Error(
                    `Cannot archive area ${value.name}: archive its projects first`,
                  );
                const issues = await readIssues();
                const unfinished = new Set(
                  children
                    .flatMap((p) => issuesForProject(p, issues))
                    .filter((i) => i.status !== "closed")
                    .map((i) => i.id),
                );
                if (unfinished.size)
                  throw new Error(
                    `Cannot archive ${value.name}: ${unfinished.size} unfinished tasks remain, including deferred tasks`,
                  );
              }
              value.archived = command.kind === "archive";
              entityId = value.id;
              break;
            }
            default:
              throw new Error("Unsupported catalog mutation");
          }
          catalog.revision++;
          encodeWorkCatalog(catalog);
          try {
            await deps.store.write(catalog);
          } catch (error) {
            throw new Error(
              `Catalog mutation for ${entityId}, revision ${catalog.revision}, could not be confirmed; read back before retrying: ${error instanceof Error ? error.message : "write failed"}`,
            );
          }
          return { revision: catalog.revision, entityId, warnings };
        },
        lock,
      );
    },
  };
}
export type CatalogService = ReturnType<typeof createCatalogService>;
