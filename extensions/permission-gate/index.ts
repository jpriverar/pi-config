import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface DangerousCommand {
  description: string;
}

function executableName(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

function splitCommand(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;

  const finishWord = () => {
    if (word.length > 0) words.push(word);
    word = "";
  };
  const finishSegment = () => {
    finishWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (
        character === "\\" &&
        quote === '"' &&
        index + 1 < command.length
      ) {
        word += command[++index];
      } else {
        word += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\" && index + 1 < command.length) {
      word += command[++index];
    } else if (character === "\n" || character === "\r") {
      finishSegment();
    } else if (/\s/.test(character)) {
      finishWord();
    } else if (character === ";" || character === "|" || character === "&") {
      finishSegment();
      if (command[index + 1] === character) index++;
    } else {
      word += character;
    }
  }
  finishSegment();
  return segments;
}

function unwrap(words: string[]): string[] {
  let current = words;
  while (current.length > 0) {
    const executable = executableName(current[0]);
    if (executable === "command") {
      let index = 1;
      while (current[index]?.startsWith("-")) index++;
      current = current.slice(index);
      continue;
    }
    if (executable !== "env") return current;

    let index = 1;
    while (index < current.length) {
      const argument = current[index];
      if (argument === "--") {
        index++;
        break;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
        index++;
        continue;
      }
      if (
        argument === "-u" ||
        argument === "--unset" ||
        argument === "-C" ||
        argument === "--chdir"
      ) {
        index += 2;
        continue;
      }
      if (argument.startsWith("-")) {
        index++;
        continue;
      }
      break;
    }
    current = current.slice(index);
  }
  return current;
}

function hasShortFlag(argument: string, flag: string): boolean {
  return /^-[^-]+$/.test(argument) && argument.slice(1).includes(flag);
}

function inspectWords(
  words: string[],
  depth: number,
): DangerousCommand | undefined {
  if (executableName(words[0]) === "env" && depth < 4) {
    const splitIndex = words.findIndex(
      (argument) => argument === "-S" || argument === "--split-string",
    );
    if (splitIndex !== -1 && words[splitIndex + 1]) {
      return findDangerousCommand(words[splitIndex + 1], depth + 1);
    }
    const inlineSplit = words.find((argument) =>
      argument.startsWith("--split-string="),
    );
    if (inlineSplit) {
      return findDangerousCommand(
        inlineSplit.slice("--split-string=".length),
        depth + 1,
      );
    }
  }

  const command = unwrap(words);
  if (command.length === 0) return undefined;
  const executable = executableName(command[0]);
  const args = command.slice(1);

  if (["sh", "bash", "dash", "zsh", "ksh"].includes(executable) && depth < 4) {
    const commandIndex = args.findIndex((argument) =>
      /^-[^-]*c[^-]*$/.test(argument),
    );
    if (commandIndex !== -1 && args[commandIndex + 1]) {
      return findDangerousCommand(args[commandIndex + 1], depth + 1);
    }
  }

  if (executable === "sudo") return { description: "sudo" };
  if (executable === "killall") return { description: "killall" };
  if (executable === "fdisk") return { description: "fdisk" };
  if (executable === "mkfs" || executable.startsWith("mkfs.")) {
    return { description: "filesystem formatting" };
  }
  if (
    executable === "dd" &&
    args.some((argument) => argument.startsWith("if="))
  ) {
    return { description: "raw device copy" };
  }

  const recursive = args.some(
    (argument) =>
      argument === "--recursive" ||
      hasShortFlag(argument, "r") ||
      hasShortFlag(argument, "R"),
  );
  const targetsRoot = args.includes("/");
  if (executable === "rm" && recursive && targetsRoot) {
    return { description: "recursive root removal" };
  }
  if (
    executable === "chmod" &&
    recursive &&
    targetsRoot &&
    args.includes("777")
  ) {
    return { description: "recursive world-writable root permissions" };
  }
  if (executable === "chown" && recursive && targetsRoot) {
    return { description: "recursive root ownership change" };
  }

  if (executable === "git") {
    const pushIndex = args.indexOf("push");
    if (
      pushIndex !== -1 &&
      args
        .slice(pushIndex + 1)
        .some(
          (argument) =>
            argument === "-f" || /^--force(?:$|[-=])/.test(argument),
        )
    ) {
      return { description: "force push" };
    }
  }
  return undefined;
}

function findDangerousCommand(
  command: string,
  depth = 0,
): DangerousCommand | undefined {
  for (const words of splitCommand(command)) {
    const danger = inspectWords(words, depth);
    if (danger) return danger;
  }
  return undefined;
}

export default function permissionGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = event.input?.command;
    if (typeof command !== "string") return;
    const danger = findDangerousCommand(command);
    if (danger) {
      return {
        block: true,
        reason: `Denied by permission gate: ${danger.description}`,
      };
    }
  });
}
