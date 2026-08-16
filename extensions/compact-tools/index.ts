import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const defaultFactories = {
  read: createReadTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
};

type BuiltinFactories = typeof defaultFactories;
type RenderResult = {
  content: Array<{ type: string; text?: string }>;
};
type RenderOptions = {
  expanded: boolean;
  isError: boolean;
};
type RenderTheme = {
  fg(color: string, text: string): string;
};

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function outputText(result: RenderResult): string | undefined {
  const content = result.content.find(
    (item) => item.type === "text" && item.text?.trim(),
  );
  return content?.text;
}

function renderOutput(
  result: RenderResult,
  options: RenderOptions,
  theme: RenderTheme,
  successColor: string,
  showSuccess: boolean,
  maxLines?: number,
): Text {
  if (!options.isError && (!showSuccess || !options.expanded)) {
    return new Text("", 0, 0);
  }

  const output = outputText(result);
  if (!output) return new Text("", 0, 0);
  const lines = output.trim().split("\n").slice(0, maxLines);
  const color = options.isError ? "error" : successColor;
  return new Text(
    `\n${lines.map((line) => theme.fg(color, line)).join("\n")}`,
    0,
    0,
  );
}

export function createCompactTools(
  factories: BuiltinFactories = defaultFactories,
): (pi: ExtensionAPI) => void {
  const toolCache = new Map<
    string,
    {
      read: ReturnType<BuiltinFactories["read"]>;
      grep: ReturnType<BuiltinFactories["grep"]>;
      find: ReturnType<BuiltinFactories["find"]>;
      ls: ReturnType<BuiltinFactories["ls"]>;
      bash: ReturnType<BuiltinFactories["bash"]>;
      edit: ReturnType<BuiltinFactories["edit"]>;
      write: ReturnType<BuiltinFactories["write"]>;
    }
  >();

  function getTools(cwd: string) {
    let tools = toolCache.get(cwd);
    if (!tools) {
      tools = {
        read: factories.read(cwd),
        grep: factories.grep(cwd),
        find: factories.find(cwd),
        ls: factories.ls(cwd),
        bash: factories.bash(cwd),
        edit: factories.edit(cwd),
        write: factories.write(cwd),
      };
      toolCache.set(cwd, tools);
    }
    return tools;
  }

  return function compactTools(pi: ExtensionAPI) {
    pi.registerTool({
      name: "read",
      label: "read",
      description:
        "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
      parameters: getTools(process.cwd()).read.parameters,
      async execute(id, params, signal, onUpdate, ctx) {
        return getTools(ctx.cwd).read.execute(id, params, signal, onUpdate);
      },
      renderCall(args, theme) {
        const path = shortenPath(args.path || "");
        let display = path ? theme.fg("accent", path) : "...";
        if (args.offset || args.limit) {
          const start = args.offset ?? 1;
          const end = args.limit ? start + args.limit - 1 : "";
          display += theme.fg("dim", `:${start}${end ? `-${end}` : ""}`);
        }
        return new Text(`${theme.fg("dim", "read")} ${display}`, 0, 0);
      },
      renderResult(result, options, theme, context) {
        return renderOutput(
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
          "toolOutput",
          false,
        );
      },
    });

    pi.registerTool({
      name: "grep",
      label: "grep",
      description:
        "Search file contents using regular expressions. Supports full regex syntax. Searches are case-sensitive by default. Use the include parameter to filter by file extension.",
      parameters: getTools(process.cwd()).grep.parameters,
      async execute(id, params, signal, onUpdate, ctx) {
        return getTools(ctx.cwd).grep.execute(id, params, signal, onUpdate);
      },
      renderCall(args, theme) {
        const pattern = args.pattern || "...";
        const path = shortenPath(args.path || ".");
        return new Text(
          `${theme.fg("dim", "grep")} ${theme.fg("accent", pattern)} ${theme.fg("dim", path)}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        return renderOutput(
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
          "toolOutput",
          false,
        );
      },
    });

    pi.registerTool({
      name: "find",
      label: "find",
      description:
        "Find files by name pattern using glob syntax. Searches recursively from the specified path.",
      parameters: getTools(process.cwd()).find.parameters,
      async execute(id, params, signal, onUpdate, ctx) {
        return getTools(ctx.cwd).find.execute(id, params, signal, onUpdate);
      },
      renderCall(args, theme) {
        const pattern = args.pattern || "*";
        const path = shortenPath(args.path || ".");
        return new Text(
          `${theme.fg("dim", "find")} ${theme.fg("accent", pattern)} ${theme.fg("dim", path)}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        return renderOutput(
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
          "toolOutput",
          false,
        );
      },
    });

    pi.registerTool({
      name: "ls",
      label: "ls",
      description:
        "List directory contents. Shows file names, sizes, and modification dates.",
      parameters: getTools(process.cwd()).ls.parameters,
      async execute(id, params, signal, onUpdate, ctx) {
        return getTools(ctx.cwd).ls.execute(id, params, signal, onUpdate);
      },
      renderCall(args, theme) {
        const path = shortenPath(args.path || ".");
        return new Text(
          `${theme.fg("dim", "ls")} ${theme.fg("accent", path)}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        return renderOutput(
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
          "toolOutput",
          false,
        );
      },
    });

    pi.registerTool({
      name: "bash",
      label: "bash",
      description:
        "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
      parameters: getTools(process.cwd()).bash.parameters,
      async execute(id, params, signal, onUpdate, ctx) {
        return getTools(ctx.cwd).bash.execute(id, params, signal, onUpdate);
      },
      renderCall(args, theme) {
        const command = args.command || "...";
        const display =
          command.length > 80 ? `${command.slice(0, 77)}...` : command;
        return new Text(theme.fg("dim", `$ ${display}`), 0, 0);
      },
      renderResult(result, options, theme, context) {
        return renderOutput(
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
          "toolOutput",
          true,
          20,
        );
      },
    });

    pi.registerTool({
      name: "edit",
      label: "edit",
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
      parameters: getTools(process.cwd()).edit.parameters,
      async execute(id, params, signal, onUpdate, ctx) {
        return getTools(ctx.cwd).edit.execute(id, params, signal, onUpdate);
      },
      renderCall(args, theme) {
        const path = shortenPath(args.path || "");
        const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
        const info =
          editCount > 1 ? theme.fg("dim", ` (${editCount} edits)`) : "";
        return new Text(
          `${theme.fg("warning", "edit")} ${theme.fg("accent", path)}${info}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        return renderOutput(
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
          "toolOutput",
          true,
        );
      },
    });

    pi.registerTool({
      name: "write",
      label: "write",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      parameters: getTools(process.cwd()).write.parameters,
      async execute(id, params, signal, onUpdate, ctx) {
        return getTools(ctx.cwd).write.execute(id, params, signal, onUpdate);
      },
      renderCall(args, theme) {
        const path = shortenPath(args.path || "");
        const lines = args.content ? args.content.split("\n").length : 0;
        const info = lines > 0 ? theme.fg("dim", ` (${lines} lines)`) : "";
        return new Text(
          `${theme.fg("warning", "write")} ${theme.fg("accent", path)}${info}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        return renderOutput(
          result,
          { expanded: options.expanded, isError: context.isError },
          theme,
          "success",
          true,
        );
      },
    });
  };
}

export default createCompactTools();
