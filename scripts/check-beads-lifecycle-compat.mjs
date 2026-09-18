#!/usr/bin/env node

import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const prefix = join(tmpdir(), "pi-beads-lifecycle-compat-");
const root = mkdtempSync(prefix);
const store = join(root, ".beads");
const {
  BEADS_DIR: _beadsDir,
  BEADS_DB: _beadsDb,
  ...environment
} = process.env;

function run(args, options = {}) {
  return execFileSync("bd", args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quietStderr ? "ignore" : "inherit"],
  }).trim();
}

function decodeOne(raw) {
  const value = JSON.parse(raw);
  const issue = Array.isArray(value) ? value[0] : value;
  assert.ok(issue && typeof issue === "object", "bd returned no issue");
  return issue;
}

let version;
let nestedSetSupported;
let fullMetadataRoundtrip;
let showLongIncludesMetadata;
let listIncludesMetadata;
let removed = false;

try {
  version = run(["--version"]);
  run(["init", "--init-if-missing", "--non-interactive", "--prefix", "zz"], {
    quietStderr: true,
  });
  const created = decodeOne(
    run(["create", "lifecycle compatibility", "--json", "--db", store]),
  );
  assert.equal(typeof created.id, "string");

  const metadata = {
    unrelated: { keep: true },
    piLifecycle: {
      version: 1,
      phase: "actionable",
      probe: { nested: true },
    },
  };
  run([
    "update",
    created.id,
    "-s",
    "open",
    "--metadata",
    JSON.stringify(metadata),
    "--json",
    "--db",
    store,
  ]);

  const shown = decodeOne(
    run(["show", created.id, "--long", "--json", "--db", store]),
  );
  showLongIncludesMetadata = Object.hasOwn(shown, "metadata");
  fullMetadataRoundtrip = isDeepStrictEqual(shown.metadata, metadata);

  const listedValue = JSON.parse(
    run(["list", "-s", "open", "-n", "0", "--json", "--db", store]),
  );
  const listed = listedValue.find((issue) => issue.id === created.id);
  listIncludesMetadata =
    listed !== undefined && Object.hasOwn(listed, "metadata");

  run([
    "update",
    created.id,
    "--set-metadata",
    "piLifecycle.phase=active",
    "--json",
    "--db",
    store,
  ]);
  const dotted = decodeOne(
    run(["show", created.id, "--long", "--json", "--db", store]),
  );
  nestedSetSupported =
    dotted.metadata?.piLifecycle?.phase === "active" &&
    !Object.hasOwn(dotted.metadata ?? {}, "piLifecycle.phase");

  assert.equal(fullMetadataRoundtrip, true);
  assert.equal(showLongIncludesMetadata, true);
  assert.equal(listIncludesMetadata, true);
  assert.equal(nestedSetSupported, false);
} finally {
  if (!root.startsWith(prefix)) {
    throw new Error(`refusing to remove unexpected compatibility path ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
  removed = !existsSync(root);
}

console.log(`bd_version=${version}`);
console.log(`nested_set_supported=${nestedSetSupported}`);
console.log(`full_metadata_roundtrip=${fullMetadataRoundtrip}`);
console.log(`show_long_includes_metadata=${showLongIncludesMetadata}`);
console.log(`list_includes_metadata=${listIncludesMetadata}`);
console.log(`temporary_store_removed=${removed}`);
