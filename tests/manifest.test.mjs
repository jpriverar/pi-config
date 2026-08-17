import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedExtensions = [
  "./extensions/compact-tools/index.ts",
  "./extensions/permission-gate/index.ts",
  "./extensions/plan-progress/index.ts",
  "./extensions/styled-editor/index.ts",
  "./extensions/jp-workflow/index.ts",
  "./extensions/project-status/index.ts",
  "./extensions/tasks-overlay/index.ts",
];

const expectedSkills = [
  "./skills/superpowers",
  "./skills/grill-me",
  "./skills/thinking-partner",
  "./skills/handoff",
];

const expectedThemes = [
  "./themes/modus-vivendi-tinted.json",
  "./themes/gold-rush.json",
];

const packageJsonUrl = new URL("../package.json", import.meta.url);

test("package manifest exposes the public Pi package contract", async () => {
  const pkg = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  assert.equal(pkg.private, true);
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.engines.node, ">=22.19.0");
  assert.deepEqual(pkg.pi.extensions, expectedExtensions);
  assert.deepEqual(pkg.pi.skills, expectedSkills);
  assert.deepEqual(pkg.pi.themes, expectedThemes);
  assert.deepEqual(pkg.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
});
