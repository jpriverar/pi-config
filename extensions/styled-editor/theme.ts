const FULL_SGR_RESET = /\x1b\[(?:0)?m/g;

export const ANSI_RESET = "\x1b[0m";

export function tintInputLine(line: string, backgroundAnsi: string): string {
  const backgroundSafeLine = line.replace(
    FULL_SGR_RESET,
    `${ANSI_RESET}${backgroundAnsi}`,
  );
  return `${backgroundAnsi}${backgroundSafeLine}${ANSI_RESET}`;
}
