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

/** @param {unknown} error */
function isMissing(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
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
  const { packages: _packages, ...otherSettings } = settings;
  if (containsWorkMarker(otherSettings, workMarker)) {
    throw new Error(
      `Forbidden work-only personal Pi settings at ${settingsPath}`,
    );
  }

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
