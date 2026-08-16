import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const WIDGET_KEY = "plan-progress";

interface PlanStep {
  number: number;
  text: string;
  done: boolean;
}

interface PlanState {
  steps: PlanStep[];
  planMarkdown?: string;
  specMarkdown?: string;
}

interface PanelHandle {
  hide(): void;
}

export default function planProgress(pi: ExtensionAPI) {
  let steps: PlanStep[] = [];
  let planMarkdown: string | undefined;
  let specMarkdown: string | undefined;
  let panelHandle: PanelHandle | null = null;

  function updateWidget(ctx: ExtensionContext): void {
    if (steps.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const theme = ctx.ui.theme;
    const completed = steps.filter((step) => step.done).length;
    const total = steps.length;

    if (completed === total) {
      ctx.ui.setWidget(WIDGET_KEY, [
        theme.fg("success", `✓ Plan complete (${total}/${total})`),
      ]);
      return;
    }

    const nextStep = steps.find((step) => !step.done)?.number;
    ctx.ui.setWidget(WIDGET_KEY, [
      theme.fg("accent", `Plan (${completed}/${total})`),
      ...steps.map((step) => {
        if (step.done) {
          return `  ${theme.fg("success", "☑")} ${theme.fg("muted", step.text)}`;
        }
        const prefix = `  ${theme.fg("dim", "☐")} `;
        return step.number === nextStep
          ? prefix + theme.fg("text", step.text)
          : prefix + theme.fg("dim", step.text);
      }),
    ]);
  }

  function persistState(): void {
    pi.appendEntry("plan-progress", {
      steps,
      planMarkdown,
      specMarkdown,
    } satisfies PlanState);
  }

  function planContent(): string | undefined {
    return (
      planMarkdown ||
      (steps.length > 0
        ? steps
            .map(
              (step) =>
                `${step.done ? "☑" : "☐"} ${step.number}. ${step.text}`,
            )
            .join("\n")
        : undefined)
    );
  }

  async function showDocument(
    ctx: ExtensionContext,
    docContent: string | undefined,
    docTitle: string,
  ): Promise<void> {
    if (!docContent) {
      ctx.ui.notify(`No ${docTitle.toLowerCase()} to display`, "info");
      return;
    }

    if (panelHandle) {
      panelHandle.hide();
      panelHandle = null;
    }

    await ctx.ui.custom<null>(
      (tui, theme, _keybindings, done) => {
        const markdown = new Markdown(docContent, 0, 0, getMarkdownTheme());
        let scrollOffset = 0;
        let allLines: string[] = [];
        let lastWidth = 0;

        function rebuildLines(width: number): void {
          allLines = markdown.render(width - 6);
          lastWidth = width;
        }

        const terminalRows = process.stdout.rows || 40;
        const viewportLines = Math.max(10, Math.floor(terminalRows * 0.7) - 2);

        return {
          render(width: number) {
            if (width !== lastWidth) rebuildLines(width);

            const innerWidth = width - 4;
            const maxScroll = Math.max(0, allLines.length - viewportLines);
            scrollOffset = Math.min(scrollOffset, maxScroll);
            const side = theme.fg("border", "│");
            const body = allLines
              .slice(scrollOffset, scrollOffset + viewportLines)
              .map((line) => {
                const truncated = truncateToWidth(line, innerWidth);
                const padding = Math.max(
                  0,
                  innerWidth - visibleWidth(truncated),
                );
                return `${side} ${truncated}${" ".repeat(padding)} ${side}`;
              });

            while (body.length < viewportLines) {
              body.push(`${side} ${" ".repeat(innerWidth)} ${side}`);
            }

            const scrollInfo =
              allLines.length > viewportLines
                ? ` [${scrollOffset + 1}-${Math.min(scrollOffset + viewportLines, allLines.length)}/${allLines.length}]`
                : "";
            const helpText = `↑↓ scroll • esc close${scrollInfo}`;
            const topFill = Math.max(0, width - 5 - visibleWidth(docTitle));
            const bottomFill = Math.max(0, width - 5 - visibleWidth(helpText));
            const topLine = `${theme.fg("border", "┌─")} ${theme.fg("accent", theme.bold(docTitle))} ${theme.fg("border", "─".repeat(topFill) + "┐")}`;
            const bottomLine = `${theme.fg("border", "└─")} ${theme.fg("dim", helpText)} ${theme.fg("border", "─".repeat(bottomFill) + "┘")}`;

            return [topLine, ...body, bottomLine];
          },
          invalidate() {
            markdown.invalidate();
            lastWidth = 0;
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
              done(null);
            } else if (matchesKey(data, Key.up)) {
              scrollOffset = Math.max(0, scrollOffset - 1);
              tui.requestRender();
            } else if (matchesKey(data, Key.down)) {
              scrollOffset += 1;
              tui.requestRender();
            } else if (matchesKey(data, Key.home)) {
              scrollOffset = 0;
              tui.requestRender();
            } else if (matchesKey(data, Key.end)) {
              scrollOffset = allLines.length;
              tui.requestRender();
            }
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "80%",
          minWidth: 60,
          maxHeight: "80%",
        },
        onHandle(handle) {
          panelHandle = handle;
        },
      },
    );

    panelHandle = null;
  }

  pi.registerTool({
    name: "set_plan",
    label: "Set plan",
    description:
      "Register an active plan for progress tracking. Call this after producing " +
      "a numbered implementation plan so the user sees a live progress widget.",
    parameters: Type.Object({
      steps: Type.Array(Type.String(), {
        description: "Ordered list of step descriptions.",
      }),
      markdown: Type.Optional(
        Type.String({
          description: "Full plan markdown for side-panel display.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      steps = params.steps.map((text, index) => ({
        number: index + 1,
        text,
        done: false,
      }));
      planMarkdown = params.markdown;
      updateWidget(ctx);
      persistState();
      return {
        content: [
          {
            type: "text" as const,
            text: `Plan registered (${steps.length} steps). Widget visible to user.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "complete_step",
    label: "Complete step",
    description:
      "Mark a plan step as done. Call this after completing each step in the " +
      "active plan. The progress widget updates immediately for the user.",
    parameters: Type.Object({
      step: Type.Number({
        description: "Step number to mark complete (1-indexed).",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = steps.find(
        (step) => step.number === params.step && !step.done,
      );
      if (!target) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Step ${params.step} not found or already complete.`,
            },
          ],
          details: {},
        };
      }

      target.done = true;
      updateWidget(ctx);
      persistState();

      const remaining = steps.filter((step) => !step.done).length;
      return {
        content: [
          {
            type: "text" as const,
            text:
              remaining === 0
                ? "All steps complete. Plan finished."
                : `Step ${params.step} done. ${remaining} remaining.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "set_spec",
    label: "Set spec",
    description:
      "Store a spec or design document for side-panel display. The user can " +
      "view it anytime via Ctrl+Alt+S without scrolling back through conversation.",
    parameters: Type.Object({
      markdown: Type.String({
        description: "Full spec/design document in markdown.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      specMarkdown = params.markdown;
      persistState();
      ctx.ui.notify("Spec stored — Ctrl+Alt+S to view", "info");
      return {
        content: [
          {
            type: "text" as const,
            text: "Spec stored. User can view via Ctrl+Alt+S.",
          },
        ],
        details: {},
      };
    },
  });

  pi.on("before_agent_start", async () => {
    if (steps.length === 0 || steps.every((step) => step.done)) return;

    const remaining = steps.filter((step) => !step.done);
    const list = remaining
      .map((step) => `${step.number}. ${step.text}`)
      .join("\n");
    return {
      message: {
        customType: "plan-progress-context",
        content: `[ACTIVE PLAN — ${remaining.length} steps remaining]\n\nRemaining steps:\n${list}\n\nCall complete_step({ step: N }) after finishing each step.`,
        display: false,
      },
    };
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (steps.length > 0 && steps.every((step) => step.done)) {
      steps = [];
      planMarkdown = undefined;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      persistState();
    }
  });

  pi.registerCommand("plan-clear", {
    description: "Clear the plan progress widget and stored plan",
    handler: async (_args, ctx) => {
      steps = [];
      planMarkdown = undefined;
      panelHandle?.hide();
      panelHandle = null;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      persistState();
      ctx.ui.notify("Plan cleared", "info");
    },
  });

  pi.registerCommand("plan-view", {
    description: "Show plan in a panel",
    handler: async (_args, ctx) => {
      await showDocument(ctx, planContent(), "📋 Plan");
    },
  });

  pi.registerCommand("spec-view", {
    description: "Show spec in a panel",
    handler: async (_args, ctx) => {
      await showDocument(ctx, specMarkdown, "📄 Spec");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "View plan panel",
    handler: async (ctx) => {
      if (panelHandle) {
        panelHandle.hide();
        panelHandle = null;
      } else {
        await showDocument(ctx, planContent(), "📋 Plan");
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt("s"), {
    description: "View spec panel",
    handler: async (ctx) => {
      if (panelHandle) {
        panelHandle.hide();
        panelHandle = null;
      } else {
        await showDocument(ctx, specMarkdown, "📄 Spec");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // The extension instance can outlive a session, so clear closure state before restoring it.
    steps = [];
    planMarkdown = undefined;
    specMarkdown = undefined;
    panelHandle?.hide();
    panelHandle = null;
    updateWidget(ctx);

    const planEntry = ctx.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry.type === "custom" && entry.customType === "plan-progress",
      )
      .pop() as { data?: PlanState } | undefined;

    if (!planEntry?.data) return;
    steps = planEntry.data.steps ?? [];
    planMarkdown = planEntry.data.planMarkdown;
    specMarkdown = planEntry.data.specMarkdown;
    updateWidget(ctx);
  });
}
