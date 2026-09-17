import { describe, expect, test } from "../../tests/expect.js";

import { evaluatePoolCommand } from "./command-policy.js";

describe("evaluatePoolCommand", () => {
  for (const verb of [
    "add",
    "remove",
    "move",
    "lock",
    "unlock",
    "repair",
    "prune",
  ]) {
    test(`blocks model-authored git worktree ${verb} globally`, () => {
      const decision = evaluatePoolCommand(
        `git worktree ${verb} outside-the-pool`,
        0,
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toContain("worktree_pool");
    });
  }

  test("allows read-only worktree commands, checkout, switch, and unrelated Git", () => {
    for (const command of [
      "git worktree list --porcelain",
      "git checkout feature",
      "git switch feature",
      "git status --short",
      "git diff",
      "git branch --show-current",
    ]) {
      expect(evaluatePoolCommand(command, 0)).toEqual({ allowed: true });
    }
  });

  test("blocks straightforward wrappers, assignments, compounds, and Git global options", () => {
    for (const command of [
      "command git worktree add target HEAD",
      "FOO=bar git worktree remove target",
      "git status && git worktree prune",
      "git -c core.fsmonitor=false worktree move old new",
      "git -C /tmp worktree lock target",
      "/usr/bin/git worktree unlock target",
    ]) {
      expect(evaluatePoolCommand(command, 0).allowed).toBe(false);
    }
  });

  test("does not interpret opaque or dynamic command embedding", () => {
    for (const command of [
      "sh -c 'git worktree remove target'",
      "bash -lc 'git worktree add target HEAD'",
      "cat <<'EOF'\ngit worktree remove target\nEOF",
    ]) {
      expect(evaluatePoolCommand(command, 0)).toEqual({ allowed: true });
    }
  });

  test("treats heredoc-bearing shell as opaque", () => {
    for (const command of [
      "cat <<'EOF'\ngit worktree remove target\nEOF",
      "git worktree add /tmp/rogue HEAD; cat <<'EOF'\nx\nEOF",
      "echo ok # <<EOF\ngit worktree prune",
    ]) {
      expect(evaluatePoolCommand(command, 0)).toEqual({ allowed: true });
    }
  });

  test("uses depth-aware cooperative guidance", () => {
    const parent = evaluatePoolCommand("git worktree add target HEAD", 0);
    expect(parent.allowed).toBe(false);
    if (!parent.allowed) expect(parent.reason).toContain("Use worktree_pool");

    const child = evaluatePoolCommand("git worktree add target HEAD", 1);
    expect(child.allowed).toBe(false);
    if (!child.allowed) expect(child.reason).toContain("Ask the parent");
  });
});
