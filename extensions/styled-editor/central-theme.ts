import type { Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ThemeValue = string | number;

type CentralThemeJson = {
  vars?: Record<string, ThemeValue>;
  colors: Record<string, ThemeValue>;
  export?: Record<string, ThemeValue | undefined>;
  name?: string;
};

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
export const CENTRAL_THEME_PATH = resolve(THIS_DIR, "../../themes/modus-vivendi-tinted.json");

let cachedTheme: CentralThemeJson | undefined;

export function readCentralTheme(): CentralThemeJson {
  if (!cachedTheme) {
    cachedTheme = JSON.parse(readFileSync(CENTRAL_THEME_PATH, "utf8")) as CentralThemeJson;
  }
  return cachedTheme;
}

export function resolveCentralThemeValue(value: ThemeValue | undefined): ThemeValue | undefined {
  if (value === undefined) return undefined;
  const vars = readCentralTheme().vars ?? {};
  let current = value;
  const seen = new Set<string>();
  while (typeof current === "string" && Object.prototype.hasOwnProperty.call(vars, current)) {
    if (seen.has(current)) break;
    seen.add(current);
    current = vars[current]!;
  }
  return current;
}

export function resolveCentralThemeColors(): Record<string, ThemeValue> {
  const theme = readCentralTheme();
  return Object.fromEntries(
    Object.entries(theme.colors).map(([key, value]) => [key, resolveCentralThemeValue(value) ?? value]),
  );
}

export function resolveCentralThemeExportColors(): Record<string, ThemeValue> {
  const theme = readCentralTheme();
  return Object.fromEntries(
    Object.entries(theme.export ?? {})
      .map(([key, value]) => [key, resolveCentralThemeValue(value)])
      .filter((entry): entry is [string, ThemeValue] => entry[1] !== undefined && entry[1] !== ""),
  );
}

export function centralThemeCssColor(key: string, fallbackKey?: string): string {
  const colors = resolveCentralThemeColors();
  const vars = readCentralTheme().vars ?? {};
  const value = normalizeCssColor(colors[key] ?? vars[key]);
  if (value) return value;
  if (fallbackKey) {
    const fallback = normalizeCssColor(colors[fallbackKey] ?? vars[fallbackKey]);
    if (fallback) return fallback;
  }
  const fallback = normalizeCssColor(colors.fgAlt ?? vars.fgAlt);
  if (!fallback) throw new Error(`Central theme color ${key} is empty and no fallback is available`);
  return fallback;
}

export function centralThemeExportCssColor(key: string, fallbackKey: string): string {
  const exportColors = resolveCentralThemeExportColors();
  const value = normalizeCssColor(exportColors[key]);
  return value ?? centralThemeCssColor(fallbackKey);
}

export function centralThemeBackground(text: string, key: string, fallbackKey?: string): string {
  // Pi's public theme.bg() only accepts background tokens. Resolve the central
  // theme's foreground accent and emit a background SGR for the prompt rail.
  const ansi = backgroundAnsiFromCssColor(centralThemeCssColor(key, fallbackKey));
  return ansi ? `${ansi}${text}\x1b[49m` : text;
}

const SGR_SEQUENCE = /\x1b\[([0-9;]*)m/g;

export function fillThemeBackground(
  theme: Theme,
  color: Parameters<Theme["bg"]>[0],
  text: string,
): string {
  const backgroundAnsi = theme.getBgAnsi(color);
  if (!backgroundAnsi) return text;

  // Pi's fake cursor emits SGR 0, clearing an enclosing background. Reapply
  // the requested background after full or background-only resets.
  const repaired = text.replace(SGR_SEQUENCE, (sequence, rawCodes: string) => {
    const codes = rawCodes === "" ? [0] : rawCodes.split(";").map(Number);
    return codes.includes(0) || codes.includes(49)
      ? `${sequence}${backgroundAnsi}`
      : sequence;
  });
  return theme.bg(color, repaired);
}

function backgroundAnsiFromCssColor(value: string): string | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const raw = match[1]!;
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return `\x1b[48;2;${red};${green};${blue}m`;
}

function normalizeCssColor(value: ThemeValue | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return undefined;
  return value;
}
