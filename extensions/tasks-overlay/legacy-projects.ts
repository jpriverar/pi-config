import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  listClassifiedIssues,
  type BeadsClient,
  type ClassifiedIssue,
  type IssueStatus,
  type Readiness,
} from "../../lib/beads.js";
import { resolveProjectRename } from "../../lib/project-renames.js";
import {
  generateSessionProjectName,
  persistSessionProject,
  resolveSessionProject,
  type SessionProjectWriter,
} from "../../lib/session-project.js";
import {
  ALL_PROJECT_ISSUE_STATUSES as ALL_ISSUE_STATUSES,
  collectProjects,
  createProjectManager,
  isProjectHidden,
  type Project,
} from "../../lib/project-management.js";

export function createLegacyProjectCommands(
  pi: Pick<ExtensionAPI, "setSessionName">,
  client: BeadsClient,
  projectWriter: SessionProjectWriter,
  selectProject: (
    ctx: ExtensionContext,
    title: string,
    items: string[],
  ) => Promise<string | undefined>,
) {
  const projectsManager = createProjectManager(client);
  const primaryWorkstream = (issue: ClassifiedIssue) => issue.workstreams[0];
  async function getIssues(
    statuses: readonly IssueStatus[],
  ): Promise<ClassifiedIssue[] | undefined> {
    const result = await listClassifiedIssues(client, statuses);
    return result.ok ? result.value : undefined;
  }
  async function chooseProject(
    ctx: ExtensionContext,
    title: string,
    projects: Project[],
  ): Promise<Project | undefined> {
    if (projects.length === 0) {
      ctx.ui.notify(`No projects available for ${title.toLowerCase()}`, "info");
      return undefined;
    }
    const labels = projects.map(
      (project) => `${project.name} — ${project.issues.length} tasks`,
    );
    const selected = await selectProject(ctx, title, labels);
    return selected === undefined
      ? undefined
      : projects[labels.indexOf(selected)];
  }

  async function renameProject(
    ctx: ExtensionContext,
    selected?: Project,
  ): Promise<void> {
    const projects = await projectsManager.list();
    const project =
      selected ?? (await chooseProject(ctx, "Rename project", projects));
    if (!project) return;
    const next = await ctx.ui.input("New project name", project.name);
    if (next === undefined) return;
    const plan = await projectsManager.prepareRename(
      projects,
      project.name,
      next,
    );
    if (
      !(await ctx.ui.confirm(
        "Rename project",
        `${project.name} → ${plan.next} across ${plan.project.issues.length} tasks`,
      ))
    )
      return;
    const result = await projectsManager.rename(plan);
    const current = resolveSessionProject(ctx.sessionManager);
    if (current.workstream?.toLowerCase() === project.name.toLowerCase()) {
      persistSessionProject(projectWriter, plan.next);
      pi.setSessionName(
        generateSessionProjectName(ctx.sessionManager, plan.next),
      );
    }
    ctx.ui.notify(
      result.warning
        ? `Renamed project ${project.name} → ${plan.next}, but ${result.warning}`
        : `Renamed project ${project.name} → ${plan.next} across ${plan.project.issues.length} tasks`,
      result.warning ? "warning" : "info",
    );
  }

  async function manageProjects(
    ctx: ExtensionContext,
    archived: boolean,
  ): Promise<void> {
    while (true) {
      const projects = await projectsManager.list();
      const registry = await projectsManager.archives();
      const candidates = projects.filter((project) =>
        archived
          ? registry.archived.includes(project.name.toLowerCase())
          : !isProjectHidden(project, registry),
      );
      const project = await chooseProject(
        ctx,
        archived ? "Archived projects" : "Manage projects",
        candidates,
      );
      if (!project) return;
      const action = await ctx.ui.select(
        project.name,
        archived ? ["Restore"] : ["Rename", "Archive"],
      );
      if (action === "Rename") {
        await renameProject(ctx, project);
        continue;
      }
      if (action !== "Archive" && action !== "Restore") continue;
      if (
        action === "Archive" &&
        !(await ctx.ui.confirm(
          "Archive project",
          `Hide ${project.name} from the project picker? Tasks and history will be preserved.`,
        ))
      )
        continue;
      await projectsManager.setArchived(project.name, action === "Archive");
      ctx.ui.notify(
        `${action === "Archive" ? "Archived" : "Restored"} project ${project.name}`,
        "info",
      );
    }
  }

  async function switchProject(ctx: ExtensionContext): Promise<void> {
    const issues = await getIssues(ALL_ISSUE_STATUSES);
    if (!issues) {
      ctx.ui.notify("Projects unavailable", "warning");
      return;
    }

    const archives = await projectsManager.archives();
    const hidden = new Set(
      collectProjects(issues)
        .filter((project) => isProjectHidden(project, archives))
        .map((project) => project.name.toLowerCase()),
    );
    const projects = new Map<
      string,
      {
        name: string;
        counts: Record<Readiness, number>;
      }
    >();
    for (const issue of issues) {
      const name = primaryWorkstream(issue);
      if (!name) continue;

      const key = name.toLowerCase();
      if (hidden.has(key)) continue;
      let project = projects.get(key);
      if (!project) {
        project = {
          name,
          counts: { in_progress: 0, blocked: 0, ready: 0, waiting: 0 },
        };
        projects.set(key, project);
      }
      if (issue.status !== "closed" && issue.status !== "deferred") {
        project.counts[issue.readiness]++;
      }
    }

    const global = "Global / no project";
    const labels = [global];
    const namesByLabel = new Map<string, string>();
    const sortedProjects = [...projects.values()].sort((left, right) => {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    });
    for (const project of sortedProjects) {
      const activeCount = Object.values(project.counts).reduce(
        (total, count) => total + count,
        0,
      );
      const label =
        activeCount === 0
          ? `${project.name} — No open tasks`
          : `${project.name} — Active: ${project.counts.in_progress} • Actionable: ${project.counts.ready} • Waiting: ${project.counts.blocked + project.counts.waiting}`;
      labels.push(label);
      namesByLabel.set(label, project.name);
    }

    labels.push("Manage projects…", "Archived projects…");
    const selected = await selectProject(ctx, "Switch project", labels);
    if (selected === undefined) return;
    if (selected === "Manage projects…") return manageProjects(ctx, false);
    if (selected === "Archived projects…") return manageProjects(ctx, true);

    const current = resolveSessionProject(ctx.sessionManager);
    if (selected === global) {
      if (current.source === "explicit" && current.workstream === undefined)
        return;

      persistSessionProject(projectWriter, null);
      pi.setSessionName("");
      return;
    }

    const next = namesByLabel.get(selected);
    if (next === undefined) return;
    if (
      current.source === "explicit" &&
      current.workstream !== undefined &&
      next.toLowerCase() === current.workstream.toLowerCase()
    )
      return;

    persistSessionProject(projectWriter, next);
    pi.setSessionName(generateSessionProjectName(ctx.sessionManager, next));
  }

  async function handle(args: string, ctx: ExtensionContext): Promise<void> {
    try {
      if (args.trim().toLowerCase() === "rename") await renameProject(ctx);
      else await switchProject(ctx);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Project operation failed",
        "warning",
      );
    }
  }
  async function resume(reason: string, ctx: ExtensionContext): Promise<void> {
    const project = resolveSessionProject(ctx.sessionManager);
    if (project.workstream === undefined) return;

    const registry = await client.getProjectRenameRegistry();
    if (!registry.ok) {
      ctx.ui.notify(
        "Project scope could not be migrated automatically",
        "warning",
      );
      return;
    }

    const projectKey = project.workstream.toLowerCase();
    const hasAlias = Object.prototype.hasOwnProperty.call(
      registry.value.aliases,
      projectKey,
    );
    const canonical = resolveProjectRename(registry.value, project.workstream);
    if (hasAlias && canonical === undefined) {
      ctx.ui.notify(
        "Project scope could not be migrated automatically",
        "warning",
      );
      return;
    }

    if (canonical !== undefined && canonical !== project.workstream) {
      persistSessionProject(projectWriter, canonical);
      pi.setSessionName(
        generateSessionProjectName(ctx.sessionManager, canonical),
      );
      return;
    }

    if (reason !== "fork" || project.source !== "explicit") return;
    pi.setSessionName(
      generateSessionProjectName(ctx.sessionManager, project.workstream),
    );
  }
  return { handle, resume };
}
