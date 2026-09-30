import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createWorktreeLifecycleFixture as fixture } from "./fixtures/worktree-lifecycle.js";

test("ordinary acquire rejects pending task resources before allocating", async (t) => {
  const h = await fixture(t);
  await h.service.prepareWorktreeRelease(
    h.task.id,
    h.acquired.claimId,
    h.owner,
    "pending-release",
  );
  const writes = h.store.writes;
  const second = await h.acquire("jpriverar/second");
  assert.equal(second.guard?.block, true);
  assert.match(second.guard.reason, /pending worktree association/);
  assert.ok(second.guard.reason.includes(h.acquired.claimId));
  assert.equal(second.acquired, undefined);
  assert.equal(h.store.writes, writes);
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
    1,
  );
});

for (const deinitialized of [false, true]) {
  test(`submodule release preserves ownership before refusal (deinitialized=${deinitialized})`, async (t) => {
    const h = await fixture(t, true);
    await h.mustGit(h.acquired.path, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
    ]);
    if (deinitialized)
      await h.mustGit(h.acquired.path, ["submodule", "deinit", "--all"]);
    assert.equal(
      await h.mustGit(h.acquired.path, ["status", "--porcelain=v1"]),
      "",
    );
    const release = h.event("release", {
      action: "release",
      repository: "repo",
      claimId: h.acquired.claimId,
    });
    assert.equal(await h.hook("tool_call", release), undefined);
    await assert.rejects(
      h.runtime.pool.release("repo", h.acquired.claimId, h.owner),
      /submodule.*unsupported/i,
    );
    await h.hook("tool_result", { ...release, isError: true });
    const listing = (await h.runtime.pool.list("repo")).repositories[0]
      .worktrees[0];
    assert.equal(listing.state, "active");
    assert.equal(listing.evidence.nativeClaimMatches, true);
    assert.equal(listing.clean, true);
    assert.equal(
      (await h.store.show(h.task.id)).lifecycle!.resources[0].cleanupState,
      "release_pending",
    );
    const next = await h.acquire("jpriverar/second");
    assert.equal(next.guard?.block, true);
    assert.equal(
      (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
      1,
    );
    await assert.rejects(
      h.service.prepareReconciliation(
        { taskId: h.task.id, requestId: "normal" },
        h.owner,
      ),
      /worktree release remains pending/,
    );
  });
}

test("preflight store failure blocks allocation without exposing private error text", async (t) => {
  const h = await fixture(t);
  h.store.failTask = h.task.id;
  const result = await h.acquire("jpriverar/second");
  assert.equal(result.guard?.block, true);
  assert.match(result.guard.reason, /unable to verify/);
  assert.doesNotMatch(result.guard.reason, /private fixture/);
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
    1,
  );
});

test("post-allocation revalidation still catches a pending-state race and explains the claim", async (t) => {
  const h = await fixture(t);
  const input = {
    action: "acquire",
    repository: "repo",
    branch: "jpriverar/race",
    startPoint: "main",
  };
  const call = h.event("race", input);
  assert.equal(await h.hook("tool_call", call), undefined);
  await h.service.prepareWorktreeRelease(
    h.task.id,
    h.acquired.claimId,
    h.owner,
    "concurrent-release",
  );
  const allocated = await h.runtime.pool.acquire(input, h.owner);
  const result = await h.hook("tool_result", {
    ...call,
    details: allocated,
    isError: false,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /pending worktree association/);
  assert.ok(result.content[0].text.includes(h.acquired.claimId));
  assert.ok(result.content[0].text.includes(allocated.claimId));
  assert.match(result.content[0].text, /allocated worktree was not removed/);
  assert.equal((await h.store.show(h.task.id)).lifecycle!.resources.length, 1);
});

test("uninitialized submodules do not block ordinary safe release", async (t) => {
  const h = await fixture(t, true);
  const release = h.event("release-uninitialized", {
    action: "release",
    repository: "repo",
    claimId: h.acquired.claimId,
  });
  assert.equal(await h.hook("tool_call", release), undefined);
  const result = await h.runtime.pool.release(
    "repo",
    h.acquired.claimId,
    h.owner,
  );
  assert.equal(result.released, true);
  assert.equal(
    await h.hook("tool_result", {
      ...release,
      details: result,
      isError: false,
    }),
    undefined,
  );
  assert.equal(
    (await h.store.show(h.task.id)).lifecycle!.resources[0].cleanupState,
    "released",
  );
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees.length,
    0,
  );
});

test("dirty submodule contents survive refused cleanup with ownership intact", async (t) => {
  const h = await fixture(t, true);
  await h.mustGit(h.acquired.path, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
  ]);
  const localFile = join(h.acquired.path, "nested", "local.txt");
  await fs.writeFile(localFile, "uncommitted work\n");
  assert.equal(
    (await h.runtime.pool.release("repo", h.acquired.claimId, h.owner))
      .released,
    false,
  );
  assert.equal(await fs.readFile(localFile, "utf8"), "uncommitted work\n");
  assert.equal(
    (await h.runtime.pool.list("repo")).repositories[0].worktrees[0].evidence
      .nativeClaimMatches,
    true,
  );
});
