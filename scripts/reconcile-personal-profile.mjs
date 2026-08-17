#!/usr/bin/env node

import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {object} FileOperations
 * @property {(path: string) => Promise<import("node:fs").Stats>} lstat
 * @property {(path: string, options?: import("node:fs").MakeDirectoryOptions & { recursive?: boolean }) => Promise<string | undefined>} mkdir
 * @property {(path: string, encoding: BufferEncoding) => Promise<string>} readFile
 * @property {(oldPath: string, newPath: string) => Promise<void>} rename
 * @property {(path: string, options?: import("node:fs").RmOptions) => Promise<void>} rm
 * @property {(path: string, data: string) => Promise<void>} writeFile
 */

/** @typedef {{ agentDir: string; repoDir: string }} ProfileOptions */
/** @typedef {{ agentDir: string; repoDir: string; fileOperations?: FileOperations }} ReconcileOptions */
/** @typedef {{ fileOperations?: FileOperations; zshrcPath: string }} ShellOptions */
/** @typedef {{ settings: Record<string, unknown>; settingsBytes: string | undefined; settingsPath: string }} ProfileState */
/** @typedef {{ bytes: string | undefined; value: unknown }} JsonReadResult */

/** @type {ReadonlyArray<{ name: string; version: string; source: string }>} */
export const MANAGED_NPM_PACKAGES = Object.freeze([
  {
    name: "pi-mcp-adapter",
    version: "2.26.0",
    source: "npm:pi-mcp-adapter@2.26.0",
  },
  {
    name: "pi-subagents",
    version: "0.50.0",
    source: "npm:pi-subagents@0.50.0",
  },
  {
    name: "context-mode",
    version: "1.0.169",
    source: "npm:context-mode@1.0.169",
  },
  {
    name: "pi-markdown-preview",
    version: "0.14.1",
    source: "npm:pi-markdown-preview@0.14.1",
  },
  {
    name: "@juicesharp/rpiv-ask-user-question",
    version: "2.6.1",
    source: "npm:@juicesharp/rpiv-ask-user-question@2.6.1",
  },
]);

/** @type {FileOperations} */
const defaultFileOperations = {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
};

const managedSourcesByName = new Map(
  MANAGED_NPM_PACKAGES.map(({ name, source }) => [name, source]),
);

const shellBlockStartMarker = "# >>> jpriverar pi bootstrap >>>";
const shellBlockEndMarker = "# <<< jpriverar pi bootstrap <<<";
const managedShellBlock = [
  shellBlockStartMarker,
  'export VOLTA_HOME="$HOME/.volta"',
  'export PATH="$VOLTA_HOME/bin:$PATH"',
  'export BEADS_DIR="$HOME/beads/.beads"',
  shellBlockEndMarker,
  "",
].join("\n");

