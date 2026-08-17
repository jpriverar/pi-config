import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const packageJsonPath = join(repository, "package.json");
const readmePath = join(repository, "README.md");
const temporaryDirectories: string[] = [];
const workMarker = ["data", "dog"].join("");

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

function assertRejectedWithRule(
  files: Record<string, string | Buffer>,
  rule: RegExp,
  configure?: (root: string) => void,
) {
  const fixture = createFixture(files);
  configure?.(fixture.root);
  const result = fixture.run();
  assert.notEqual(result.status, 0, String(result.stdout));
  assert.match(String(result.stderr), rule);
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

test("package scripts cover the bootstrap release gates", () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  assert.equal(
    pkg.scripts["test:bootstrap"],
    "tsx --test tests/reconcile-personal-profile.test.ts tests/bootstrap-macos.test.ts",
  );
  assert.equal(
    pkg.scripts["format:check"],
    "prettier --check package.json tsconfig.json 'extensions/**/*.ts' 'lib/**/*.ts' 'tests/**/*.{ts,mjs}' 'scripts/**/*.mjs' skills/grill-me/SKILL.md skills/thinking-partner/SKILL.md skills/handoff/SKILL.md 'themes/*.json' README.md THIRD_PARTY_NOTICES.md",
  );
  assert.match(pkg.scripts["verify:skills"], /--mode baseline/);
  assert.match(pkg.scripts["verify:skills"], /--mode package/);
  assert.match(pkg.scripts["verify:skills"], /--package "\$PWD"/);
  assert.match(pkg.scripts["verify:skills"], /PI_SKILL_TEST_MODEL/);
});

test("README documents the public macOS bootstrap flow and boundaries", () => {
  const readme = readFileSync(readmePath, "utf8");
  const normalizedReadme = readme.replace(/\s+/g, " ");

  assert.match(
    readme,
    /```sh\nset -euo pipefail\ngit clone https:\/\/github\.com\/jpriverar\/pi-config\.git\ncd pi-config\n\.\/scripts\/bootstrap-macos\.sh\n```/,
  );
  for (const snippet of [
    "Homebrew is the only prerequisite.",
    "The script installs and owns Node.js 22.19.0 via Volta, Pi 0.84.1, this checkout as the local Pi package source, and five public npm package sources:",
    "- `npm:pi-mcp-adapter@2.26.0`",
    "- `npm:pi-subagents@0.50.0`",
    "- `npm:context-mode@1.0.169`",
    "- `npm:pi-markdown-preview@0.14.1`",
    "- `npm:@juicesharp/rpiv-ask-user-question@2.6.1`",
    "Any clone path is valid; whichever checkout you bootstrap becomes the local package source that Pi loads.",
    "Provider setup stays personal and interactive through `/login`.",
    "`$HOME/.pi/agent`",
    "`$HOME/beads/.beads`",
    "It initializes only an empty personal Beads store with prefix `jp` and configures no remote.",
    "Rerunning `./scripts/bootstrap-macos.sh` is safe: a successful second run leaves the managed configuration byte-identical.",
    "If existing managed state conflicts with the reviewed personal-only boundaries, the bootstrap refuses the conflict instead of guessing.",
    "Update by running `git pull --ff-only` in the same checkout, then `/reload` inside Pi.",
    "To roll back, check out an earlier repository commit in the same checkout and run `/reload` again.",
    "Pi's generated npm workspace currently records caret dependency ranges even when settings contain versioned sources.",
    "The bootstrap verifies the final resolved package versions after Pi finishes package operations.",
    "It excludes work configuration, copied history, credentials, providers, MCP setup, and Beads remotes.",
  ]) {
    assert.equal(
      normalizedReadme.includes(snippet),
      true,
      `missing README snippet: ${snippet}`,
    );
  }
  assert.equal(
    readme.includes("The macOS bootstrap is intentionally not included."),
    false,
  );
});

test("rejects forbidden literals in tracked test sources", () => {
  const privateLocation = ["/", "Users", "/", "person", "/src"].join("");

  assertRejectedWithRule(
    {
      "tests/forbidden-source.ts": `export const leak = ${JSON.stringify(privateLocation)};\n`,
    },
    /tests\/forbidden-source\.ts: absolute macOS home path/,
  );
});

