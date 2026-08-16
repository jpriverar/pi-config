import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

import { tintInputLine } from "./theme.js";

type AutocompleteRenderer = {
  render(width: number): string[];
};

type EditorAutocompleteInternals = {
  autocompleteList?: AutocompleteRenderer;
  autocompleteState?: unknown;
};

type PostStartScheduler = (callback: () => void) => void;

const scheduleAfterStartup: PostStartScheduler = (callback) => {
  setTimeout(callback, 0);
};

function autocompleteLineCount(editor: StyledEditor, width: number): number {
  if (!editor.isShowingAutocomplete()) return 0;

  // Pi 0.84.1 exposes autocomplete visibility but not the rendered row count.
  // Keep the one private-field cast here so only the input block receives the tint.
  const internals = editor as unknown as EditorAutocompleteInternals;
  if (!internals.autocompleteState || !internals.autocompleteList) return 0;

  const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
  const padding = Math.min(editor.getPaddingX(), maxPadding);
  const contentWidth = Math.max(1, width - padding * 2);
  return internals.autocompleteList.render(contentWidth).length;
}

export class StyledEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const autocompleteRows = autocompleteLineCount(this, width);
    const inputRowCount = lines.length - autocompleteRows;

    return [
      ...lines
        .slice(0, inputRowCount)
        .map((line) => tintInputLine(truncateToWidth(line, width, ""))),
      ...lines
        .slice(inputRowCount)
        .map((line) => truncateToWidth(line, width, "")),
      "",
    ];
  }
}

function hiddenFooter() {
  return {
    invalidate() {},
    render(): string[] {
      return [];
    },
  };
}

export function createStyledEditorExtension(
  schedule: PostStartScheduler = scheduleAfterStartup,
) {
  return function styledEditorExtension(pi: ExtensionAPI): void {
    let styled = true;
    let sessionGeneration = 0;

    const install = (ctx: ExtensionContext) => {
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => new StyledEditor(tui, theme, keybindings),
      );
    };

    pi.registerCommand("prompt", {
      description: "Toggle the styled prompt",
      handler: async (_args, ctx) => {
        styled = !styled;
        if (styled) install(ctx);
        else ctx.ui.setEditorComponent(undefined);
      },
    });

    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;

      const generation = ++sessionGeneration;
      ctx.ui.setFooter(() => hiddenFooter());
      if (styled) install(ctx);

      // Pi wires extension shortcuts after session_start. Reinstall on the next
      // macrotask so the replacement editor inherits those completed bindings.
      schedule(() => {
        if (styled && generation === sessionGeneration) install(ctx);
      });
    });

    pi.on("session_shutdown", () => {
      sessionGeneration++;
    });
  };
}

export default createStyledEditorExtension();
