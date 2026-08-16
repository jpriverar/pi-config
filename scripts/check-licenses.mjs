#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const allowedLicenses = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "CC0-1.0",
]);

function repositoryRoot() {
  return realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  );
}

function parseArguments(argv) {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new Error("usage: check-licenses.mjs [--output <external-path>]");
  }
  return { output: argv[1] };
}

function packageDirectory(root, parentDirectory, name) {
  let current = parentDirectory;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (current === root) break;
    const next = dirname(current);
    if (next === current || !resolve(next).startsWith(resolve(root))) break;
    current = next;
  }
  throw new Error(`could not locate installed production dependency ${name}`);
}

function productionInventory(root) {
  const tree = JSON.parse(
    execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const packages = new Map();

  function visit(dependencies, parentDirectory) {
    for (const [dependencyName, node] of Object.entries(dependencies ?? {})) {
      const directory = packageDirectory(root, parentDirectory, dependencyName);
      const manifestPath = join(directory, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const name = manifest.name ?? dependencyName;
      const version = manifest.version ?? node.version;
      const license =
        typeof manifest.license === "string"
          ? manifest.license
          : manifest.license?.type;
      const key = `${name}@${version}`;
      packages.set(key, { name, version, license: license ?? null });
      visit(node.dependencies, directory);
    }
  }

  visit(tree.dependencies, root);
  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
}

function isInside(root, candidate) {
  const location = relative(root, candidate);
  return (
    location === "" || (!location.startsWith(`..${sep}`) && location !== "..")
  );
}

function assertExternalOutput(root, output) {
  const resolved = resolve(output);
  if (isInside(root, resolved)) {
    throw new Error(
      `refusing to write license report inside repository: ${resolved}`,
    );
  }

  const parent = realpathSync(dirname(resolved));
  if (isInside(root, parent)) {
    throw new Error(
      `refusing to write license report inside repository through parent: ${resolved}`,
    );
  }
  try {
    const existing = lstatSync(resolved);
    if (existing.isSymbolicLink()) {
      throw new Error(
        `license report output must not be a symbolic link: ${resolved}`,
      );
    }
    throw new Error(`license report output already exists: ${resolved}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolved;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = repositoryRoot();
  const inventory = productionInventory(root);
  const rejected = inventory.filter(
    (dependency) =>
      typeof dependency.license !== "string" ||
      !allowedLicenses.has(dependency.license),
  );
  if (rejected.length > 0) {
    throw new Error(
      `production dependencies have missing, unknown, or disallowed licenses:\n${rejected
        .map(
          (dependency) =>
            `${dependency.name}@${dependency.version}: ${dependency.license ?? "missing"}`,
        )
        .join("\n")}`,
    );
  }

  const report = `${JSON.stringify(inventory, null, 2)}\n`;
  if (options.output) {
    const output = assertExternalOutput(root, options.output);
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0);
    const descriptor = openSync(output, flags, 0o600);
    try {
      writeFileSync(descriptor, report, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    console.log(
      `Production dependency licenses verified (${inventory.length}); report: ${output}`,
    );
  } else {
    console.log(
      `Production dependency licenses verified (${inventory.length})`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`license verification failed: ${error.message}`);
  process.exitCode = 1;
}
