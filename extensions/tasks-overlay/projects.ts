import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { normalizeMetadata } from "../../lib/beads.js";
import type { LockOwner } from "../../lib/task-lifecycle/types.js";
import { resolveSessionWorkScope } from "../../lib/session-project.js";
import {
  catalogName,
  validateDescription,
  decodePublication,
  type CatalogIssue,
  type Publication,
  type WorkCatalog,
  type WorkScope,
} from "../../lib/work-catalog/model.js";
import type { CatalogStore } from "../../lib/work-catalog/store.js";
import type {
  CatalogCommand,
  CatalogService,
} from "../../lib/work-catalog/service.js";
import {
  publicationSummary,
  catalogEntitySummaries,
  type CatalogEntityKind,
  type CatalogEntitySummary,
} from "../../lib/work-catalog/presentation.js";

const PROJECT_PICKER_VISIBLE_ITEMS = 8;

export async function selectWorkEntity(
  ctx: ExtensionContext,
  title: string,
  items: string[],
): Promise<string | undefined> {
  if (ctx.mode !== "tui" || items.length <= PROJECT_PICKER_VISIBLE_ITEMS) {
    return ctx.ui.select(title, items);
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let selectedIndex = 0;
    const visibleCount = Math.min(PROJECT_PICKER_VISIBLE_ITEMS, items.length);

    return {
      render(width: number) {
        const contentWidth = Math.max(1, width - 2);
        const startIndex = Math.max(
          0,
          Math.min(
            selectedIndex - Math.floor(visibleCount / 2),
            items.length - visibleCount,
          ),
        );
        const endIndex = Math.min(startIndex + visibleCount, items.length);
        const lines = [
          theme.fg(
            "accent",
            theme.bold(truncateToWidth(title, Math.max(1, width))),
          ),
        ];

        for (let index = startIndex; index < endIndex; index++) {
          const item = truncateToWidth(items[index], contentWidth);
          lines.push(
            index === selectedIndex
              ? theme.fg("accent", `→ ${item}`)
              : `  ${theme.fg("text", item)}`,
          );
        }

        const position =
          items.length > visibleCount
            ? ` • ${selectedIndex + 1}/${items.length}`
            : "";
        lines.push(
          theme.fg(
            "dim",
            truncateToWidth(
              `↑↓ navigate • enter select • esc cancel${position}`,
              Math.max(1, width),
            ),
          ),
        );
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up") || data === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          tui.requestRender();
        } else if (
          keybindings.matches(data, "tui.select.down") ||
          data === "j"
        ) {
          selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
          tui.requestRender();
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done(items[selectedIndex]);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        }
      },
    };
  });
}

export interface ProjectCommandDependencies {
  catalog: CatalogStore;
  service: CatalogService;
  issues(): Promise<CatalogIssue[]>;
  owner(ctx: ExtensionContext): LockOwner;
  select(
    scope: WorkScope,
    catalog: WorkCatalog,
    ctx: ExtensionContext,
  ): void | Promise<void>;
  legacy(args: string, ctx: ExtensionContext): Promise<void>;
  choose?(
    ctx: ExtensionContext,
    title: string,
    choices: string[],
  ): Promise<string | undefined>;
}

