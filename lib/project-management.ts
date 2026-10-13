import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  normalizeBeadsLabel,
  resolveBeadsDir,
  type BeadsClient,
  type BeadsIssue,
} from "./beads.js";
import { withFileOperationLock } from "./file-operation-lock.js";
import {
  recordProjectRename,
  resolveProjectRename,
  validateProjectName,
} from "./project-renames.js";
import type { ProjectArchiveRegistry } from "./project-archives.js";

export const ALL_PROJECT_ISSUE_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
] as const;
const PREFIX = "workstream:";

export interface Project {
  name: string;
  variants: Set<string>;
  issues: BeadsIssue[];
}

export interface ProjectRename {
  project: Project;
  next: string;
}

export function collectProjects(issues: readonly BeadsIssue[]): Project[] {
  const projects = new Map<string, Project>();
  for (const issue of issues) {
    const seen = new Set<string>();
    for (const label of issue.labels) {
      if (!label.startsWith(PREFIX)) continue;
      const name = label.slice(PREFIX.length);
      if (!name) continue;
      const key = name.toLowerCase();
      let project = projects.get(key);
      if (!project) {
        project = { name, variants: new Set(), issues: [] };
        projects.set(key, project);
      }
      project.variants.add(name);
      if (!seen.has(key)) project.issues.push(issue);
      seen.add(key);
    }
  }
  return [...projects.values()].sort((left, right) => {
    const a = left.name.toLowerCase(),
      b = right.name.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function unfinishedIssues(project: Project): BeadsIssue[] {
  return project.issues.filter((issue) => issue.status !== "closed");
}

export function isProjectHidden(
  project: Project,
  archives: ProjectArchiveRegistry,
): boolean {
  return (
    archives.archived.includes(project.name.toLowerCase()) &&
    unfinishedIssues(project).length === 0
  );
}

function normalizedLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map(normalizeBeadsLabel).filter(Boolean))].sort();
}

