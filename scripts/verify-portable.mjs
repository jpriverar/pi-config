#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const authoredExecutable = "scripts/refresh-superpowers.sh";
const reviewedVendorExecutables = new Set([
  "skills/superpowers/brainstorming/scripts/start-server.sh",
  "skills/superpowers/brainstorming/scripts/stop-server.sh",
  "skills/superpowers/subagent-driven-development/scripts/review-package",
  "skills/superpowers/subagent-driven-development/scripts/sdd-workspace",
  "skills/superpowers/subagent-driven-development/scripts/task-brief",
  "skills/superpowers/systematic-debugging/find-polluter.sh",
  "skills/superpowers/writing-skills/render-graphs.js",
]);
const approvedRootFiles = new Set([
  ".gitignore",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
]);
const approvedRootDirectories = new Set([
  ".github",
  "extensions",
  "lib",
  "scripts",
  "skills",
  "tests",
  "themes",
]);
const allowedUrlHosts = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "opensource.org",
  "protesilaos.com",
]);
const reviewedVendorPrefix = "skills/superpowers/";
const placeholderValues = new Set([
  "placeholder",
  "redacted",
  "example",
  "changeme",
  "your_token_here",
  "your_api_key_here",
  "your_secret_here",
  "your_password_here",
]);

function repositoryRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`not a Git repository: ${error.message}`);
  }
}

function trackedEntries(root) {
  const output = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: root,
    encoding: "buffer",
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/.exec(entry);
      if (!match) throw new Error(`could not parse tracked entry: ${entry}`);
      return { mode: match[1], path: match[2] };
    });
}

function report(errors, path, rule) {
  errors.push(`${path}: ${rule}`);
}

function isApprovedPath(path) {
  if (!path.includes("/")) return approvedRootFiles.has(path);
  return approvedRootDirectories.has(path.split("/", 1)[0]);
}

function validateTrackedPath(entry, errors) {
  const { mode, path } = entry;
  if (!isApprovedPath(path)) report(errors, path, "unapproved top-level path");
  if (mode === "120000") report(errors, path, "tracked symlink is forbidden");
  if (mode === "160000") report(errors, path, "Git submodule is forbidden");
  if (mode.endsWith("755")) {
    if (path !== authoredExecutable && !reviewedVendorExecutables.has(path)) {
      report(errors, path, "executable mode is not reviewed");
    }
  } else if (mode !== "100644") {
    report(errors, path, `unsupported tracked mode ${mode}`);
  }

  const pathSegments = path.toLowerCase().split("/");
  const exactRuntimeSegments = new Set([
    "auth",
    "missions",
    "run-history",
    "research",
    "cache",
    "models",
    "mcp",
    ".beads",
    "beads-data",
    "subagent-artifacts",
  ]);
  if (
    pathSegments.some(
      (segment) =>
        exactRuntimeSegments.has(segment) ||
        segment === ".pi" ||
        /^sessions?$/.test(segment),
    )
  ) {
    report(errors, path, "runtime or private-data path is forbidden");
  }
}

function validateBinary(path, content, errors) {
  const first = content.subarray(0, 4);
  const magic = first.toString("hex");
  const isMachO = new Set([
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
  ]).has(magic);
  const isElf = magic === "7f454c46";
  const isPe =
    content.length >= 2 && content[0] === 0x4d && content[1] === 0x5a;
  if (isMachO) report(errors, path, "Mach-O content is forbidden");
  else if (isElf) report(errors, path, "ELF content is forbidden");
  else if (isPe) report(errors, path, "PE content is forbidden");
  else if (content.includes(0))
    report(errors, path, "NUL-containing content is forbidden");
}

