import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSkills, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
      else assert.fail(`unexpected non-file entry: ${path}`);
    }
  }
  await visit(root);
  return files.sort();
}

async function manifestSkillRoots(): Promise<string[]> {
  const pkg = JSON.parse(
    await readFile(join(repository, "package.json"), "utf8"),
  ) as {
    pi?: { skills?: unknown };
  };
  assert.ok(
    Array.isArray(pkg.pi?.skills),
    "package.json pi.skills must be an array",
  );
  return pkg.pi.skills.map((entry: unknown) => {
    assert.equal(
      typeof entry,
      "string",
      "every pi.skills entry must be a string",
    );
    return resolve(repository, entry as string);
  });
}

test("Pi 0.84.1 discovers every manifest skill path without diagnostics", async () => {
  for (const root of await manifestSkillRoots()) {
    const rootInfo = await stat(root);
    assert.ok(
      rootInfo.isDirectory(),
      `${relative(repository, root)} must be a directory`,
    );
    const manifests = (await filesBelow(root))
      .filter((path) => path === "SKILL.md" || path.endsWith(`${sep}SKILL.md`))
      .map((path) => resolve(root, path))
      .sort();
    const loaded = loadSkillsFromDir({ dir: root, source: "path" });
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(
      loaded.skills.map((skill) => resolve(skill.filePath)).sort(),
      manifests,
    );
  }
});

test("Pi 0.84.1 loads exact valid skill metadata from the package manifest", async () => {
  const roots = await manifestSkillRoots();
  const loaded = loadSkills({
    cwd: repository,
    agentDir: join(repository, ".test-agent-unused"),
    skillPaths: roots,
    includeDefaults: false,
  });
  assert.deepEqual(loaded.diagnostics, []);
  const expectedCount = (
    await Promise.all(
      roots.map(
        async (root) =>
          (await filesBelow(root)).filter((path) => path.endsWith("SKILL.md"))
            .length,
      ),
    )
  ).reduce((total, count) => total + count, 0);
  assert.equal(loaded.skills.length, expectedCount);
  for (const skill of loaded.skills) {
    assert.equal(skill.name, basename(skill.baseDir));
    assert.match(skill.name, skillNamePattern);
    assert.ok(skill.name.length <= 64);
    assert.equal(skill.description, skill.description.trim());
    assert.ok(skill.description.length > 0);
    assert.ok(skill.description.length <= 1024);
  }
});

test("skills contain no machine-specific paths or internal resources", async () => {
  const internalNames = [
    ["data", "dog"].join(""),
    ["dd", "build"].join(""),
    ["sl", "ack"].join(""),
    ["atlas", "sian"].join(""),
    ["ji", "ra"].join(""),
    ["con", "fluence"].join(""),
  ].join("|");
  const forbidden = [
    /\/Users\/[^\s)`]+/i,
    /\/home\/[^\s)`]+/i,
    /~\/dd(?:\/|\b)/i,
    /\/go\/src(?:\/|\b)/i,
    new RegExp(`\\b(?:${internalNames})\\b`, "i"),
  ];
  for (const root of await manifestSkillRoots()) {
    for (const path of (await filesBelow(root)).filter((candidate) =>
      candidate.endsWith("SKILL.md"),
    )) {
      const absolutePath = join(root, path);
      const contents = await readFile(absolutePath, "utf8");
      for (const pattern of forbidden) {
        assert.doesNotMatch(
          contents,
          pattern,
          `${relative(repository, absolutePath)} contains ${pattern}`,
        );
      }
    }
  }
});

test("handoff uses the configured Beads store with a portable fallback", async () => {
  const handoff = await readFile(
    join(repository, "skills", "handoff", "SKILL.md"),
    "utf8",
  );
  assert.match(handoff, /BEADS_DIR/);
  assert.match(handoff, /\$HOME\/beads\/\.beads/);
  assert.doesNotMatch(handoff, /\/Users\/|~\/dd(?:\/|\b)/);
});