test("accepts the reviewed bootstrap artifacts and still rejects unrelated scripts executables", () => {
  const fixture = createFixture({
    "README.md": [
      "# Public bootstrap",
      "Clone https://github.com/jpriverar/pi-config.git",
      "Provider setup stays personal and interactive through /login.",
      "Pi keeps its managed state under $HOME/.pi/agent.",
      "Beads keeps its personal store under $HOME/beads/.beads.",
      "Update with git pull --ff-only and then /reload.",
      "No credentials are included.",
      "",
    ].join("\n"),
    "scripts/bootstrap-macos.sh": [
      "#!/bin/sh",
      "set -eu",
      'printf "%s\\n" "$HOME/.pi/agent"',
      'printf "%s\\n" "$HOME/beads/.beads"',
      'printf "%s\\n" "Run /login after bootstrap"',
      "",
    ].join("\n"),
  });
  chmodSync(join(fixture.root, "scripts", "bootstrap-macos.sh"), 0o755);
  execFileSync("git", ["add", "."], { cwd: fixture.root });

  const result = fixture.run();
  assert.equal(result.status, 0, String(result.stderr));

  assertRejectedWithRule(
    { "scripts/other.sh": "#!/bin/sh\n" },
    /scripts\/other\.sh: executable mode is not reviewed/,
    (root) => {
      chmodSync(join(root, "scripts", "other.sh"), 0o755);
      execFileSync("git", ["add", "scripts/other.sh"], { cwd: root });
    },
  );
});

test("rejects forbidden runtime state and work identifiers in tracked bootstrap artifacts", async (t) => {
  await t.test("runtime state under the personal Pi root", () => {
    assertRejectedWithRule(
      {
        "README.md": [
          "Public bootstrap docs",
          "Do not copy $HOME/.pi/agent/auth.json into this package.",
          "",
        ].join("\n"),
      },
      /README\.md: bootstrap runtime-state reference is forbidden/,
    );
  });

  await t.test("work-only package source in the bootstrap script", () => {
    assertRejectedWithRule(
      {
        "scripts/bootstrap-macos.sh": [
          "#!/bin/sh",
          "set -eu",
          `pi install npm:@${workMarker}/private-plugin@1.0.0`,
          "",
        ].join("\n"),
      },
      /scripts\/bootstrap-macos\.sh: bootstrap work-only identifier is forbidden/,
      (root) => {
        chmodSync(join(root, "scripts", "bootstrap-macos.sh"), 0o755);
        execFileSync("git", ["add", "scripts/bootstrap-macos.sh"], {
          cwd: root,
        });
      },
    );
  });
});

test("accepts source placeholders used by the release tests", () => {
  const fixture = createFixture({
    "tests/source-placeholders.ts": [
      'const workMarker = ["data", "dog"].join("");',
      'const protocol = ["https", "://"].join("");',
      'const hostSuffix = [".", "example", ".com"].join("");',
      "const authConfig = {",
      "  baseUrl: `${protocol}${workMarker}${hostSuffix}`,",
      '  tokenRef: "${TOKEN_REF}",',
      "};",
      'const sensitive = ["to", "ken"].join("");',
      'const rawValue = ["raw", "-json", "-must", "-not", "-leak"].join("");',
      'const malformedPackage = `{\\n  "name": "pi-mcp-adapter",\\n  "${sensitive}": "${rawValue}"\\n}`;',
      "void authConfig;",
      "void malformedPackage;",
      "",
    ].join("\n"),
  });
  const result = fixture.run();

  assert.equal(result.status, 0, String(result.stderr));
});

test("rejects literal unreviewed hosts even when interpolation appears outside the host", () => {
  const url = ["https", "://", "example", ".com", "/${suffix}"].join("");

  assertRejectedWithRule(
    {
      "tests/url-template-bypass.ts": `export const url = ${JSON.stringify(url)};\n`,
    },
    /tests\/url-template-bypass\.ts: URL host is not reviewed: example\.com/,
  );
});

test("accepts tracked test-source template URLs that are not literal hosts", () => {
  const workIdentifier = ["data", "dog"].join("");
  const fixture = createFixture({
    "tests/source-template-url.ts": [
      `const workMarker = ${JSON.stringify(workIdentifier)};`,
      'const protocol = ["https", "://"].join("");',
      'const host = ["${", "workMarker", "}", ".example", ".com"].join("");',
      "const baseUrl = `${protocol}${host}`;",
      "void baseUrl;",
      "",
    ].join("\n"),
  });
  const result = fixture.run();

  assert.equal(result.status, 0, String(result.stderr));
});

test("accepts tracked test-source redaction markers for credential-shaped fixtures", () => {
  const sensitive = ["to", "ken"].join("");
  const redaction = ["raw", "-json", "-must", "-not", "-leak"].join("");
  const fixture = createFixture({
    "tests/source-redaction.ts": [
      "const packageBytes = '",
      `  "name": "pi-mcp-adapter",\\n`,
      `  "${sensitive}": "${redaction}",\\n`,
      "';",
      "void packageBytes;",
      "",
    ].join("\n"),
  });
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
