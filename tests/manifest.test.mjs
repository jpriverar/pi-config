import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const expectedExtensions = [
  "./extensions/compact-tools/index.ts",
  "./extensions/force-push/index.ts",
  "./extensions/permission-gate/index.ts",
  "./extensions/plan-progress/index.ts",
  "./extensions/styled-editor/index.ts",
  "./extensions/herdr-ask-user-bridge/index.ts",
  "./extensions/worktree-pool/index.ts",
  "./extensions/task-lifecycle/index.ts",
  "./extensions/jp-workflow/index.ts",
  "./extensions/project-status/index.ts",
  "./extensions/tasks-overlay/index.ts",
];

const expectedSkills = [
  "./skills/grill-me",
  "./skills/thinking-partner",
  "./skills/handoff",
  "./skills/thermo-nuclear-code-quality-review",
];

const expectedPrompts = ["./prompts/review.md"];

const expectedThemes = [
  "./themes/modus-vivendi-tinted.json",
  "./themes/gold-rush.json",
];

const packageJsonUrl = new URL("../package.json", import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package manifest exposes the public Pi package contract", async () => {
  const pkg = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  assert.equal(pkg.private, true);
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.engines.node, ">=22.19.0");
  assert.deepEqual(pkg.pi.extensions, expectedExtensions);
  assert.deepEqual(pkg.pi.skills, expectedSkills);
  assert.deepEqual(pkg.pi.prompts, expectedPrompts);
  assert.deepEqual(pkg.pi.themes, expectedThemes);
  assert.deepEqual(pkg.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
  assert.match(
    pkg.scripts.test,
    /find tests extensions lib /,
    "the full test command must include tests colocated under lib",
  );
});

test("personal core owns a task-agnostic worktree pool", () => {
  const extensionRoot = join(root, "extensions/worktree-pool");
  assert.ok(
    existsSync(join(extensionRoot, "pool.ts")),
    "worktree pool core must ship with personal core",
  );

  const source = existsSync(extensionRoot)
    ? readdirSync(extensionRoot)
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => readFileSync(join(extensionRoot, name), "utf8"))
        .join("\n")
    : "";
  for (const forbidden of [
    "piLifecycle",
    "LifecycleIssue",
    "taskId",
    "BEADS_DIR",
    '"bd"',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `pool source contains task concern ${forbidden}`,
    );
  }
});

test("task lifecycle ships the reviewed runtime configuration", () => {
  const config = JSON.parse(
    readFileSync(join(root, "extensions/task-lifecycle/config.json"), "utf8"),
  );
  assert.deepEqual(config, {
    version: 1,
    executionTimeoutMs: 21600000,
    activityWriteIntervalMs: 300000,
    sessionReconcileLimit: 10,
    sessionPrCheckLimit: 5,
    prPollIntervalMs: 900000,
    maxBackoffMs: 21600000,
    warningErrorCount: 3,
  });
});
