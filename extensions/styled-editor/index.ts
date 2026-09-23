// Prompt editor adapted directly from Tahir Butt's tb-pi PromptEditor.

import { statfs as readStatfs } from "node:fs/promises";
import { homedir } from "node:os";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorTheme,
  sliceByColumn,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

type AutocompleteEditorInternals = {
  autocompleteList?: Pick<Component, "render">;
  isShowingAutocomplete?: () => boolean;
};

type DiskSpaceDependencies = {
  homePath: string;
  statfs(path: string): Promise<{ bavail: bigint; bsize: bigint }>;
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
};

type RuntimeStatusSegment = {
  color: ThemeColor;
  text: string;
  separatorBefore?: "bullet" | "bar";
};
type DiskStatus = { color: ThemeColor; text: string };

const PROMPT_RAIL = "█";
const PROMPT_RAIL_RIGHT_PADDING = 1;
const DISK_ICON = "⛁";
const GiB = 1024n ** 3n;
const POLL_INTERVAL_MILLISECONDS = 60_000;
const WARNING_FREE_BYTES = 150n * GiB;
const ERROR_FREE_BYTES = 80n * GiB;

const runtimeDiskSpaceDependencies: DiskSpaceDependencies = {
  homePath: homedir(),
  async statfs(path) {
    const stats = await readStatfs(path, { bigint: true });
    return { bavail: stats.bavail, bsize: stats.bsize };
  },
  setInterval,
  clearInterval,
};

function clampRenderedLines(lines: string[], width: number): string[] {
  const maxWidth = Math.max(0, width);
  return lines.map((line) => truncateToWidth(line, maxWidth, ""));
}

function fillLine(content: string, width: number): string {
  const truncated = truncateToWidth(content, Math.max(0, width), "");
  const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return `${truncated}${pad}`;
}