/** @param {unknown} error */
function isMissing(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** @param {string} haystack @param {string} needle */
function countOccurrences(haystack, needle) {
  let count = 0;
  let searchIndex = 0;

  while (true) {
    const matchIndex = haystack.indexOf(needle, searchIndex);
    if (matchIndex === -1) {
      return count;
    }
    count += 1;
    searchIndex = matchIndex + needle.length;
  }
}

/** @param {string[]} entries @param {string} expected */
function countExactMatches(entries, expected) {
  return entries.filter((entry) => entry === expected).length;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} source @returns {string | undefined} */
function npmPackageName(source) {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice(4);
  if (spec.startsWith("@")) {
    const slashAt = spec.indexOf("/");
    const versionAt = slashAt === -1 ? -1 : spec.indexOf("@", slashAt + 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.lastIndexOf("@");
  return versionAt > 0 ? spec.slice(0, versionAt) : spec;
}

/** @param {string} source @param {string} repoDir */
function isCoreSource(source, repoDir) {
  return (
    source === repoDir ||
    source.startsWith("git:github.com/jpriverar/pi-config@") ||
    source.startsWith("https://github.com/jpriverar/pi-config")
  );
}

/** @param {string[]} existingPackages @param {string} repoDir @returns {string[]} */
function reconcilePackages(existingPackages, repoDir) {
  const packages = [];
  const seenManagedPackages = new Set();
  let corePresent = false;

  for (const source of existingPackages) {
    if (isCoreSource(source, repoDir)) {
      if (!corePresent) {
        packages.push(repoDir);
        corePresent = true;
      }
      continue;
    }

    const packageName = npmPackageName(source);
    if (packageName && managedSourcesByName.has(packageName)) {
      const managedSource = managedSourcesByName.get(packageName);
      if (
        !seenManagedPackages.has(packageName) &&
        managedSource !== undefined
      ) {
        packages.push(managedSource);
        seenManagedPackages.add(packageName);
      }
      continue;
    }

    packages.push(source);
  }

  if (!corePresent) {
    packages.push(repoDir);
  }

  for (const { name, source } of MANAGED_NPM_PACKAGES) {
    if (!seenManagedPackages.has(name)) {
      packages.push(source);
    }
  }

  return packages;
}

/** @param {unknown} value @param {string} workMarker @returns {boolean} */
function containsWorkMarker(value, workMarker) {
  if (typeof value === "string") {
    return value.includes(workMarker);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsWorkMarker(entry, workMarker));
  }
  if (isRecord(value)) {
    return Object.values(value).some((entry) =>
      containsWorkMarker(entry, workMarker),
    );
  }
  return false;
}

/**
 * @param {Record<string, unknown>} settings
 * @param {string} settingsPath
 * @param {string} repoDir
 * @param {string} workMarker
 */
function validatePackageSources(settings, settingsPath, repoDir, workMarker) {
  if (!Array.isArray(settings.packages)) {
    return;
  }

  for (const [index, source] of settings.packages.entries()) {
    if (typeof source !== "string") {
      continue;
    }
    if (source === repoDir) {
      continue;
    }
    if (
      source.startsWith("npm:") ||
      source.startsWith("git:github.com/") ||
      source.startsWith("https://github.com/")
    ) {
      if (source.includes(workMarker)) {
        throw new Error(
          `Forbidden work-only package source at package index ${index} in ${settingsPath}`,
        );
      }
      continue;
    }
    throw new Error(
      `Unsupported local package source at package index ${index} in ${settingsPath}: ${source}`,
    );
  }
}

/**
 * @param {string} filePath
 * @param {string} parseErrorMessage
 * @param {FileOperations} fileOperations
 * @returns {Promise<JsonReadResult>}
 */
async function readJsonIfPresent(filePath, parseErrorMessage, fileOperations) {
  let contents;
  try {
    contents = await fileOperations.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return { bytes: undefined, value: undefined };
    }
    throw error;
  }

  try {
    return { bytes: contents, value: JSON.parse(contents) };
  } catch {
    throw new Error(parseErrorMessage);
  }
}

/**
 * @param {ProfileOptions} options
 * @param {FileOperations} fileOperations
 * @returns {Promise<ProfileState>}
 */
async function loadProfileState(options, fileOperations) {
  const { agentDir, repoDir } = options;
  const settingsPath = join(agentDir, "settings.json");
  const mcpPath = join(agentDir, "mcp.json");
  const workMarker = ["data", "dog"].join("");

  let agentStat;
  try {
    agentStat = await fileOperations.lstat(agentDir);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  if (agentStat?.isSymbolicLink()) {
    throw new Error(
      `Cannot use symlinked personal Pi agent directory at ${agentDir}`,
    );
  }

  const settingsResult = await readJsonIfPresent(
    settingsPath,
    `Cannot parse personal Pi settings at ${settingsPath}`,
    fileOperations,
  );
  const settings = isRecord(settingsResult.value) ? settingsResult.value : {};

  validatePackageSources(settings, settingsPath, repoDir, workMarker);

  const mcpResult = await readJsonIfPresent(
    mcpPath,
    `Cannot parse personal Pi MCP configuration at ${mcpPath}`,
    fileOperations,
  );
  if (
    mcpResult.value !== undefined &&
    containsWorkMarker(mcpResult.value, workMarker)
  ) {
    throw new Error(`Forbidden work-only MCP configuration at ${mcpPath}`);
  }

  return {
    settings,
    settingsBytes: settingsResult.bytes,
    settingsPath,
  };
}

/** @param {ProfileOptions} options */
export async function validateProfile(options) {
  await loadProfileState(options, defaultFileOperations);
}

/**
 * @param {string} filePath
 * @param {string} contents
 * @param {FileOperations} [fileOperations]
 */
export async function atomicWrite(
  filePath,
  contents,
  fileOperations = defaultFileOperations,
) {
  const temporaryPath = join(
    dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    await fileOperations.writeFile(temporaryPath, contents);
    await fileOperations.rename(temporaryPath, filePath);
  } finally {
    await fileOperations.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

/**
 * @param {ReconcileOptions} options
 * @returns {Promise<{ changed: boolean; settingsPath: string }>}
 */
/**
 * @param {ShellOptions} options
 * @returns {Promise<{ changed: boolean; backupPath?: string }>}
 */
export async function reconcileShell(options) {
  const { fileOperations = defaultFileOperations, zshrcPath } = options;
  let shellStat;
  try {
    shellStat = await fileOperations.lstat(zshrcPath);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  if (shellStat?.isSymbolicLink()) {
    throw new Error(`Cannot use symlinked shell profile at ${zshrcPath}`);
  }

  let existingBytes;
  try {
    existingBytes = await fileOperations.readFile(zshrcPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  let nextBytes;
  if (existingBytes === undefined) {
    nextBytes = managedShellBlock;
  } else {
    const startCount = countOccurrences(existingBytes, shellBlockStartMarker);
    const endCount = countOccurrences(existingBytes, shellBlockEndMarker);

    if (startCount === 0 && endCount === 0) {
      const separator =
        existingBytes.length === 0 || existingBytes.endsWith("\n") ? "" : "\n";
      nextBytes = `${existingBytes}${separator}${managedShellBlock}`;
    } else if (startCount === 1 && endCount === 1) {
      const blockStart = existingBytes.lastIndexOf(
        "\n",
        existingBytes.indexOf(shellBlockStartMarker),
      );
      const startIndex = blockStart === -1 ? 0 : blockStart + 1;
      const endMarkerIndex = existingBytes.indexOf(shellBlockEndMarker);
      if (endMarkerIndex < startIndex) {
        throw new Error(`Cannot reconcile managed shell block in ${zshrcPath}`);
      }
      let blockEnd = endMarkerIndex + shellBlockEndMarker.length;
      if (existingBytes.startsWith("\r\n", blockEnd)) {
        blockEnd += 2;
      } else if (existingBytes.startsWith("\n", blockEnd)) {
        blockEnd += 1;
      }
      nextBytes = `${existingBytes.slice(0, startIndex)}${managedShellBlock}${existingBytes.slice(blockEnd)}`;
    } else {
      throw new Error(`Cannot reconcile managed shell block in ${zshrcPath}`);
    }
  }

  if (existingBytes === nextBytes) {
    return { changed: false };
  }

  await fileOperations.mkdir(dirname(zshrcPath), { recursive: true });

  let backupPath;
  if (existingBytes !== undefined) {
    backupPath = `${zshrcPath}.jpriverar-pi-bootstrap.bak`;
    try {
      await atomicWrite(backupPath, existingBytes, fileOperations);
    } catch {
      throw new Error(`Cannot back up shell profile at ${backupPath}`);
    }
  }

  try {
    await atomicWrite(zshrcPath, nextBytes, fileOperations);
  } catch {
    throw new Error(`Cannot replace shell profile at ${zshrcPath}`);
  }

  return backupPath ? { changed: true, backupPath } : { changed: true };
}

/** @param {ProfileOptions} options */
export async function verifyInstalledPackages(options) {
  const state = await loadProfileState(options, defaultFileOperations);
  const configuredPackages = Array.isArray(state.settings.packages)
    ? state.settings.packages.filter((entry) => typeof entry === "string")
    : [];

  if (countExactMatches(configuredPackages, options.repoDir) !== 1) {
    throw new Error(
      `Managed core package source is not configured exactly once: ${options.repoDir}`,
    );
  }

  for (const { name, source, version } of MANAGED_NPM_PACKAGES) {
    if (countExactMatches(configuredPackages, source) !== 1) {
      throw new Error(
        `Managed package source is not configured exactly once: ${source}`,
      );
    }

    const packageJsonPath = join(
      options.agentDir,
      "npm",
      "node_modules",
      ...name.split("/"),
      "package.json",
    );

    let installedPackage;
    try {
      installedPackage = JSON.parse(
        await defaultFileOperations.readFile(packageJsonPath, "utf8"),
      );
    } catch (error) {
      if (isMissing(error)) {
        throw new Error(`Managed package is not installed: ${name}`);
      }
      throw new Error(
        `Cannot parse installed managed package metadata at ${packageJsonPath}`,
      );
    }

    const installedVersion =
      isRecord(installedPackage) && typeof installedPackage.version === "string"
        ? installedPackage.version
        : undefined;
    if (installedVersion !== version) {
      throw new Error(
        `Resolved ${name}@${installedVersion}; expected ${version}`,
      );
    }
  }
}

/**
 * @param {ReconcileOptions} options
 * @returns {Promise<{ changed: boolean; settingsPath: string }>}
 */
export async function reconcileSettings(options) {
  const { agentDir, repoDir, fileOperations = defaultFileOperations } = options;
  const state = await loadProfileState({ agentDir, repoDir }, fileOperations);
  const nextSettings = {
    ...state.settings,
    theme: "modus-vivendi-tinted",
    defaultThinkingLevel: "high",
    packages: reconcilePackages(
      Array.isArray(state.settings.packages) ? state.settings.packages : [],
      repoDir,
    ),
    hideThinkingBlock: true,
    quietStartup: true,
  };
  const contents = `${JSON.stringify(nextSettings, null, 2)}\n`;

  if (state.settingsBytes === contents) {
    return {
      changed: false,
      settingsPath: state.settingsPath,
    };
  }

  await fileOperations.mkdir(agentDir, { recursive: true });
  try {
    await atomicWrite(state.settingsPath, contents, fileOperations);
  } catch {
    throw new Error(
      `Cannot replace personal Pi settings at ${state.settingsPath}`,
    );
  }

  return {
    changed: true,
    settingsPath: state.settingsPath,
  };
}

/** @param {string[]} args @param {string} flagName */
function requiredFlag(args, flagName) {
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1 || args[flagIndex + 1] === undefined) {
    throw new Error(`Missing required flag ${flagName} for ${args[0]}`);
  }
  return args[flagIndex + 1];
}

/** @param {string[]} args */
export async function main(args) {
  const [command] = args;

  if (command === "validate") {
    await validateProfile({
      agentDir: requiredFlag(args, "--agent-dir"),
      repoDir: requiredFlag(args, "--repo-dir"),
    });
    console.log(JSON.stringify({ changed: false }));
    return;
  }

  if (command === "settings") {
    const result = await reconcileSettings({
      agentDir: requiredFlag(args, "--agent-dir"),
      repoDir: requiredFlag(args, "--repo-dir"),
    });
    console.log(JSON.stringify({ changed: result.changed }));
    return;
  }

  if (command === "verify") {
    await verifyInstalledPackages({
      agentDir: requiredFlag(args, "--agent-dir"),
      repoDir: requiredFlag(args, "--repo-dir"),
    });
    console.log(JSON.stringify({ changed: false }));
    return;
  }

  if (command === "shell") {
    const result = await reconcileShell({
      zshrcPath: requiredFlag(args, "--zshrc"),
    });
    console.log(JSON.stringify({ changed: result.changed }));
    return;
  }

  throw new Error(command ? `Unknown command: ${command}` : "Unknown command");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Profile reconciliation failed",
    );
    process.exitCode = 1;
  });
}
