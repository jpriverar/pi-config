const FULL_SGR_RESET = /\x1b\[(?:0)?m/g;

export const INPUT_BACKGROUND_ANSI = "\x1b[48;2;30;30;30m";
export const ANSI_RESET = "\x1b[0m";

export function tintInputLine(line: string): string {
  const backgroundSafeLine = line.replace(
    FULL_SGR_RESET,
    `${ANSI_RESET}${INPUT_BACKGROUND_ANSI}`,
  );
  return `${INPUT_BACKGROUND_ANSI}${backgroundSafeLine}${ANSI_RESET}`;
}
