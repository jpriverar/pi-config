import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const verifier = join(repository, "scripts", "verify-portable.mjs");
const temporaryDirectories: string[] = [];

function createFixture(files: Record<string, string | Buffer> = {}): {
  root: string;
  run: () => ReturnType<typeof spawnSync>;
} {
  const root = mkdtempSync(join(tmpdir(), "portable-fixture-"));
  temporaryDirectories.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });

  const baseFiles: Record<string, string> = {
    "README.md": "Reviewed public package. Placeholder: YOUR_TOKEN_HERE\n",
    "package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", pi: {} }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({ packages: { "": {}, "node_modules/example": { resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz" } } }, null, 2)}\n`,
    "scripts/refresh-superpowers.sh": "#!/bin/sh\nset -eu\n",
  };
  for (const [path, content] of Object.entries({ ...baseFiles, ...files })) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  chmodSync(join(root, "scripts", "refresh-superpowers.sh"), 0o755);
  execFileSync("git", ["add", "."], { cwd: root });

  return {
    root,
    run: () =>
      spawnSync(process.execPath, [verifier], {
        cwd: root,
        encoding: "utf8",
      }),
  };
}

function assertRejected(
  files: Record<string, string | Buffer>,
  configure?: (root: string) => void,
) {
  const fixture = createFixture(files);
  configure?.(fixture.root);
  const result = fixture.run();
  assert.notEqual(result.status, 0, String(result.stdout));
  assert.match(String(result.stderr), /[^\s]+: .+/);
}

test.after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts only reviewed text, registry metadata, placeholders, and executable scripts", () => {
  const fixture = createFixture();
  const result = fixture.run();

  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /Portable package verified/);
});

test("accepts the immutable reviewed vendor executable set", () => {
  const reviewed = [
    ["brainstorming", "scripts", "start-server.sh"],
    ["brainstorming", "scripts", "stop-server.sh"],
    ["subagent-driven-development", "scripts", "review-package"],
    ["subagent-driven-development", "scripts", "sdd-workspace"],
    ["subagent-driven-development", "scripts", "task-brief"],
    ["systematic-debugging", "find-polluter.sh"],
    ["writing-skills", "render-graphs.js"],
  ].map((parts) => join("skills", "superpowers", ...parts));
  const fixture = createFixture(
    Object.fromEntries(reviewed.map((path) => [path, "#!/bin/sh\nexit 0\n"])),
  );
  for (const path of reviewed) chmodSync(join(fixture.root, path), 0o755);
  execFileSync("git", ["add", "."], { cwd: fixture.root });

  const result = fixture.run();
  assert.equal(result.status, 0, String(result.stderr));
});

test("rejects a tracked symbolic link", () => {
  const fixture = createFixture();
  const target = join(fixture.root, "tests", "linked.md");
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(join("..", "README.md"), target);
  execFileSync("git", ["add", "tests/linked.md"], { cwd: fixture.root });

  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /tracked symlink/);
});

