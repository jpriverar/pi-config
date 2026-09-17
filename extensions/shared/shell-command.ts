export type ShellToken = {
  value: string;
  quoted: boolean;
};

export type ShellCommand = {
  tokens: ShellToken[];
  source: string;
  executableTokenIndex?: number;
};

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const EXECUTION_WRAPPERS = new Set(["command", "env", "exec", "time"]);
const CONTROL_COMMAND_PREFIXES = new Set([
  "!",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "until",
  "while",
]);
const ENV_OPTIONS_WITH_ARGUMENT = new Set(["-u", "--unset"]);

export function splitShellCommands(command: string): ShellCommand[] {
  const sources = splitCompoundCommand(command);
  return sources.map((source) => {
    const tokens = tokenize(source);
    const executableTokenIndex = findExecutableTokenIndex(tokens, 0);

    return {
      source,
      tokens,
      executableTokenIndex:
        executableTokenIndex === -1 ? undefined : executableTokenIndex,
    };
  });
}

export function unwrapExecutable(
  command: ShellCommand,
): { executable: string; args: string[] } | undefined {
  const index =
    command.executableTokenIndex ?? findExecutableTokenIndex(command.tokens, 0);
  if (index === -1 || index >= command.tokens.length) return undefined;

  return {
    executable: command.tokens[index].value,
    args: command.tokens.slice(index + 1).map((token) => token.value),
  };
}

function splitCompoundCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escape = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      pushSegment(segments, current);
      current = "";
      continue;
    }
    if (char === "|") {
      pushSegment(segments, current);
      current = "";
      if (command[i + 1] === "|") i += 1;
      continue;
    }
    if (char === "&" && command[i + 1] === "&") {
      pushSegment(segments, current);
      current = "";
      i += 1;
      continue;
    }

    current += char;
  }

  pushSegment(segments, current);
  return segments;
}

function tokenize(segment: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let quoted = false;
  let escape = false;

  const pushToken = () => {
    if (current.length === 0) {
      quoted = false;
      return;
    }
    tokens.push({ value: current, quoted });
    current = "";
    quoted = false;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
      continue;
    }

    current += char;
  }

  pushToken();
  return tokens;
}

function findExecutableTokenIndex(tokens: ShellToken[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.quoted) return -1;
    if (CONTROL_COMMAND_PREFIXES.has(token.value)) {
      index += 1;
      continue;
    }
    if (ASSIGNMENT_PATTERN.test(token.value)) {
      index += 1;
      continue;
    }
    if (EXECUTION_WRAPPERS.has(token.value)) {
      index = skipWrapperPreamble(tokens, index + 1, token.value);
      continue;
    }
    return index;
  }
  return -1;
}

function skipWrapperPreamble(
  tokens: ShellToken[],
  start: number,
  wrapper: string,
): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.quoted) return index;
    if (token.value === "--") return index + 1;
    if (ASSIGNMENT_PATTERN.test(token.value)) {
      index += 1;
      continue;
    }
    if (wrapper === "env" && ENV_OPTIONS_WITH_ARGUMENT.has(token.value)) {
      index += 2;
      continue;
    }
    if (token.value.startsWith("-") && wrapperAllowsFlags(wrapper)) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function wrapperAllowsFlags(wrapper: string): boolean {
  return wrapper === "command" || wrapper === "env" || wrapper === "time";
}

function pushSegment(segments: string[], segment: string) {
  const trimmed = segment.trim();
  if (trimmed.length > 0) segments.push(trimmed);
}
