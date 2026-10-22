import { validateProjectName } from "../project-renames.js";
import {
  decodeTarget,
  type WorkManagementTarget,
} from "../work-management/model.js";

export const WORK_CATALOG_CONFIG_KEY = "custom.pi-work-catalog";
export const CATALOG_BYTE_LIMIT = 63 * 1024;
export const DESCRIPTION_LIMIT = 1024;

export type Publication =
  | { mode: "local" }
  | { mode: "datadog"; target: WorkManagementTarget };
export interface AreaRecord {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  publication: Publication;
}
export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  areaId: string | null;
  archived: boolean;
  workstreamKey: string;
  aliases: string[];
}
export interface WorkCatalog {
  version: 1;
  revision: number;
  state: "prepared" | "active";
  areas: Record<string, AreaRecord>;
  projects: Record<string, ProjectRecord>;
}
export type WorkScope =
  | { kind: "global" }
  | { kind: "area"; areaId: string }
  | { kind: "project"; projectId: string };
export type ProjectReference =
  | { kind: "absent" }
  | { kind: "valid"; projectId: string }
  | { kind: "invalid"; reason: string };
export type Membership =
  | { kind: "project"; projectId: string }
  | { kind: "unscoped" }
  | { kind: "invalid"; reason: string };
export interface CatalogIssue {
  id: string;
  status: string;
  labels: string[];
  projectReference?: ProjectReference;
  capturedDestination?: Pick<
    WorkManagementTarget,
    "site" | "orgUuid" | "projectId" | "typeId"
  >;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("work catalog: expected an object");
  }
  return value as Record<string, unknown>;
}
export function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const row = object(value);
  if (
    Object.keys(row).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(row, key))
  ) {
    throw new Error("work catalog: missing or unsupported fields");
  }
  return row;
}
export function catalogId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value)
  ) {
    throw new Error("work catalog: invalid entity ID");
  }
  return value;
}
export function catalogName(value: unknown): string {
  if (typeof value !== "string") throw new Error("work catalog: invalid name");
  const result = validateProjectName(value);
  if (!result.ok) throw new Error(`work catalog: ${result.message}`);
  return result.value;
}
export function validateDescription(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].length > DESCRIPTION_LIMIT ||
    /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
      value,
    )
  ) {
    throw new Error(
      "work catalog: description must be nonempty plain text of at most 1024 characters",
    );
  }
  return value;
}
export function decodePublication(value: unknown): Publication {
  const raw = object(value);
  if (raw.mode === "local") {
    fields(value, ["mode"]);
    return { mode: "local" };
  }
  if (raw.mode === "datadog") {
    fields(value, ["mode", "target"]);
    return { mode: "datadog", target: decodeTarget(raw.target) };
  }
  throw new Error(
    "work catalog: publication must be explicit local or datadog",
  );
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error("work catalog: invalid archived flag");
  return value;
}
function description(value: unknown): string | null {
  return value === null ? null : validateDescription(value);
}
function checkBytes(content: string): void {
  if (Buffer.byteLength(content, "utf8") > CATALOG_BYTE_LIMIT) {
    throw new Error(
      "work catalog exceeds 63 KiB; reduce the catalog before writing",
    );
  }
}
export function projectKeys(project: ProjectRecord): string[] {
  return [
    ...new Set(
      [project.name, project.workstreamKey, ...project.aliases].map((key) =>
        key.toLowerCase(),
      ),
    ),
  ];
}
export function findProject(
  catalog: WorkCatalog,
  key: string,
): ProjectRecord | undefined {
  const name = key.toLowerCase();
  return Object.values(catalog.projects).find((project) =>
    projectKeys(project).includes(name),
  );
}

export function decodeWorkCatalog(value: unknown): WorkCatalog | null {
  if (value === undefined || value === "") return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  checkBytes(serialized);
  const row = fields(JSON.parse(serialized), [
    "version",
    "revision",
    "state",
    "areas",
    "projects",
  ]);
  if (
    row.version !== 1 ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    (row.state !== "prepared" && row.state !== "active")
  ) {
    throw new Error(
      "work catalog: unsupported version, revision or activation state",
    );
  }
  const areas: WorkCatalog["areas"] = {};
  const areaNames = new Set<string>();
  for (const [key, raw] of Object.entries(object(row.areas))) {
    const area = fields(raw, [
      "id",
      "name",
      "description",
      "archived",
      "publication",
    ]);
    const id = catalogId(area.id);
    const name = catalogName(area.name);
    if (key !== id || areaNames.has(name.toLowerCase()))
      throw new Error("work catalog: duplicate area name or inconsistent ID");
    areaNames.add(name.toLowerCase());
    areas[id] = {
      id,
      name,
      description: description(area.description),
      archived: bool(area.archived),
      publication: decodePublication(area.publication),
    };
  }
  const projects: WorkCatalog["projects"] = {};
  const reserved = new Map<string, string>();
  for (const [key, raw] of Object.entries(object(row.projects))) {
    const project = fields(raw, [
      "id",
      "name",
      "description",
      "areaId",
      "archived",
      "workstreamKey",
      "aliases",
    ]);
    const id = catalogId(project.id);
    const areaId = project.areaId === null ? null : catalogId(project.areaId);
    if (
      key !== id ||
      Object.hasOwn(areas, id) ||
      (areaId !== null && !Object.hasOwn(areas, areaId))
    )
      throw new Error(
        "work catalog: duplicate/inconsistent project ID or missing area",
      );
    if (!Array.isArray(project.aliases))
      throw new Error("work catalog: invalid project aliases");
    const aliases = project.aliases.map(catalogName);
    if (
      new Set(aliases.map((alias) => alias.toLowerCase())).size !==
      aliases.length
    )
      throw new Error("work catalog: duplicate aliases");
    const decoded: ProjectRecord = {
      id,
      name: catalogName(project.name),
      description: description(project.description),
      areaId,
      archived: bool(project.archived),
      workstreamKey: catalogName(project.workstreamKey),
      aliases,
    };
    for (const name of projectKeys(decoded)) {
      if (reserved.has(name))
        throw new Error(
          `work catalog: project name or alias ${name} already reserved`,
        );
      reserved.set(name, id);
    }
    projects[id] = decoded;
  }
  return {
    version: 1,
    revision: row.revision as number,
    state: row.state,
    areas,
    projects,
  };
}
export function encodeWorkCatalog(catalog: WorkCatalog): string {
  const decoded = decodeWorkCatalog(catalog);
  if (!decoded) throw new Error("work catalog: cannot write absence");
  const result = JSON.stringify(decoded);
  checkBytes(result);
  return result;
}
