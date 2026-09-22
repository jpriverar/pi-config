import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeterministicGitArtifactClassifier } from "./git-artifact-command.js";

const classifier = createDeterministicGitArtifactClassifier();

test("classifies supported direct Git and GitHub artifact commands", () => {
  assert.deepEqual(classifier.classify("git commit -m 'ship it'", "/repo"), [
    { kind: "git-head", operation: "commit", cwd: "/repo", ref: "HEAD" },
  ]);
  assert.deepEqual(
    classifier.classify(
      "git -C ../other commit --amend --no-edit",
      "/repo/sub",
    ),
    [
      {
        kind: "git-head",
        operation: "commit",
        cwd: "/repo/other",
        ref: "HEAD",
      },
    ],
  );
  assert.deepEqual(
    classifier.classify(
      "UNRELATED=example gh pr create --repo DataDog/dd-go --head topic",
      "/repo",
    ),
    [
      {
        kind: "github-pr",
        operation: "pr-create",
        cwd: "/repo",
        repository: "DataDog/dd-go",
        head: "topic",
      },
    ],
  );

  for (const command of [
    "/usr/bin/git commit --no-edit",
    "command git commit -m ship",
    "env -u UNUSED git commit -m ship",
  ]) {
    assert.deepEqual(classifier.classify(command, "/repo"), [
      { kind: "git-head", operation: "commit", cwd: "/repo", ref: "HEAD" },
    ]);
  }

  for (const [command, ref] of [
    ["git push", "HEAD"],
    ["git push origin", "HEAD"],
    ["git push -u origin topic", "topic"],
  ] as const) {
    assert.deepEqual(classifier.classify(command, "/repo"), [
      { kind: "git-head", operation: "push", cwd: "/repo", ref },
    ]);
  }
});

test("ignores ambiguous, dynamic, dry-run, and unrelated commands", () => {
  for (const command of [
    "git status --short",
    "git --git-dir=/tmp/other.git commit -m ship",
    "git --work-tree /tmp/other commit -m ship",
    "git -c core.worktree=/tmp/other commit -m ship",
    "git commit --dry-run",
    "git push --dry-run origin topic",
    "git push origin one two",
    "git push origin HEAD:refs/heads/topic",
    "git commit || true",
    "git add . && git commit -m ship",
    "git commit | tee output",
    "bash -lc 'git commit -m ship'",
    "cat <<'EOF'\ngit commit -m ship\nEOF",
    "git $(printf commit) -m ship",
    "gh pr create --dry-run",
    "gh pr create --web",
    "gh pr view 123",
  ]) {
    assert.deepEqual(classifier.classify(command, "/repo"), [], command);
  }
});

test("rejects malformed and oversized command inputs without throwing", () => {
  assert.deepEqual(classifier.classify("", "/repo"), []);
  assert.deepEqual(classifier.classify("x".repeat(16_385), "/repo"), []);
  assert.deepEqual(classifier.classify("git -C commit -m ship", "/repo"), []);
  assert.deepEqual(classifier.classify("gh pr create --repo", "/repo"), []);
  assert.deepEqual(classifier.classify("gh pr create --head=", "/repo"), []);
});