test("rejects native executable formats and other NUL-containing files", async (t) => {
  const cases: Array<[string, Buffer]> = [
    ["Mach-O", Buffer.from([0xfe, 0xed, 0xfa, 0xcf])],
    ["ELF", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ["PE", Buffer.from([0x4d, 0x5a, 0x01, 0x02])],
    ["NUL", Buffer.from([0x61, 0x00, 0x62])],
  ];
  for (const [name, content] of cases) {
    await t.test(name, () => assertRejected({ "tests/payload.bin": content }));
  }
});

test("rejects unreviewed executable modes", async (t) => {
  await t.test("authored file", () => {
    assertRejected({ "scripts/other.sh": "#!/bin/sh\n" }, (root) => {
      chmodSync(join(root, "scripts", "other.sh"), 0o755);
      execFileSync("git", ["add", "scripts/other.sh"], { cwd: root });
    });
  });
  await t.test("unknown vendor file", () => {
    const path = join("skills", "superpowers", "unknown.sh");
    assertRejected({ [path]: "#!/bin/sh\n" }, (root) => {
      chmodSync(join(root, path), 0o755);
      execFileSync("git", ["add", path], { cwd: root });
    });
  });
});

test("rejects private homes, work trees, and manifest escapes", async (t) => {
  const privateLocations = [
    ["macOS home", ["/", "Users", "/", "person", "/src"].join("")],
    ["Linux home", ["/", "home", "/", "person", "/src"].join("")],
    ["work tree", ["~", "/", "d", "d", "/", "repo"].join("")],
  ];
  for (const [name, value] of privateLocations) {
    await t.test(name, () =>
      assertRejected({ "tests/location.txt": `${value}\n` }),
    );
  }
  await t.test("repository escape", () => {
    const escape = ["..", "outside.ts"].join("/");
    assertRejected({
      "package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", pi: { extensions: [escape] } }, null, 2)}\n`,
    });
  });
});

test("rejects credential-shaped assignments and payloads", async (t) => {
  const sensitiveKeys = [
    ["database", "pass" + "word"].join("_"),
    ["service", "to" + "ken"].join("_"),
    ["AWS", "SEC" + "RET", "ACCESS", "KEY"].join("_"),
    ["OPENAI", "API", "KEY"].join("_"),
    ["to", "kens"].join(""),
  ];
  for (const key of sensitiveKeys) {
    await t.test(key, () =>
      assertRejected({
        "tests/credentials.json": `${JSON.stringify({ [key]: "live-value-123" }, null, 2)}\n`,
      }),
    );
  }

  const payloads = [
    [
      "authorization",
      ["Author", "ization"].join("") + ": Bearer abcdefgh123456",
    ],
    [
      "private key",
      ["-----BEGIN ", "PRIVATE", " KEY-----", "\nmaterial"].join(""),
    ],
  ];
  for (const [name, value] of payloads) {
    await t.test(name, () =>
      assertRejected({ "tests/credentials.txt": `${value}\n` }),
    );
  }
});

test("accepts credential placeholders and environment references", () => {
  const sensitive = ["service", "to", "ken"].join("_");
  const envKey = ["OPENAI", "API", "KEY"].join("_");
  const fixture = createFixture({
    "tests/placeholders.txt": [
      `${sensitive}=YOUR_TOKEN_HERE`,
      `${sensitive}=\${SERVICE_TOKEN}`,
      `${sensitive}=process.env.${envKey}`,
      `${sensitive}=<provided-at-runtime>`,
    ].join("\n"),
  });
  const result = fixture.run();
  assert.equal(result.status, 0, String(result.stderr));
});

test("rejects URLs on hosts outside the public allowlist", () => {
  const url = ["https", "://", "example", ".com/resource"].join("");
  assertRejected({ "tests/url.txt": `${url}\n` });
});

test("uses an explicit reviewed URL host set for vendored skills", async (t) => {
  const reviewedHosts = [
    "agentskills.io",
    "code.claude.com",
    "github.com",
    "localhost",
    "mintcdn.com",
    "platform.claude.com",
    "primeradiant.com",
  ];
  await t.test("known hosts", () => {
    const urls = reviewedHosts
      .map((host) => ["https", "://", host, "/reviewed"].join(""))
      .join("\n");
    const fixture = createFixture({
      "skills/superpowers/reviewed.md": `${urls}\n`,
    });
    const result = fixture.run();
    assert.equal(result.status, 0, String(result.stderr));
  });
  await t.test("unknown host", () => {
    const url = ["https", "://", "unknown", ".invalid/reviewed"].join("");
    assertRejected({ "skills/superpowers/reviewed.md": `${url}\n` });
  });
  await t.test("private path", () => {
    const home = ["/", "Users", "/", "vendor-user", "/private"].join("");
    assertRejected({ "skills/superpowers/reviewed.md": `${home}\n` });
  });
  await t.test("credential payload", () => {
    const key = ["vendor", "sec" + "ret"].join("_");
    assertRejected({
      "skills/superpowers/reviewed.md": `${key}=live-value-123\n`,
    });
  });
});

test("validates URL strings recursively in package-lock metadata", async (t) => {
  await t.test("allowed metadata host", () => {
    const lock = {
      packages: {},
      metadata: {
        support: ["https", "://", "github.com", "/example/support"].join(""),
      },
    };
    const fixture = createFixture({
      "package-lock.json": `${JSON.stringify(lock, null, 2)}\n`,
    });
    const result = fixture.run();
    assert.equal(result.status, 0, String(result.stderr));
  });
  await t.test("unknown metadata host", () => {
    const lock = {
      packages: {},
      metadata: {
        support: ["https", "://", "unknown", ".invalid/support"].join(""),
      },
    };
    assertRejected({
      "package-lock.json": `${JSON.stringify(lock, null, 2)}\n`,
    });
  });
});

test("rejects runtime-data paths", async (t) => {
  const paths = [
    ["auth", "tokens.json"],
    ["sessions", "history.jsonl"],
    ["missions", "active.md"],
    ["run-history", "run.json"],
    ["research", "notes.md"],
    ["cache", "entry.json"],
    ["models", "catalog.json"],
    ["mcp", "servers.json"],
    [".beads", "issues.jsonl"],
    ["subagent-artifacts", "result.md"],
  ];
  for (const parts of paths) {
    await t.test(parts.join("/"), () => {
      const path = join("tests", ...parts);
      assertRejected({ [path]: "runtime data\n" });
    });
  }
});

test("rejects missing manifest resources and unknown top-level paths", async (t) => {
  await t.test("missing resource", () => {
    assertRejected({
      "package.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", pi: { themes: ["./themes/missing.json"] } }, null, 2)}\n`,
    });
  });
  await t.test("unknown root", () => {
    assertRejected({ "private/file.txt": "not public\n" });
  });
});