const SGR_SEQUENCE = /\x1b\[([0-9;]*)m/g;

function fillThemeBackground(
  theme: Theme,
  color: Parameters<Theme["bg"]>[0],
  text: string,
): string {
  const backgroundAnsi = theme.getBgAnsi(color);
  if (!backgroundAnsi) return text;

  // Pi's fake cursor emits SGR 0, clearing an enclosing background.
  const repaired = text.replace(SGR_SEQUENCE, (sequence, rawCodes: string) => {
    const codes = rawCodes === "" ? [0] : rawCodes.split(";").map(Number);
    return codes.includes(0) || codes.includes(49)
      ? `${sequence}${backgroundAnsi}`
      : sequence;
  });
  return theme.bg(color, repaired);
}

function renderEntryBlockLine(
  theme: Theme,
  content: string,
  width: number,
): string {
  const railWidth = Math.min(visibleWidth(PROMPT_RAIL), Math.max(0, width));
  const rightPaddingWidth = Math.min(
    PROMPT_RAIL_RIGHT_PADDING,
    Math.max(0, width - railWidth),
  );
  const bodyWidth = Math.max(0, width - railWidth - rightPaddingWidth);
  const rail =
    railWidth > 0
      ? theme.fg("borderAccent", PROMPT_RAIL.repeat(railWidth))
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

function stripZeroFraction(value: string): string {
  return value.replace(/\.0$/, "");
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) {
    return `${stripZeroFraction((count / 1_000).toFixed(1))}k`;
  }
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) {
    return `${stripZeroFraction((count / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(count / 1_000_000)}M`;
}

function formatFreeGiB(freeBytes: bigint): string {
  const wholeGiB = freeBytes / GiB;
  const tenths = ((freeBytes % GiB) * 10n) / GiB;
  return tenths === 0n ? `${wholeGiB}G` : `${wholeGiB}.${tenths}G`;
}

function sanitizeInlineStatus(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRuntimeStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  diskStatus: DiskStatus | undefined,
): RuntimeStatusSegment[] {
  const segments: RuntimeStatusSegment[] = [];
  const model = sanitizeInlineStatus(ctx.model?.name || ctx.model?.id || "")
    .replace(/^Claude /, "")
    .replace(/\s*\(AI Gateway.*\)$/, "");
  if (model) segments.push({ color: "dim", text: model });

  const effort = sanitizeInlineStatus(pi.getThinkingLevel() || "");
  if (effort && effort !== "off") {
    segments.push({
      color: "dim",
      text: effort.toUpperCase(),
      separatorBefore: "bullet",
    });
  }

  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  const percent =
    usage?.percent ??
    (usage?.tokens != null && contextWindow
      ? (usage.tokens / contextWindow) * 100
      : null);
  if (percent != null) {
    const rounded = Math.round(percent);
    const detail =
      usage?.tokens != null && contextWindow
        ? ` (${formatTokenCount(usage.tokens)}/${formatTokenCount(contextWindow)})`
        : "";
    segments.push({
      color: rounded > 90 ? "error" : rounded > 70 ? "warning" : "dim",
      text: `${rounded}%${detail}`,
      separatorBefore: "bar",
    });
  }

  if (diskStatus) {
    segments.push({ ...diskStatus, separatorBefore: "bar" });
  }
  return segments;
}

function runtimeStatusSeparator(
  segment: RuntimeStatusSegment,
  index: number,
): string {
  if (index === 0) return "";
  return segment.separatorBefore === "bullet" ? " • " : " | ";
}

function runtimeStatusWidth(segments: RuntimeStatusSegment[]): number {
  return segments.reduce(
    (total, segment, index) =>
      total +
      visibleWidth(runtimeStatusSeparator(segment, index)) +
      visibleWidth(segment.text),
    0,
  );
}

function truncateFromLeft(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text;
  if (width <= 0) return "";
  if (width === 1) return "…";
  return `…${sliceByColumn(text, textWidth - width + 1, width - 1, true)}`;
}

function fitRuntimeStatus(
  segments: RuntimeStatusSegment[],
  maxWidth: number,
): { omitted: boolean; segments: RuntimeStatusSegment[] } {
  if (maxWidth <= 0 || segments.length === 0) {
    return { omitted: false, segments: [] };
  }

  for (let start = 0; start < segments.length; start++) {
    const suffix = segments.slice(start);
    const markerWidth = start === 0 ? 0 : visibleWidth("… | ");
    if (markerWidth + runtimeStatusWidth(suffix) <= maxWidth) {
      return { omitted: start > 0, segments: suffix };
    }
  }

  const last = segments.at(-1);
  return last
    ? {
        omitted: false,
        segments: [{ ...last, text: truncateFromLeft(last.text, maxWidth) }],
      }
    : { omitted: false, segments: [] };
}

function renderRuntimeContent(
  theme: Theme,
  segments: RuntimeStatusSegment[],
  maxWidth: number,
): string {
  const fitted = fitRuntimeStatus(segments, maxWidth);
  const renderedSegments = fitted.segments
    .map(
      (segment, index) =>
        theme.fg("dim", runtimeStatusSeparator(segment, index)) +
        theme.fg(segment.color, segment.text),
    )
    .join("");
  return `${fitted.omitted ? theme.fg("dim", "… | ") : ""}${renderedSegments}`;
}

function renderRuntimeStatusLine(
  theme: Theme,
  segments: RuntimeStatusSegment[],
  width: number,
): string {
  if (width <= 0) return "";
  const railWidth = Math.min(visibleWidth(PROMPT_RAIL), width);
  const rail = theme.fg("borderAccent", PROMPT_RAIL.repeat(railWidth));
  const bodyWidth = Math.max(0, width - railWidth);
  const content = renderRuntimeContent(
    theme,
    segments,
    Math.max(0, bodyWidth - 1),
  );
  const leftPadding = " ".repeat(
    Math.max(0, bodyWidth - visibleWidth(content) - 1),
  );
  const row = `${leftPadding}${content}${bodyWidth > 0 ? " " : ""}`;
  return `${rail}${fillThemeBackground(theme, "customMessageBg", row)}`;
}

function renderPlainRuntimeStatusLine(
  theme: Theme,
  segments: RuntimeStatusSegment[],
  width: number,
): string {
  if (width <= 0) return "";
  const content = renderRuntimeContent(theme, segments, Math.max(0, width - 1));
  const leftPadding = " ".repeat(
    Math.max(0, width - visibleWidth(content) - 1),
  );
  return `${leftPadding}${content}${width > 0 ? " " : ""}`;
}

class PromptEditor extends CustomEditor {
  private readonly uiTheme: Theme;
  private readonly getRuntimeStatus: () => RuntimeStatusSegment[];

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    uiTheme: Theme,
    getRuntimeStatus: () => RuntimeStatusSegment[],
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
    this.uiTheme = uiTheme;
    this.getRuntimeStatus = getRuntimeStatus;
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
      isShowingAutocomplete &&
      typeof internals.autocompleteList?.render === "function"
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
    const runtimeStatus = this.getRuntimeStatus();
    const statusLines =
      runtimeStatus.length > 0
        ? [renderRuntimeStatusLine(this.uiTheme, runtimeStatus, width)]
        : [];

    const out = [
      ...paddedEntryLines.map((line) =>
        renderEntryBlockLine(this.uiTheme, line, width),
      ),
      ...statusLines,
      ...autocompleteLines,
      // Keep terminal spacing outside the colored prompt block.
      "",
    ];
    return clampRenderedLines(out, width);
  }
}

