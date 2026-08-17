// Prompt editor adapted directly from Tahir Butt's tb-pi PromptEditor.

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { centralThemeBackground, fillThemeBackground } from "./central-theme.js";

type AutocompleteEditorInternals = {
  autocompleteList?: Pick<Component, "render">;
  isShowingAutocomplete?: () => boolean;
};

const PROMPT_RAIL = " ";
const PROMPT_RAIL_RIGHT_PADDING = 1;

function clampRenderedLines(lines: string[], width: number): string[] {
  const maxWidth = Math.max(0, width);
  return lines.map((line) => truncateToWidth(line, maxWidth, ""));
}

function fillLine(content: string, width: number): string {
  const truncated = truncateToWidth(content, Math.max(0, width), "");
  const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return `${truncated}${pad}`;
}

function renderEntryBlockLine(theme: Theme, content: string, width: number): string {
  const railWidth = Math.min(visibleWidth(PROMPT_RAIL), Math.max(0, width));
  const rightPaddingWidth = Math.min(
    PROMPT_RAIL_RIGHT_PADDING,
    Math.max(0, width - railWidth),
  );
  const bodyWidth = Math.max(0, width - railWidth - rightPaddingWidth);
  const rail = railWidth > 0
    ? centralThemeBackground(" ".repeat(railWidth), "borderAccent", "fgPrompt")
    : "";
  const rightPadding = fillThemeBackground(
    theme,
    "userMessageBg",
    " ".repeat(rightPaddingWidth),
  );
  return `${rail}${rightPadding}${fillThemeBackground(
    theme,
    "userMessageBg",
    fillLine(content, bodyWidth),
  )}`;
}

class PromptEditor extends CustomEditor {
  private readonly uiTheme: Theme;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    uiTheme: Theme,
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
    this.uiTheme = uiTheme;
    this.borderColor = editorTheme.borderColor;
  }

  render(width: number): string[] {
    if (width <= 0) return [""];

    const rendered = super.render(width);
    const internals = this as unknown as AutocompleteEditorInternals;
    const isShowingAutocomplete =
      typeof internals.isShowingAutocomplete === "function"
        ? Boolean(internals.isShowingAutocomplete())
        : false;

    if (rendered.length < 2) {
      return clampRenderedLines(super.render(width), width);
    }

    const autocompleteCount =
      isShowingAutocomplete && typeof internals.autocompleteList?.render === "function"
        ? internals.autocompleteList.render(width).length
        : 0;
    const editorFrame =
      autocompleteCount > 0 && autocompleteCount < rendered.length
        ? rendered.slice(0, -autocompleteCount)
        : rendered;
    const autocompleteLines =
      autocompleteCount > 0 && autocompleteCount < rendered.length
        ? rendered.slice(-autocompleteCount)
        : [];

    if (editorFrame.length < 2) {
      return clampRenderedLines(rendered, width);
    }

    const editorLines = editorFrame.slice(1, -1);
    const entryLines = editorLines.length > 0 ? editorLines : [""];
    const paddedEntryLines = ["", ...entryLines, ""];

    const out = [
      ...paddedEntryLines.map((line) => renderEntryBlockLine(this.uiTheme, line, width)),
      ...autocompleteLines,
      // Keep terminal spacing outside the colored prompt block.
      "",
    ];
    return clampRenderedLines(out, width);
  }
}

let enabled = true;

function installEditor(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !enabled) return;
  ctx.ui.setEditorComponent(
    (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
      new PromptEditor(tui, theme, keybindings, ctx.ui.theme),
  );
}

export default function styledEditor(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    installEditor(ctx);
    // Pi wires extension shortcuts after session_start handlers finish. Reinstall
    // on the next event-loop turn so CustomEditor copies the populated handler.
    setTimeout(() => installEditor(ctx), 0);
    ctx.ui.setFooter(() => ({
      render: () => [],
      invalidate: () => {},
    }));
  });

  pi.on("model_select", async (_event, ctx) => {
    installEditor(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    installEditor(ctx);
  });

  pi.registerCommand("prompt", {
    description: "Toggle the dimmed prompt entry block",
    handler: async (args, ctx) => {
      const input = args.trim().toLowerCase();
      if (input === "off" || input === "disable") enabled = false;
      else if (input === "on" || input === "enable") enabled = true;
      else enabled = !enabled;

      if (enabled) {
        installEditor(ctx);
        ctx.ui.notify("prompt on", "info");
      } else {
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.notify("prompt off", "info");
      }
    },
  });
}
