import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createWorktreePoolExtension } from "../extensions/worktree-pool/index.js";
import { createWorktreeLifecycleFixture as fixture } from "./fixtures/worktree-lifecycle.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function release(h: Fixture, force = false) {
  let tool: any;
  createWorktreePoolExtension({
    now: () => h.owner.started,
    pid: h.owner.pid,
    hostname: h.owner.host,
    loadRuntime: async () => h.runtime,
  })({
    on() {},
    registerTool(value) {
      if (value.name === "worktree_release") tool = value;
    },
  });
  const call = h.event(`release-${force}`, {
    action: "release",
    repository: "repo",
    claimId: h.acquired.claimId,
    force,
  });
  const guard = await h.hook("tool_call", call);
  assert.equal(guard, undefined);
  const result = await tool.execute(
    call.toolCallId,
    call.input,
    undefined,
    undefined,
    h.context,
  );
  await h.hook("tool_result", { ...call, ...result, isError: false });
  return result;
}

async function initSubmodule(h: Fixture) {
  await h.mustGit(h.acquired.path, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  const path = join(h.acquired.path, "nested");
  await h.mustGit(path, ["config", "user.name", "Fixture"]);
  await h.mustGit(path, ["config", "user.email", "fixture@example.invalid"]);
  return path;
}

async function assertReleased(h: Fixture) {
  await assert.rejects(fs.access(h.acquired.path), { code: "ENOENT" });
  assert.equal((await h.runtime.pool.list("repo")).repositories[0].used, 0);
  assert.equal(
    (await h.store.show(h.task.id)).lifecycle!.resources[0].cleanupState,
    "released",
  );
}

for (const location of ["root", "submodule"] as const) {
  test(`warns about ${location} changes despite ignore settings, then accepts explicit force`, async (t) => {
    const h = await fixture(t, location === "submodule");
    const path =
      location === "submodule" ? await initSubmodule(h) : h.acquired.path;
    const file = join(path, "local.txt");
    await fs.writeFile(file, "deliberately disposable\n");
    await fs.writeFile(join(path, "README.md"), "staged disposable work\n");
    await h.mustGit(path, ["add", "README.md"]);
    await h.mustGit(h.acquired.path, [
      "config",
      "status.showUntrackedFiles",
      "no",
    ]);
    if (location === "submodule")
      await h.mustGit(h.acquired.path, [
        "config",
        "submodule.nested.ignore",
        "all",
      ]);
    const normal = await release(h);
    assert.equal(normal.details.released, false);
    assert.match(normal.content[0].text, /local\.txt/);
    assert.match(normal.content[0].text, /force/);
    assert.equal(await fs.readFile(file, "utf8"), "deliberately disposable\n");
    assert.equal(
      (await h.runtime.pool.list("repo")).repositories[0].worktrees[0].evidence
        .nativeClaimMatches,
      true,
    );
    const before = await h.store.show(h.task.id);
    await h.service.prepareReconciliation(
      { taskId: h.task.id, requestId: "observe-only" },
      h.owner,
    );
    assert.deepEqual(await h.store.show(h.task.id), before);
    await fs.access(file);
    const forced = await release(h, true);
    assert.equal(forced.details.released, true);
    await assertReleased(h);
  });
}

for (const deinitialized of [false, true]) {
  for (const work of ["commit", "stash"] as const) {
    test(`preserves submodule ${work} until explicit discard (deinitialized=${deinitialized})`, async (t) => {
      const h = await fixture(t, true);
      const path = await initSubmodule(h);
      const original = await h.mustGit(path, ["rev-parse", "HEAD"]);
      const gitDir = await h.mustGit(path, ["rev-parse", "--absolute-git-dir"]);
      await fs.writeFile(join(path, "README.md"), "local work\n");
      if (work === "stash") {
        await h.mustGit(path, ["stash", "push", "-m", "local stash"]);
      } else {
        await h.mustGit(path, ["switch", "-c", "local-work"]);
        await h.mustGit(path, ["commit", "-am", "local commit"]);
        await h.mustGit(path, ["checkout", "--detach", original]);
      }
      if (deinitialized)
        await h.mustGit(h.acquired.path, ["submodule", "deinit", "--all"]);
      assert.equal(
        await h.mustGit(h.acquired.path, ["status", "--porcelain"]),
        "",
      );
      const normal = await release(h);
      assert.equal(normal.details.released, false);
      assert.match(normal.content[0].text, /nested/);
      assert.match(normal.content[0].text, /commit|stash/);
      assert.match(normal.content[0].text, /force/);
      await fs.access(gitDir);
      assert.equal((await release(h, true)).details.released, true);
      await assertReleased(h);
      await assert.rejects(fs.access(gitDir), { code: "ENOENT" });
    });
  }
}

for (const dirty of [false, true]) {
  test(`recursive submodule release respects local work (dirty=${dirty})`, async (t) => {
    const h = await fixture(t, true);
    const path = await initSubmodule(h);
    await h.mustGit(path, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      join(h.root, "child"),
      "deeper",
    ]);
    await h.mustGit(path, ["commit", "-m", "nested submodule"]);
    await h.mustGit(path, ["push", "origin", "HEAD:refs/heads/nested-fixture"]);
    await h.mustGit(h.acquired.path, ["add", "nested"]);
    await h.mustGit(h.acquired.path, ["commit", "-m", "nested fixture"]);
    if (dirty) {
      const deeper = join(path, "deeper");
      await fs.writeFile(
        join(deeper, "deep-work.txt"),
        "keep until explicit force\n",
      );
      await h.mustGit(path, ["config", "submodule.deeper.ignore", "all"]);
      const normal = await release(h);
      assert.equal(normal.details.released, false);
      assert.match(normal.content[0].text, /deep-work\.txt/);
      assert.equal(
        await fs.readFile(join(deeper, "deep-work.txt"), "utf8"),
        "keep until explicit force\n",
      );
    }
    assert.equal((await release(h, dirty)).details.released, true);
    await assertReleased(h);
  });
}

