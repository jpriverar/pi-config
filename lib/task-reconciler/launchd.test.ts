import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectLaunchd } from "./launchd.js";

const domain = "gui/502";
const label = "com.pi.task-reconciler.fixture";
const absent = {
  code: 113,
  stdout: "",
  stderr: `Could not find service "${label}" in domain for user gui:502`,
};

for (const [value, disabled] of [
  ["enabled", false],
  ["disabled", true],
  ["false", false],
  ["true", true],
] as const) {
  test(`recognizes launchd override ${value}`, async () => {
    const state = await inspectLaunchd(
      async (args) =>
        args[0] === "print-disabled"
          ? {
              code: 0,
              stdout: `\n\tdisabled services = {\n\t\t"com.example.unrelated" => enabled\n\t\t"${label}" => ${value}\n\t}\n`,
              stderr: "",
            }
          : absent,
      domain,
      label,
      "/fixture/agent.plist",
      ["/fixture/node"],
    );
    assert.deepEqual(state, { loaded: false, disabled, pid: null });
  });
}
for (const body of [
  `"${label}" => maybe`,
  `"${label}" => enabled_unknown`,
  `"${label}" => enabled\n"${label}" => disabled`,
]) {
  test(`rejects ambiguous or unknown launchd override ${body}`, async () => {
    await assert.rejects(
      inspectLaunchd(
        async () => ({
          code: 0,
          stdout: `disabled services = {\n${body}\n}`,
          stderr: "",
        }),
        domain,
        label,
        "/fixture/agent.plist",
        ["/fixture/node"],
      ),
      /unrecognized|ambiguous/,
    );
  });
}
