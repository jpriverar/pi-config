import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after } from "node:test";
import { loadSkills, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamVersion = "6.3.0";
const upstreamTagObject = "86babb696875227929e85420f287d6309374b93f";
const upstreamCommit = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";
const upstreamLicenseSha256 =
  "a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400";
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const portableWorkflowCustomizations = new Set([
  "executing-plans/SKILL.md",
  "finishing-a-development-branch/SKILL.md",
  "subagent-driven-development/SKILL.md",
  "subagent-driven-development/implementer-prompt.md",
  "subagent-driven-development/re-review-prompt.md",
  "subagent-driven-development/task-reviewer-prompt.md",
  "using-git-worktrees/SKILL.md",
]);

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
          "-c",
          "http.lowSpeedLimit=1024",
          "-c",
          "http.lowSpeedTime=30",
          "clone",
          "--depth",
          "1",
          "--branch",
          `v${upstreamVersion}`,
          "https://github.com/obra/superpowers.git",
          checkout,
        ],
        { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
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

function markdownSection(contents: string, heading: string): string {
  const lines = contents.split("\n");
  let fenced = false;
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index++) {
    if (/^```/.test(lines[index])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = lines[index].match(/^(#{2,6}) (.+?)\s*$/);
    if (!match) continue;
    if (start === -1 && match[2] === heading) {
      start = index + 1;
      level = match[1].length;
    } else if (start !== -1 && match[1].length <= level) {
      return lines.slice(start, index).join("\n");
    }
  }
  assert.notEqual(start, -1, `missing markdown section: ${heading}`);
  return lines.slice(start).join("\n");
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

test(
  "vendored Superpowers matches upstream except portable workflow guidance",
  { timeout: 90_000 },
  async () => {
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
      if (!portableWorkflowCustomizations.has(path)) {
        assert.deepEqual(actual, expected, `${path} differs from upstream`);
      }
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
  },
);

test("worktree selection role-gates children before parent pool authority", async () => {
  const usingWorktrees = await readFile(
    join(
      repository,
      "skills",
      "superpowers",
      "using-git-worktrees",
      "SKILL.md",
    ),
    "utf8",
  );
  const detection = markdownSection(
    usingWorktrees,
    "Step 0: Detect Existing Isolation",
  );
  const childGate = markdownSection(
    usingWorktrees,
    "Role Gate: Children Keep the Assigned Workspace",
  );
  const parentAuthority = markdownSection(
    usingWorktrees,
    "Parent Workspace Authority",
  );

  assert.ok(
    detection.indexOf("### Role Gate") <
      detection.indexOf("### Parent Workspace"),
    "the child role gate must precede parent workspace handling",
  );
  assert.match(childGate, /PI_SUBAGENT_DEPTH[^\n]*>\s*0|child role/i);
  assert.match(childGate, /exact[\s\S]*parent-provided workspace/i);
  assert.match(childGate, /retain[\s\S]*assigned cwd/i);
  assert.match(
    childGate,
    /never[\s\S]*worktree_pool[\s\S]*including[^\n]*list[^\n]*acquire/i,
  );
  assert.doesNotMatch(childGate, /worktree_pool (?:list|acquire)\b/i);

  assert.doesNotMatch(parentAuthority, /worktree_pool list/i);
  assert.match(
    parentAuthority,
    /native[\s\S]*worktree_pool[\s\S]*plan's repository identifier[\s\S]*worktree_pool acquire/i,
  );
  assert.match(
    parentAuthority,
    /previously[\s\S]*ledger[\s\S]*exact[\s\S]*path[\s\S]*claim ID[\s\S]*retain/i,
  );
  assert.match(
    parentAuthority,
    /otherwise[\s\S]*requested branch[\s\S]*worktree_pool acquire/i,
  );
  assert.match(
    parentAuthority,
    /same branch[\s\S]*clean retarget[\s\S]*acquire result[\s\S]*author/i,
  );
  assert.match(
    parentAuthority,
    /returned[\s\S]*absolute path[\s\S]*claim ID[\s\S]*reused/i,
  );
  assert.match(
    parentAuthority,
    /arbitrary active[\s\S]*not[\s\S]*ownership|never adopt[\s\S]*arbitrary active/i,
  );
});

test("portable and child-owned workspace alternatives remain intact", async () => {
  const superpowers = join(repository, "skills", "superpowers");
  const workflowPaths = [
    "using-git-worktrees/SKILL.md",
    "subagent-driven-development/SKILL.md",
    "executing-plans/SKILL.md",
    "finishing-a-development-branch/SKILL.md",
  ];
  const workflows = await Promise.all(
    workflowPaths.map((path) => readFile(join(superpowers, path), "utf8")),
  );
  const usingWorktrees = workflows[0];
  const availablePool = markdownSection(
    usingWorktrees,
    "Available pool capability and parent session: use the pool",
  );
  const unavailablePool = markdownSection(
    usingWorktrees,
    "Unavailable pool capability: choose an explicit non-pool workflow",
  );

  assert.match(
    availablePool,
    /native[\s\S]*worktree_pool[\s\S]*plan's repository identifier[\s\S]*requested branch[\s\S]*worktree_pool acquire/i,
  );
  assert.match(availablePool, /assigned child[\s\S]*never acquire or release/i);
  assert.match(unavailablePool, /native[\s\S]*worktree: true/i);
  assert.match(unavailablePool, /already provided/i);
  assert.match(unavailablePool, /user's consent[\s\S]*current checkout/i);
  assert.doesNotMatch(
    unavailablePool,
    /git worktree (?:add|remove|move|repair)/i,
  );
  for (const [index, contents] of workflows.entries()) {
    assert.doesNotMatch(
      contents,
      /\b(?:configured|unconfigured|configuration|enrolled|enrollment)\b/i,
      workflowPaths[index],
    );
  }
});

test("pooled execution ledgers and delegates preserve exact workspace identity", async () => {
  const superpowers = join(repository, "skills", "superpowers");
  const [subagentDevelopment, executingPlans] = await Promise.all([
    readFile(
      join(superpowers, "subagent-driven-development", "SKILL.md"),
      "utf8",
    ),
    readFile(join(superpowers, "executing-plans", "SKILL.md"), "utf8"),
  ]);
  const pooledDelegation = markdownSection(
    subagentDevelopment,
    "Pooled delegation",
  );
  const planWorkspace = markdownSection(executingPlans, "Workspace Contract");

  assert.match(
    pooledDelegation,
    /cwd: pooledPath,\s*worktree: false,\s*async: false,/,
  );
  assert.match(pooledDelegation, /implementer[\s\S]*reviewer[\s\S]*finishing/i);
  assert.match(pooledDelegation, /exact[\s\S]*absolute path[\s\S]*claim ID/i);
  assert.match(pooledDelegation, /ledger[\s\S]*absolute path[\s\S]*claim ID/i);
  assert.match(
    pooledDelegation,
    /compaction[\s\S]*ledger[\s\S]*same workspace/i,
  );
  assert.match(planWorkspace, /ledger[\s\S]*absolute path[\s\S]*claim ID/i);
  assert.match(
    planWorkspace,
    /implementer[\s\S]*reviewer[\s\S]*finishing[\s\S]*same workspace/i,
  );
  for (const contents of [pooledDelegation, planWorkspace]) {
    assert.match(contents, /omitted[^\n]*async[^\n]*worktree: true/i);
    assert.match(contents, /workflowScript[^\n]*worktree: true/i);
  }
});

test("pooled explicit discard releases the slot before deleting only the confirmed feature branch", async () => {
  const finishing = await readFile(
    join(
      repository,
      "skills",
      "superpowers",
      "finishing-a-development-branch",
      "SKILL.md",
    ),
    "utf8",
  );
  const environment = markdownSection(finishing, "Step 2: Detect Environment");
  const discard = markdownSection(
    finishing,
    "If your human partner asks to discard the work",
  );
  const cleanup = markdownSection(
    finishing,
    "Step 6: Cleanup Non-Pool Workspace",
  );
  const merge = markdownSection(finishing, "Option 1: Merge Locally");
  const pullRequest = markdownSection(
    finishing,
    "Option 2: Push and Create PR",
  );
  const keep = markdownSection(finishing, "Option 3: Keep As-Is");

  assert.doesNotMatch(environment, /worktree_pool list/i);
  assert.match(environment, /ledger[\s\S]*exact[\s\S]*path[\s\S]*claim ID/i);
  assert.match(environment, /without[\s\S]*ledger[\s\S]*externally managed/i);
  assert.match(merge, /active pool claim[\s\S]*release[\s\S]*clean/i);
  assert.match(pullRequest, /active pool claim[\s\S]*clean[\s\S]*release/i);
  assert.match(keep, /active pool claim[\s\S]*retain the claim/i);
  assert.match(discard, /exact confirmation[\s\S]*confirm[^\n]*clean/i);
  assert.match(discard, /worktree_pool release[\s\S]*detach/i);
  assert.match(discard, /branch[\s\S]*preserv/i);
  assert.match(discard, /non-slot checkout[\s\S]*branch -D <feature-branch>/i);
  assert.match(discard, /only[\s\S]*confirmed feature branch/i);
  assert.match(discard, /never remove[^\n]*stable (?:pool )?slot/i);
  assert.match(cleanup, /never remove[^\n]*stable pool slot/i);
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