test("force cannot delete submodule Git data used by another worktree", async (t) => {
  const h = await fixture(t, true);
  const path = await initSubmodule(h);
  const other = join(h.root, "other-checkout");
  await h.mustGit(path, ["worktree", "add", "--detach", other, "HEAD"]);
  for (const force of [false, true]) {
    await assert.rejects(release(h, force), /submodule.*another worktree/i);
    await fs.access(join(other, "README.md"));
    assert.equal(
      (await h.runtime.pool.list("repo")).repositories[0].worktrees[0].evidence
        .nativeClaimMatches,
      true,
    );
  }
});

test("force cannot follow a submodule Git directory outside the managed worktree", async (t) => {
  const h = await fixture(t, true);
  const path = await initSubmodule(h);
  const external = join(h.root, "external-git-dir");
  const gitDir = await h.mustGit(path, ["rev-parse", "--absolute-git-dir"]);
  await fs.cp(gitDir, external, { recursive: true });
  await h.mustGit(path, [
    `--git-dir=${external}`,
    `--work-tree=${path}`,
    "config",
    "core.worktree",
    path,
  ]);
  await fs.writeFile(join(path, ".git"), `gitdir: ${external}\n`);
  await assert.rejects(release(h, true), /outside this worktree's ownership/);
  await fs.access(join(external, "HEAD"));
  await fs.access(h.acquired.path);
});

for (const mismatch of ["branch", "lock"] as const) {
  test(`force does not bypass ${mismatch} identity checks`, async (t) => {
    const h = await fixture(t);
    await fs.writeFile(join(h.acquired.path, "local.txt"), "keep\n");
    if (mismatch === "branch") {
      await h.mustGit(h.acquired.path, ["switch", "-c", "unexpected"]);
    } else {
      await h.mustGit(h.repo, ["worktree", "unlock", h.acquired.path]);
      await h.mustGit(h.repo, [
        "worktree",
        "lock",
        "--reason",
        "someone-else",
        h.acquired.path,
      ]);
    }
    const result = await h.runtime.pool.release(
      "repo",
      h.acquired.claimId,
      h.owner,
      undefined,
      { force: true },
    );
    assert.equal(result.released, false);
    assert.equal(
      await fs.readFile(join(h.acquired.path, "local.txt"), "utf8"),
      "keep\n",
    );
  });
}

test("force does not bypass lifecycle task ownership", async (t) => {
  const h = await fixture(t);
  const foreign = { ...h.owner, sessionId: "someone-else" };
  const handlers = h.context.sessionManager;
  const original = handlers.getSessionId;
  handlers.getSessionId = () => foreign.sessionId;
  const guard = await h.hook(
    "tool_call",
    h.event("foreign-force", {
      action: "release",
      repository: "repo",
      claimId: h.acquired.claimId,
      force: true,
    }),
  );
  handlers.getSessionId = original;
  assert.equal(guard?.block, true);
  await fs.access(h.acquired.path);
});

async function addOrphanGitlink(h: Fixture, path: string) {
  const head = await h.mustGit(h.acquired.path, ["rev-parse", "HEAD"]);
  await h.mustGit(h.acquired.path, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},${path}`,
  ]);
  await h.mustGit(h.acquired.path, ["commit", "-m", "orphan gitlink"]);
  await fs.mkdir(join(h.acquired.path, path), { recursive: true });
}

for (const metadata of [
  "missing-file",
  "missing-entry",
  "missing-url",
] as const) {
  test(`releases an uninitialized gitlink with ${metadata} metadata`, async (t) => {
    const h = await fixture(t, metadata === "missing-entry");
    const path = "orphan skill\nsecond line";
    await addOrphanGitlink(h, path);
    if (metadata === "missing-url") {
      await h.mustGit(h.acquired.path, [
        "config",
        "--file",
        ".gitmodules",
        "submodule.orphan.path",
        path,
      ]);
      await h.mustGit(h.acquired.path, ["add", ".gitmodules"]);
      await h.mustGit(h.acquired.path, ["commit", "-m", "missing URL"]);
    }
    assert.equal(
      await h.mustGit(h.acquired.path, ["status", "--porcelain"]),
      "",
    );
    assert.equal((await release(h)).details.released, true);
    await assertReleased(h);
  });
}

for (const work of ["clean", "dirty", "commit"] as const) {
  test(`inspects ${work} initialized submodules even without .gitmodules`, async (t) => {
    const h = await fixture(t, true);
    const path = await initSubmodule(h);
    await h.mustGit(h.acquired.path, ["rm", ".gitmodules"]);
    await h.mustGit(h.acquired.path, [
      "commit",
      "-m",
      "missing submodule metadata",
    ]);
    if (work !== "clean") {
      await fs.writeFile(join(path, "local.txt"), "keep until force\n");
      if (work === "commit") {
        const original = await h.mustGit(path, ["rev-parse", "HEAD"]);
        await h.mustGit(path, ["switch", "-c", "local-only"]);
        await h.mustGit(path, ["add", "local.txt"]);
        await h.mustGit(path, ["commit", "-m", "local only"]);
        await h.mustGit(path, ["checkout", "--detach", original]);
      }
      const normal = await release(h);
      assert.equal(normal.details.released, false);
      assert.match(
        normal.content[0].text,
        work === "dirty" ? /local.txt/ : /commits or stashes/,
      );
      await fs.access(path);
    }
    assert.equal((await release(h, work !== "clean")).details.released, true);
    await assertReleased(h);
  });
}

for (const force of [false, true]) {
  test(`refuses ambiguous uninitialized submodule contents (force=${force})`, async (t) => {
    const h = await fixture(t);
    await addOrphanGitlink(h, "orphan");
    const local = join(h.acquired.path, "orphan", "local.txt");
    await fs.writeFile(local, "preserve\n");
    await assert.rejects(release(h, force), (error: Error) => {
      assert.match(error.message, /orphan/);
      assert.match(error.message, /contains files but no .git/);
      assert.match(error.message, /force cannot bypass inspection failures/);
      assert.match(error.message, /No worktree was removed/);
      return true;
    });
    assert.equal(await fs.readFile(local, "utf8"), "preserve\n");
    assert.equal(
      (await h.runtime.pool.list("repo")).repositories[0].worktrees[0].evidence
        .nativeClaimMatches,
      true,
    );
  });
}

test("malformed metadata does not hide externally owned initialized Git data", async (t) => {
  const h = await fixture(t, true);
  const path = await initSubmodule(h);
  await h.mustGit(h.acquired.path, ["rm", ".gitmodules"]);
  await h.mustGit(h.acquired.path, [
    "commit",
    "-m",
    "missing submodule metadata",
  ]);
  const external = join(h.root, "external-git-dir");
  const gitDir = await h.mustGit(path, ["rev-parse", "--absolute-git-dir"]);
  await fs.cp(gitDir, external, { recursive: true });
  await h.mustGit(path, [
    `--git-dir=${external}`,
    `--work-tree=${path}`,
    "config",
    "core.worktree",
    path,
  ]);
  await fs.writeFile(join(path, ".git"), `gitdir: ${external}\n`);
  for (const force of [false, true]) {
    await assert.rejects(
      release(h, force),
      /outside this worktree's ownership/,
    );
    await fs.access(join(external, "HEAD"));
    await fs.access(h.acquired.path);
  }
});