export function createProjectManager(
  client: BeadsClient,
  store = resolveBeadsDir(),
) {
  async function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const host = hostname();
    // Coordinate with task creation/reopening as well as other project mutations.
    return withFileOperationLock(
      join(store, "pi-task-lifecycle"),
      {
        pid: process.pid,
        sessionId: `project-${randomUUID()}`,
        host,
        started: Date.now(),
      },
      operation,
      {
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        hostname: host,
        timeoutMs: 5_000,
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
      },
    );
  }

  async function list(): Promise<Project[]> {
    const listed = await client.listIssues(ALL_PROJECT_ISSUE_STATUSES);
    if (!listed.ok) throw new Error("Projects unavailable");
    return collectProjects(listed.value);
  }

  async function archives(): Promise<ProjectArchiveRegistry> {
    const result = await client.getProjectArchiveRegistry();
    if (!result.ok) throw new Error("Project archives unavailable");
    return result.value;
  }

  async function saveArchives(
    registry: ProjectArchiveRegistry,
    name: string,
  ): Promise<void> {
    const saved = await client.setProjectArchiveRegistry(registry);
    if (!saved.ok)
      throw new Error(`Could not save archival state for project ${name}`);
    const verified = await client.getProjectArchiveRegistry();
    if (!verified.ok || !isDeepStrictEqual(verified.value, registry)) {
      throw new Error(
        `Archival state could not be verified for project ${name}`,
      );
    }
  }

  function requireProject(projects: readonly Project[], name: string): Project {
    const project = projects.find(
      (item) => item.name.toLowerCase() === name.toLowerCase(),
    );
    if (!project) throw new Error(`Project ${name} no longer exists`);
    return project;
  }

  function checkRename(
    projects: readonly Project[],
    name: string,
    next: string,
  ): ProjectRename {
    const validated = validateProjectName(next);
    if (!validated.ok) throw new Error(validated.message);
    const project = requireProject(projects, name);
    if (
      next.toLowerCase() !== name.toLowerCase() &&
      projects.some((item) => item.name.toLowerCase() === next.toLowerCase())
    ) {
      throw new Error(`Project ${next} already exists`);
    }
    return { project, next: validated.value };
  }

  return {
    list,
    archives,
    async prepareRename(
      projects: readonly Project[],
      name: string,
      next: string,
    ): Promise<ProjectRename> {
      const plan = checkRename(projects, name, next);
      const registry = await client.getProjectRenameRegistry();
      if (!registry.ok)
        throw new Error(
          "Project rename unavailable because session migrations cannot be prepared",
        );
      return plan;
    },
    async rename(plan: ProjectRename): Promise<{ warning?: string }> {
      return mutate(async () => {
        const { project, next } = checkRename(
          await list(),
          plan.project.name,
          plan.next,
        );
        const snapshot = (value: Project) =>
          value.issues
            .map((issue) => ({
              id: issue.id,
              labels: normalizedLabels(issue.labels),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
        if (!isDeepStrictEqual(snapshot(project), snapshot(plan.project))) {
          throw new Error(
            `Project ${project.name} changed; reopen the picker before renaming`,
          );
        }
        const archived = await archives();
        const removeLabels = [...project.variants].map(
          (name) => `${PREFIX}${name}`,
        );
        const targetLabel = `${PREFIX}${next}`;
        const expected = new Map(
          project.issues.map((issue) => [
            issue.id,
            normalizedLabels([
              ...issue.labels.filter((label) => !removeLabels.includes(label)),
              targetLabel,
            ]),
          ]),
        );
        await client.updateIssueLabels(
          project.issues.map((issue) => issue.id),
          { removeLabels, addLabels: [targetLabel] },
        );
        const relisted = await client.listIssues(ALL_PROJECT_ISSUE_STATUSES);
        if (
          !relisted.ok ||
          ![...expected].every(([id, labels]) => {
            const issue = relisted.value.find((item) => item.id === id);
            return (
              issue !== undefined &&
              isDeepStrictEqual(normalizedLabels(issue.labels), labels)
            );
          })
        )
          throw new Error(`Project rename could not be verified for ${next}`);

        const warnings: string[] = [];
        const fromKey = project.name.toLowerCase(),
          toKey = next.toLowerCase();
        if (
          fromKey !== toKey &&
          (archived.archived.includes(fromKey) ||
            archived.archived.includes(toKey))
        ) {
          const names = archived.archived.filter(
            (key) => key !== fromKey && key !== toKey,
          );
          if (archived.archived.includes(fromKey)) names.push(toKey);
          try {
            await saveArchives({ version: 1, archived: names.sort() }, next);
          } catch {
            warnings.push(
              "archival state could not be migrated; check Archived projects",
            );
          }
        }
        const latestRegistry = await client.getProjectRenameRegistry();
        let migrated = false;
        if (latestRegistry.ok) {
          const saved = await client.setProjectRenameRegistry(
            recordProjectRename(latestRegistry.value, project.name, next),
          );
          if (saved.ok) {
            const verified = await client.getProjectRenameRegistry();
            migrated =
              verified.ok &&
              resolveProjectRename(verified.value, project.name) === next;
          }
        }
        if (!migrated)
          warnings.push("other sessions cannot migrate automatically");
        return warnings.length ? { warning: warnings.join("; ") } : {};
      });
    },
    async setArchived(name: string, archived: boolean): Promise<void> {
      return mutate(async () => {
        const project = requireProject(await list(), name);
        const unfinished = unfinishedIssues(project);
        if (archived && unfinished.length > 0) {
          throw new Error(
            `Cannot archive project ${project.name}: ${unfinished.length} unfinished tasks remain (including deferred tasks)`,
          );
        }
        const registry = await archives();
        const names = new Set(registry.archived);
        if (archived) names.add(project.name.toLowerCase());
        else names.delete(project.name.toLowerCase());
        await saveArchives(
          { version: 1, archived: [...names].sort() },
          project.name,
        );
      });
    },
  };
}