let enabled = true;

export default function styledEditor(
  pi: ExtensionAPI,
  diskDeps: DiskSpaceDependencies = runtimeDiskSpaceDependencies,
): void {
  let currentContext: ExtensionContext | undefined;
  let currentDiskStatus: DiskStatus | undefined;
  let diskPollTimer: unknown;
  let sessionGeneration = 0;
  let requestRender: (() => void) | undefined;

  const getRuntimeStatus = (): RuntimeStatusSegment[] =>
    currentContext
      ? buildRuntimeStatus(pi, currentContext, currentDiskStatus)
      : [];

  function installEditor(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !enabled) return;
    ctx.ui.setEditorComponent(
      (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
        requestRender = () => tui.requestRender();
        return new PromptEditor(
          tui,
          theme,
          keybindings,
          ctx.ui.theme,
          getRuntimeStatus,
        );
      },
    );
  }

  function installFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter((tui: TUI, theme: Theme) => {
      requestRender = () => tui.requestRender();
      return {
        render(width: number) {
          if (enabled) return [];
          const segments = getRuntimeStatus();
          return segments.length > 0
            ? [renderPlainRuntimeStatusLine(theme, segments, width)]
            : [];
        },
        invalidate() {},
      };
    });
  }

  function isCurrentSession(generation: number): boolean {
    return generation === sessionGeneration && currentContext !== undefined;
  }

  function clearDiskTimer(): void {
    if (diskPollTimer === undefined) return;
    diskDeps.clearInterval(diskPollTimer);
    diskPollTimer = undefined;
  }

  async function refreshDisk(
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    try {
      const stats = await diskDeps.statfs(diskDeps.homePath);
      if (!isCurrentSession(generation)) return;
      const freeBytes = stats.bavail * stats.bsize;
      currentDiskStatus = {
        color:
          freeBytes >= WARNING_FREE_BYTES
            ? "dim"
            : freeBytes >= ERROR_FREE_BYTES
              ? "warning"
              : "error",
        text: `${DISK_ICON} ${formatFreeGiB(freeBytes)}`,
      };
    } catch {
      if (!isCurrentSession(generation)) return;
      currentDiskStatus = { color: "error", text: `${DISK_ICON} ?` };
    }
    requestRender?.();
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;
    clearDiskTimer();
    currentContext = ctx;
    currentDiskStatus = undefined;
    installFooter(ctx);
    installEditor(ctx);
    // Pi wires extension shortcuts after session_start handlers finish. Reinstall
    // on the next event-loop turn so CustomEditor copies the populated handler.
    setTimeout(() => {
      if (isCurrentSession(generation)) installEditor(ctx);
    }, 0);
    requestRender?.();

    if (ctx.mode !== "tui") return;
    await refreshDisk(ctx, generation);
    if (!isCurrentSession(generation)) return;
    diskPollTimer = diskDeps.setInterval(() => {
      void refreshDisk(ctx, generation);
    }, POLL_INTERVAL_MILLISECONDS);
    (diskPollTimer as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", async () => {
    sessionGeneration += 1;
    clearDiskTimer();
    currentContext = undefined;
    currentDiskStatus = undefined;
    requestRender?.();
    requestRender = undefined;
  });

  pi.on("model_select", async (_event, ctx) => {
    currentContext = ctx;
    installEditor(ctx);
    requestRender?.();
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    currentContext = ctx;
    installEditor(ctx);
    requestRender?.();
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentContext = ctx;
    requestRender?.();
  });

  pi.registerCommand("prompt", {
    description: "Toggle the dimmed prompt entry block",
    handler: async (args, ctx) => {
      const input = args.trim().toLowerCase();
      if (input === "off" || input === "disable") enabled = false;
      else if (input === "on" || input === "enable") enabled = true;
      else enabled = !enabled;

      currentContext = ctx;
      if (enabled) {
        installEditor(ctx);
        ctx.ui.notify("prompt on", "info");
      } else {
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.notify("prompt off", "info");
      }
      requestRender?.();
    },
  });
}
