import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after } from "node:test";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamVersion = "6.3.0";
const upstreamTagObject = "86babb696875227929e85420f287d6309374b93f";
const upstreamCommit = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";
const upstreamLicenseSha256 =
  "a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400";
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let checkoutRoot: string | undefined;
let checkoutPromise: Promise<string> | undefined;

async function checkoutUpstream(): Promise<string> {
  if (!checkoutPromise) {
    checkoutPromise = (async () => {
      checkoutRoot = await mkdtemp(join(tmpdir(), "pi-superpowers-test-"));
      const checkout = join(checkoutRoot, "superpowers");
      await execFileAsync(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          `v${upstreamVersion}`,
          "https://github.com/obra/superpowers.git",
          checkout,
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      );

      const [{ stdout: tag }, { stdout: commit }] = await Promise.all([
        execFileAsync("git", [
          "-C",
          checkout,
          "rev-parse",
          `v${upstreamVersion}`,
        ]),
        execFileAsync("git", [
          "-C",
          checkout,
          "rev-parse",
          `v${upstreamVersion}^{}`,
        ]),
      ]);
      assert.equal(tag.trim(), upstreamTagObject);
      assert.equal(commit.trim(), upstreamCommit);
      return checkout;
    })();
  }
  return checkoutPromise;
}

after(async () => {
  if (checkoutRoot) await rm(checkoutRoot, { recursive: true, force: true });
});

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

function frontmatter(
  markdown: string,
  path: string,
): { name: string; description: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  assert.ok(match, `${path} must begin with YAML frontmatter`);
  const scalar = (field: string): string | undefined => {
    const value = match[1]
      .match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"))?.[1]
      ?.trim();
    if (!value) return undefined;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1).trim();
    }
    return value;
  };
  const name = scalar("name");
  const description = scalar("description");
  assert.ok(name, `${path} must have name frontmatter`);
  assert.ok(description, `${path} must have description frontmatter`);
  return { name, description };
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

test("every manifest skill path contains discoverable skills", async () => {
  for (const root of await manifestSkillRoots()) {
    const rootInfo = await stat(root);
    assert.ok(
      rootInfo.isDirectory(),
      `${relative(repository, root)} must be a directory`,
    );
    const manifests = (await filesBelow(root)).filter(
      (path) => path === "SKILL.md" || path.endsWith(`${sep}SKILL.md`),
    );
    assert.ok(
      manifests.length > 0,
      `${relative(repository, root)} must contain a SKILL.md`,
    );
  }
});

test("every skill has valid required frontmatter", async () => {
  for (const root of await manifestSkillRoots()) {
    for (const path of (await filesBelow(root)).filter((candidate) =>
      candidate.endsWith("SKILL.md"),
    )) {
      const absolutePath = join(root, path);
      const metadata = frontmatter(
        await readFile(absolutePath, "utf8"),
        relative(repository, absolutePath),
      );
      assert.match(
        metadata.name,
        skillNamePattern,
        `${path} has an invalid skill name`,
      );
      assert.ok(
        metadata.name.length <= 64,
        `${path} skill name exceeds 64 characters`,
      );
      assert.ok(
        metadata.description.length <= 1024,
        `${path} description exceeds 1024 characters`,
      );
    }
  }
});

test("vendored Superpowers is byte-for-byte upstream v6.3.0", async () => {
  const checkout = await checkoutUpstream();
  const expectedRoot = join(checkout, "skills");
  const actualRoot = join(repository, "skills", "superpowers");
  const expectedFiles = await filesBelow(expectedRoot);
  const actualFiles = (await filesBelow(actualRoot)).filter(
    (path) => path !== "LICENSE",
  );
  assert.deepEqual(actualFiles, expectedFiles);

  for (const path of expectedFiles) {
    const [expected, actual, expectedInfo, actualInfo] = await Promise.all([
      readFile(join(expectedRoot, path)),
      readFile(join(actualRoot, path)),
      stat(join(expectedRoot, path)),
      stat(join(actualRoot, path)),
    ]);
    assert.deepEqual(actual, expected, `${path} differs from upstream`);
    assert.equal(
      actualInfo.mode & 0o111,
      expectedInfo.mode & 0o111,
      `${path} executable mode differs from upstream`,
    );
  }

  const [upstreamLicense, vendoredLicense] = await Promise.all([
    readFile(join(checkout, "LICENSE")),
    readFile(join(actualRoot, "LICENSE")),
  ]);
  assert.match(upstreamLicense.toString("utf8"), /MIT License/);
  assert.equal(
    createHash("sha256").update(upstreamLicense).digest("hex"),
    upstreamLicenseSha256,
  );
  assert.deepEqual(
    vendoredLicense,
    upstreamLicense,
    "vendored LICENSE differs from upstream",
  );
});

test("skills contain no machine-specific paths or internal resources", async () => {
  const forbidden = [
    /\/Users\/[^\s)`]+/i,
    /\/home\/[^\s)`]+/i,
    /~\/dd(?:\/|\b)/i,
    /\/go\/src(?:\/|\b)/i,
    /\b(?:datadog|ddbuild|slack|atlassian|jira|confluence)\b/i,
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
