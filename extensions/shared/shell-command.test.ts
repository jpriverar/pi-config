import assert from "node:assert/strict";
import { describe, test } from "../../tests/expect.js";

import { splitShellCommands, unwrapExecutable } from "./shell-command.js";

describe("splitShellCommands", () => {
  test("keeps quoted separators inside a segment", () => {
    assert.deepEqual(
      splitShellCommands("printf ';|&&\\n' && bazel info output_base").map(
        (command) => command.source,
      ),
      ["printf ';|&&\\n'", "bazel info output_base"],
    );
  });

  test("splits on ;, newline, |, ||, and &&", () => {
    assert.deepEqual(
      splitShellCommands(
        "echo one;\necho two|echo three||echo four&&echo five",
      ).map((command) => command.source),
      ["echo one", "echo two", "echo three", "echo four", "echo five"],
    );
  });
});

describe("unwrapExecutable", () => {
  test("unwraps assignments, control prefixes, and wrappers", () => {
    assert.deepEqual(
      splitShellCommands(
        "FOO=1 env -u BAR command git -C /repo worktree list && echo done",
      ).map(unwrapExecutable),
      [
        { executable: "git", args: ["-C", "/repo", "worktree", "list"] },
        { executable: "echo", args: ["done"] },
      ],
    );
  });

  test("handles env --unset=, exec, and time", () => {
    assert.deepEqual(
      splitShellCommands("if env --unset=FOO exec time bazel test //foo").map(
        unwrapExecutable,
      ),
      [{ executable: "bazel", args: ["test", "//foo"] }],
    );
  });

  test("treats quoted executables as non-executable", () => {
    assert.deepEqual(
      splitShellCommands("'bazel' test //foo").map(unwrapExecutable),
      [undefined],
    );
  });
});