function isPlaceholder(value) {
  const normalized = value
    .trim()
    .replace(/^['"]|['"],?$/g, "")
    .toLowerCase();
  return (
    placeholderValues.has(normalized) ||
    normalized.startsWith("your_") ||
    normalized.includes("${") ||
    normalized.includes("<") ||
    normalized === ""
  );
}

function validateCredentials(path, text, errors) {
  const privateKeyHeader = ["-----BEGIN ", "PRIVATE", " KEY-----"].join("");
  if (text.includes(privateKeyHeader)) {
    report(errors, path, "private-key material is forbidden");
  }

  const authorization = new RegExp(
    ["author", "ization"].join("") +
      String.raw`\s*[:=]\s*['"]?(?!YOUR_|<|\$\{)(?:Bearer\s+|Basic\s+)?[A-Za-z0-9+/_.=-]{8,}`,
    "i",
  );
  if (authorization.test(text)) {
    report(errors, path, "non-placeholder authorization payload is forbidden");
  }

  const assignment =
    /(?:^|[\s{"'])((?:api[_-]?key|token|secret|password|credential)[\w-]*)\s*[=:]\s*([^\s,}\]]+)/gim;
  for (const match of text.matchAll(assignment)) {
    if (match[1].toLowerCase() === "tokens") continue;
    if (!isPlaceholder(match[2])) {
      report(
        errors,
        path,
        `non-placeholder credential assignment for ${match[1]}`,
      );
      break;
    }
  }
}

function validatePrivateLocations(path, text, errors) {
  const macHome = ["/", "Users", "/"].join("");
  const linuxHome = ["/", "home", "/"].join("");
  const workTree = ["~", "/", "d", "d", "/"].join("");
  const macPath = new RegExp(
    `${macHome}(?!jp(?:/|[\\s'\"]|$))[A-Za-z0-9._-]+(?:/|$)`,
  );
  const linuxPath = new RegExp(`${linuxHome}[A-Za-z0-9._-]+(?:/|$)`);
  if (macPath.test(text)) report(errors, path, "absolute macOS home path");
  if (linuxPath.test(text)) report(errors, path, "absolute Linux home path");
  if (text.includes(workTree)) report(errors, path, "private work-tree path");
}

function validateUrls(path, text, errors) {
  if (path.startsWith(reviewedVendorPrefix)) return;

  if (path === "package-lock.json") {
    let lock;
    try {
      lock = JSON.parse(text);
    } catch {
      report(errors, path, "package lock is not valid JSON");
      return;
    }
    const resolved = Object.values(lock.packages ?? {})
      .map((entry) => entry?.resolved)
      .filter((value) => typeof value === "string");
    for (const value of resolved) validateUrl(path, value, errors);
    return;
  }

  for (const match of text.matchAll(/https?:\/\/[^\s<>'"`)\]]+/g)) {
    validateUrl(path, match[0].replace(/[.,;:]$/, ""), errors);
  }
}

function validateUrl(path, value, errors) {
  let url;
  try {
    url = new URL(value);
  } catch {
    report(errors, path, `invalid URL ${JSON.stringify(value)}`);
    return;
  }
  if (!allowedUrlHosts.has(url.hostname.toLowerCase())) {
    report(errors, path, `URL host is not reviewed: ${url.hostname}`);
  }
}

function validateManifest(root, entries, errors) {
  if (!entries.some((entry) => entry.path === "package.json")) return;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  } catch {
    report(errors, "package.json", "manifest is not valid JSON");
    return;
  }
  const tracked = new Set(entries.map((entry) => entry.path));
  for (const type of ["extensions", "skills", "themes"]) {
    for (const resource of pkg.pi?.[type] ?? []) {
      if (typeof resource !== "string") {
        report(errors, "package.json", `${type} resource is not a string`);
        continue;
      }
      const normalized = resource.replace(/^\.\//, "");
      if (
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.includes("/../") ||
        resolve(root, normalized) === dirname(root) ||
        !resolve(root, normalized).startsWith(`${root}${sep}`)
      ) {
        report(
          errors,
          "package.json",
          `${type} resource escapes repository: ${resource}`,
        );
        continue;
      }
      const found =
        tracked.has(normalized) ||
        [...tracked].some((candidate) =>
          candidate.startsWith(`${normalized}/`),
        );
      if (!found) {
        report(
          errors,
          "package.json",
          `missing tracked ${type} resource: ${resource}`,
        );
      }
    }
  }
}

function main() {
  const root = repositoryRoot();
  const entries = trackedEntries(root);
  const errors = [];

  for (const entry of entries) {
    validateTrackedPath(entry, errors);
    if (entry.mode === "120000" || entry.mode === "160000") continue;
    const content = readFileSync(resolve(root, entry.path));
    validateBinary(entry.path, content, errors);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    if (!entry.path.startsWith(reviewedVendorPrefix)) {
      validatePrivateLocations(entry.path, text, errors);
      validateCredentials(entry.path, text, errors);
    }
    validateUrls(entry.path, text, errors);
  }
  validateManifest(root, entries, errors);

  if (errors.length > 0) {
    console.error(errors.sort().join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Portable package verified (${entries.length} tracked paths)`);
}

try {
  main();
} catch (error) {
  console.error(`portability verification failed: ${error.message}`);
  process.exitCode = 1;
}