export function registerProjectCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  deps: ProjectCommandDependencies,
): void {
  const choose = deps.choose ?? selectWorkEntity;
  function label(row: CatalogEntitySummary): string {
    const prefix = row.areaName ? row.areaName + " / " : "";
    const status =
      row.archived || row.areaArchived
        ? `${row.archived ? "archived" : "area archived"}${row.unfinished > 0 ? ", unfinished work" : ""}`
        : `${row.unfinished} unfinished`;
    return `${prefix}${row.name} — ${normalizeMetadata(row.description || "Description missing", 128)} (${status})`;
  }
  async function pick(
    ctx: ExtensionContext,
    title: string,
    rows: CatalogEntitySummary[],
  ) {
    const labels = rows.map(label);
    const selected = await choose(ctx, title, labels);
    return selected === undefined ? undefined : rows[labels.indexOf(selected)];
  }
  async function policy(
    ctx: ExtensionContext,
    current?: Publication,
  ): Promise<Publication | undefined> {
    const mode = await ctx.ui.select("Publication policy", [
      "Local-only",
      "Datadog (approved target JSON)",
    ]);
    if (mode === undefined) return undefined;
    if (mode === "Local-only") return { mode: "local" };
    const json = await ctx.ui.editor(
      "Complete approved Datadog target (no credentials)",
      current?.mode === "datadog"
        ? JSON.stringify(current.target, null, 2)
        : "",
    );
    return json === undefined
      ? undefined
      : decodePublication({ mode: "datadog", target: JSON.parse(json) });
  }
  async function apply(
    ctx: ExtensionContext,
    catalog: WorkCatalog,
    command: CatalogCommand,
    summary: string,
  ) {
    if (!(await ctx.ui.confirm("Confirm catalog change", summary)))
      return undefined;
    const changed = await deps.service.apply(
      command,
      catalog.revision,
      deps.owner(ctx),
    );
    ctx.ui.notify(
      changed.warnings.length
        ? changed.warnings.slice(0, 10).join("\n")
        : "Catalog updated",
      changed.warnings.length ? "warning" : "info",
    );
    return changed;
  }
  async function create(
    ctx: ExtensionContext,
    catalog: WorkCatalog,
    issues: CatalogIssue[],
    kind: CatalogEntityKind,
  ) {
    let name = await ctx.ui.input(`New ${kind} name`);
    if (name === undefined) return;
    name = catalogName(name);
    let description = await ctx.ui.editor(
      `${kind === "area" ? "Responsibility and boundaries" : "Effort or catch-all scope"} (1–3 sentences)`,
    );
    if (description === undefined) return;
    description = validateDescription(description);
    let command: CatalogCommand;
    if (kind === "area") {
      const publication = await policy(ctx);
      if (publication === undefined) return;
      command = { kind: "create_area", name, description, publication };
    } else {
      const current = resolveSessionWorkScope(ctx.sessionManager, catalog);
      const selected =
        current.kind === "resolved" && current.scope.kind === "area"
          ? catalog.areas[current.scope.areaId]
          : await pick(
              ctx,
              "Project area",
              catalogEntitySummaries(catalog, issues, "area").filter(
                (area) => !area.archived,
              ),
            );
      if (!selected) return;
      command = {
        kind: "create_project",
        name,
        description,
        areaId: selected.id,
      };
    }
    const destination =
      command.kind === "create_area"
        ? command.publication
        : catalog.areas[command.areaId].publication;
    const routing = publicationSummary({ publication: destination });
    const changed = await apply(
      ctx,
      catalog,
      command,
      `Create and select ${kind} ${name}?\n${description}${command.kind === "create_project" ? `\nArea: ${catalog.areas[command.areaId].name}` : ""}\n${routing}`,
    );
    if (changed)
      await deps.select(
        kind === "area"
          ? { kind: "area", areaId: changed.entityId }
          : { kind: "project", projectId: changed.entityId },
        await deps.service.read(),
        ctx,
      );
  }
  async function manage(
    ctx: ExtensionContext,
    catalog: WorkCatalog,
    issues: CatalogIssue[],
    kind: CatalogEntityKind,
    args: string,
  ) {
    const rows = catalogEntitySummaries(catalog, issues, kind).filter((row) =>
      args === "archived" ? row.archived : !row.hidden,
    );
    const selected = await pick(ctx, `Manage ${kind}`, rows);
    if (!selected) return;
    const action =
      args === "rename"
        ? "Rename"
        : await ctx.ui.select(selected.name, [
            "Rename",
            "Edit description",
            ...(kind === "project" ? ["Move to area"] : ["Publication policy"]),
            selected.archived ? "Restore" : "Archive",
          ]);
    let command: CatalogCommand;
    if (action === "Rename") {
      let name = await ctx.ui.input(`New ${kind} name`, selected.name);
      if (name === undefined) return;
      name = catalogName(name);
      command = { kind: "rename", entity: kind, id: selected.id, name };
    } else if (action === "Edit description") {
      let description = await ctx.ui.editor(
        "Description",
        selected.description,
      );
      if (description === undefined) return;
      description = validateDescription(description);
      command = {
        kind: "describe",
        entity: kind,
        id: selected.id,
        description,
      };
    } else if (action === "Move to area") {
      const area = await pick(
        ctx,
        "Destination area",
        catalogEntitySummaries(catalog, issues, "area").filter(
          (area) => !area.archived,
        ),
      );
      if (!area) return;
      command = {
        kind: "move_project",
        projectId: selected.id,
        areaId: area.id,
      };
    } else if (action === "Publication policy") {
      const publication = await policy(
        ctx,
        catalog.areas[selected.id].publication,
      );
      if (publication === undefined) return;
      command = { kind: "set_publication", areaId: selected.id, publication };
    } else if (action === "Archive" || action === "Restore") {
      command = {
        kind: action === "Archive" ? "archive" : "restore",
        entity: kind,
        id: selected.id,
      };
    } else return;
    const details =
      command.kind === "move_project"
        ? `New area: ${catalog.areas[command.areaId].name}.`
        : command.kind === "set_publication"
          ? JSON.stringify(command.publication)
          : command.kind === "rename"
            ? command.name
            : command.kind === "describe"
              ? command.description
              : "Tasks and history remain preserved.";
    await apply(
      ctx,
      catalog,
      command,
      `${action}: ${selected.name}\n${details}\nRouting changes affect new tasks only; existing Datadog items will not move.`,
    );
  }
  for (const kind of ["area", "project"] as const) {
    pi.registerCommand(kind, {
      description: `Select a ${kind} work view or create/manage described ${kind}s`,
      handler: async (raw, ctx) => {
        try {
          const catalog = await deps.catalog.read();
          if (!catalog || catalog.state !== "active") {
            if (kind === "project") return await deps.legacy(raw, ctx);
            ctx.ui.notify(
              "Areas require an explicitly activated work catalog",
              "warning",
            );
            return;
          }
          const issues = await deps.issues();
          const args = raw.trim().toLowerCase();
          if (args === "create" || args === "new")
            return await create(ctx, catalog, issues, kind);
          if (["rename", "manage", "archived"].includes(args))
            return await manage(ctx, catalog, issues, kind, args);
          const rows = catalogEntitySummaries(catalog, issues, kind)
            .filter((row) => !row.hidden)
            .sort(
              (a, b) =>
                (a.areaName ?? "").localeCompare(b.areaName ?? "") ||
                a.name.localeCompare(b.name),
            );
          const labels = rows.map(label);
          const selected = await choose(ctx, `Select ${kind}`, [
            "Global / no project",
            ...labels,
            `Create and select ${kind}…`,
            `Manage ${kind}s…`,
            `Archived ${kind}s…`,
          ]);
          if (selected === undefined) return;
          if (selected === "Global / no project")
            return await deps.select({ kind: "global" }, catalog, ctx);
          if (selected === `Create and select ${kind}…`)
            return await create(ctx, catalog, issues, kind);
          if (selected === `Manage ${kind}s…`)
            return await manage(ctx, catalog, issues, kind, "manage");
          if (selected === `Archived ${kind}s…`)
            return await manage(ctx, catalog, issues, kind, "archived");
          const row = rows[labels.indexOf(selected)];
          if (row)
            await deps.select(
              kind === "area"
                ? { kind: "area", areaId: row.id }
                : { kind: "project", projectId: row.id },
              catalog,
              ctx,
            );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : "Catalog operation failed",
            "warning",
          );
        }
      },
    });
  }
}
