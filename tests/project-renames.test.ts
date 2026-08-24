import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeProjectRenameRegistry,
  emptyProjectRenameRegistry,
  encodeProjectRenameRegistry,
  recordProjectRename,
  resolveProjectRename,
  validateProjectName,
} from "../lib/project-renames.js";

test("an absent config value decodes as an empty versioned registry", () => {
  assert.deepEqual(decodeProjectRenameRegistry(""), {
    version: 1,
    aliases: {},
  });
  assert.deepEqual(decodeProjectRenameRegistry(undefined), {
    version: 1,
    aliases: {},
  });
});

test("empty registries are independent immutable values", () => {
  const first = emptyProjectRenameRegistry();
  const second = emptyProjectRenameRegistry();

  assert.deepEqual(first, { version: 1, aliases: {} });
  assert.deepEqual(second, { version: 1, aliases: {} });
  assert.notEqual(first, second);
  assert.notEqual(first.aliases, second.aliases);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.aliases), true);
  assert.equal(Object.isFrozen(second), true);
  assert.equal(Object.isFrozen(second.aliases), true);
});

test("rename chains resolve to the latest canonical target", () => {
  const registry = {
    version: 1 as const,
    aliases: { alpha: "Beta", beta: "Gamma" },
  };

  assert.equal(resolveProjectRename(registry, "ALPHA"), "Gamma");
});

test("case-only aliases resolve once without becoming cycles", () => {
  assert.equal(
    resolveProjectRename({ version: 1, aliases: { alpha: "ALPHA" } }, "alpha"),
    "ALPHA",
  );
});

test("prototype property names are treated as ordinary project names", () => {
  const empty = emptyProjectRenameRegistry();

  assert.equal(resolveProjectRename(empty, "constructor"), undefined);
  assert.equal(resolveProjectRename(empty, "__proto__"), undefined);

  const decoded = decodeProjectRenameRegistry(
    '{"version":1,"aliases":{"__proto__":"Constructor","constructor":"Target"}}',
  );
  assert.equal(Object.hasOwn(decoded.aliases, "__proto__"), true);
  assert.equal(Object.hasOwn(decoded.aliases, "constructor"), true);
  assert.equal(resolveProjectRename(decoded, "__PROTO__"), "Target");
  assert.deepEqual(
    decodeProjectRenameRegistry(encodeProjectRenameRegistry(decoded)),
    decoded,
  );

  const recordedKey = recordProjectRename(empty, "__proto__", "Alpha");
  assert.equal(Object.hasOwn(recordedKey.aliases, "__proto__"), true);
  assert.equal(resolveProjectRename(recordedKey, "__proto__"), "Alpha");

  const recordedTarget = recordProjectRename(empty, "Beta", "__proto__");
  assert.equal(resolveProjectRename(recordedTarget, "beta"), "__proto__");
});

test("cycles fail closed", () => {
  assert.equal(
    resolveProjectRename(
      { version: 1, aliases: { alpha: "beta", beta: "alpha" } },
      "alpha",
    ),
    undefined,
  );
});

test("recordProjectRename removes the reused target alias and does not mutate the input", () => {
  const before = {
    version: 1 as const,
    aliases: { alpha: "Beta", beta: "Gamma" },
  };

  const after = recordProjectRename(before, "Delta", "Alpha");

  assert.deepEqual(before, {
    version: 1,
    aliases: { alpha: "Beta", beta: "Gamma" },
  });
  assert.deepEqual(after, {
    version: 1,
    aliases: { beta: "Gamma", delta: "Alpha" },
  });
  assert.notEqual(after, before);
  assert.notEqual(after.aliases, before.aliases);
  assert.equal(Object.isFrozen(after), true);
  assert.equal(Object.isFrozen(after.aliases), true);
});

test("reusing a historical target removes the cycle-forming alias", () => {
  const before = { version: 1 as const, aliases: { alpha: "Beta" } };

  assert.deepEqual(recordProjectRename(before, "Beta", "Alpha"), {
    version: 1,
    aliases: { beta: "Alpha" },
  });
});

test("encode and decode round-trip versioned registries", () => {
  const registry = {
    version: 1 as const,
    aliases: { alpha: "Beta", beta: "Gamma" },
  };

  const decoded = decodeProjectRenameRegistry(
    encodeProjectRenameRegistry(registry),
  );

  assert.deepEqual(decoded, registry);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.aliases), true);
});

test("decode rejects malformed values", () => {
  assert.throws(() => decodeProjectRenameRegistry("{"), /must be valid JSON/);
  assert.throws(
    () => decodeProjectRenameRegistry('{"version":2,"aliases":{}}'),
    /unsupported registry version/,
  );
  assert.throws(
    () =>
      decodeProjectRenameRegistry('{"version":1,"aliases":{"Alpha":"Beta"}}'),
    /alias keys must be lowercase/,
  );
  assert.throws(
    () =>
      decodeProjectRenameRegistry(
        '{"version":1,"aliases":{"alpha":"Beta,Gamma"}}',
      ),
    /invalid alias target/,
  );
  assert.throws(
    () => decodeProjectRenameRegistry('{"version":1,"aliases":{"alpha":1}}'),
    /invalid alias target/,
  );
});

test("validateProjectName preserves current acceptance and error messages", () => {
  assert.deepEqual(validateProjectName("Alpha"), { ok: true, value: "Alpha" });
  assert.deepEqual(validateProjectName(""), {
    ok: false,
    message: "Project name cannot be empty",
  });
  assert.deepEqual(validateProjectName("Alpha,Beta"), {
    ok: false,
    message: "Project name must not contain commas",
  });
  assert.deepEqual(validateProjectName("Alpha\tBeta"), {
    ok: false,
    message:
      "Project name contains unsupported whitespace or control characters",
  });
  assert.deepEqual(validateProjectName("Alpha "), {
    ok: false,
    message:
      "Project name contains unsupported whitespace or control characters",
  });
  assert.deepEqual(validateProjectName(`${"🙂".repeat(117)}`), {
    ok: true,
    value: `${"🙂".repeat(117)}`,
  });
  assert.deepEqual(validateProjectName(`${"🙂".repeat(118)}`), {
    ok: false,
    message: "Project name must be 117 characters or fewer",
  });
});
