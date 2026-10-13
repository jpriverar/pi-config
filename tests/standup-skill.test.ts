import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("installed manifest exposes standup with usable bundled CLI", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const loaded = loadSkills({
    cwd: root,
    agentDir: join(root, ".test-agent-unused"),
    skillPaths: pkg.pi.skills.map((path: string) => resolve(root, path)),
    includeDefaults: false,
  });
  assert.deepEqual(loaded.diagnostics, []);
  const standup = loaded.skills.find((skill) => skill.name === "standup");
  assert.ok(standup, "standup must be discoverable from the installed package");
  const output = execFileSync(
    "node",
    [join(standup.baseDir, "standup.mjs"), "--help"],
    { cwd: dirname(root), encoding: "utf8" },
  );
  assert.match(output, /prepare/);
  assert.match(output, /sessions/);
  assert.match(output, /save/);
});
