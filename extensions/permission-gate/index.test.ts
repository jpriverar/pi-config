import assert from "node:assert/strict";
import test from "node:test";

import permissionGate from "./index.js";

type Handler = (event: any) => Promise<unknown> | unknown;

function createHarness() {
  const handlers = new Map<string, Handler>();
  permissionGate({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as any);
  const handler = handlers.get("tool_call");
  assert.ok(handler);
  return (command: unknown, toolName = "bash", includeCommand = true) =>
    handler({
      toolName,
      input: includeCommand ? { command } : {},
    });
}

const denied = [
  "sudo true",
  "rm -rf /",
  "rm --recursive /",
  "killall Finder",
  "mkfs.ext4 /dev/disk9",
  "fdisk /dev/disk9",
  "dd if=/dev/zero of=/dev/disk9",
  "chmod -R 777 /",
  'chown -R "$USER" /',
  "git push --force origin main",
  "git push -f origin master",
  "  /usr/bin/sudo\ttrue  ",
  "/bin/rm   -rf   /",
  "/sbin/mkfs.ext4\t/dev/disk9",
  "/usr/sbin/fdisk   /dev/disk9",
  "/bin/dd\tif=/dev/zero   of=/dev/disk9",
  "/bin/chmod  -R   777  /",
  '/usr/sbin/chown\t-R "$USER" /',
  "/usr/bin/git  push  --force origin main",
];

for (const command of denied) {
  test(`blocks ${JSON.stringify(command)}`, async () => {
    const result = (await createHarness()(command)) as {
      block?: boolean;
      reason?: string;
    };
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /Denied by permission gate:/);
  });
}

const allowed = [
  "echo sudo",
  "rm -rf ./build",
  "chmod 777 ./fixture",
  'chown "$USER" ./fixture',
  "git push origin feature",
  "printf safe",
  "bzl clean",
  "bazel clean",
];

for (const command of allowed) {
  test(`allows ${JSON.stringify(command)}`, async () => {
    assert.equal(await createHarness()(command), undefined);
  });
}

test("ignores non-bash calls, absent commands, and non-string commands", async () => {
  const call = createHarness();

  assert.equal(await call("sudo true", "read"), undefined);
  assert.equal(await call(undefined, "bash", false), undefined);
  assert.equal(await call(42), undefined);
  assert.equal(await call({ command: "sudo true" }), undefined);
});
