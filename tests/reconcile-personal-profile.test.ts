import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MANAGED_NPM_PACKAGES,
  reconcileSettings,
  reconcileShell,
  validateProfile,
  verifyInstalledPackages,
} from "../scripts/reconcile-personal-profile.mjs";

const reconcilerPath = fileURLToPath(
  new URL("../scripts/reconcile-personal-profile.mjs", import.meta.url),
);

const managedBlock = [
  "# >>> jpriverar pi bootstrap >>>",
  'export VOLTA_HOME="$HOME/.volta"',
  'export PATH="$VOLTA_HOME/bin:$PATH"',
  'export BEADS_DIR="$HOME/beads/.beads"',
  "# <<< jpriverar pi bootstrap <<<",
  "",
].join("\n");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "personal-profile-"));
  return {
    root,
    agentDir: join(root, "home", ".pi", "agent"),
    repoDir: join(root, "checkout with spaces"),
  };
}

async function writeSettings(agentDir: string, settings: unknown) {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

async function writeInstalledPackages(
  agentDir: string,
  versions: Record<string, string>,
) {
  for (const [name, version] of Object.entries(versions)) {
    const packageJsonPath = join(
      agentDir,
      "npm",
      "node_modules",
      ...name.split("/"),
      "package.json",
    );
    await mkdir(join(packageJsonPath, ".."), { recursive: true });
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ name, version }, null, 2)}\n`,
    );
  }
}

async function writeInstalledPackageBytes(
  agentDir: string,
  name: string,
  bytes: string,
) {
  const packageJsonPath = join(
    agentDir,
    "npm",
    "node_modules",
    ...name.split("/"),
    "package.json",
  );
  await mkdir(join(packageJsonPath, ".."), { recursive: true });
  await writeFile(packageJsonPath, bytes);
  return packageJsonPath;
}

test("fresh settings load the checkout and exact public packages", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const result = await reconcileSettings(state);
  const settings = JSON.parse(
    await readFile(join(state.agentDir, "settings.json"), "utf8"),
  );

  assert.equal(result.changed, true);
  assert.deepEqual(settings, {
    theme: "modus-vivendi-tinted",
    defaultThinkingLevel: "high",
    packages: [
      state.repoDir,
      ...MANAGED_NPM_PACKAGES.map(({ source }) => source),
    ],
    hideThinkingBlock: true,
    quietStartup: true,
  });
});

test("existing settings preserve unrelated entries and reruns are idempotent", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const existing = {
    defaultProvider: "personal-provider",
    customSetting: { keep: true },
    packages: [
      "npm:some-public-helper@1.2.3",
      "npm:context-mode@0.9.0",
      "npm:context-mode@0.8.0",
      "git:github.com/jpriverar/pi-config@old-ref",
    ],
  };
  const settingsPath = join(state.agentDir, "settings.json");

  await writeSettings(state.agentDir, existing);

  const first = await reconcileSettings(state);
  const firstBytes = await readFile(settingsPath, "utf8");
  const settings = JSON.parse(firstBytes);

  assert.equal(first.changed, true);
  assert.equal(settings.defaultProvider, existing.defaultProvider);
  assert.deepEqual(settings.customSetting, existing.customSetting);
  assert.deepEqual(settings.packages, [
    "npm:some-public-helper@1.2.3",
    "npm:context-mode@1.0.169",
    state.repoDir,
    "npm:pi-mcp-adapter@2.26.0",
    "npm:pi-subagents@0.50.0",
    "npm:pi-markdown-preview@0.14.1",
    "npm:@juicesharp/rpiv-ask-user-question@2.6.1",
  ]);

  const second = await reconcileSettings(state);
  const secondBytes = await readFile(settingsPath, "utf8");

  assert.equal(second.changed, false);
  assert.equal(secondBytes, firstBytes);
});

test("unrelated provider and auth settings containing the work marker are preserved", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const workMarker = ["data", "dog"].join("");
  const existing = {
    defaultProvider: `${workMarker}-personal-provider`,
    defaultModel: `${workMarker}-gpt`,
    authConfig: {
      baseUrl: `${["https", "://"].join("")}${workMarker}${[".", "example", ".com"].join("")}`,
      tokenRef: `${workMarker}-token`,
    },
    packages: ["npm:some-public-helper@1.2.3"],
  };

  await writeSettings(state.agentDir, existing);

  const result = await reconcileSettings(state);
  const settings = JSON.parse(
    await readFile(join(state.agentDir, "settings.json"), "utf8"),
  );

  assert.equal(result.changed, true);
  assert.equal(settings.defaultProvider, existing.defaultProvider);
  assert.equal(settings.defaultModel, existing.defaultModel);
  assert.deepEqual(settings.authConfig, existing.authConfig);
  assert.deepEqual(settings.packages, [
    "npm:some-public-helper@1.2.3",
    state.repoDir,
    ...MANAGED_NPM_PACKAGES.map(({ source }) => source),
  ]);
});

test("malformed settings reject with the curated path error", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const settingsPath = join(state.agentDir, "settings.json");
  await mkdir(state.agentDir, { recursive: true });
  await writeFile(settingsPath, "{\n");

  await assert.rejects(
    validateProfile(state),
    new Error(`Cannot parse personal Pi settings at ${settingsPath}`),
  );
});

test("malformed MCP configuration rejects with the curated path error", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const mcpPath = join(state.agentDir, "mcp.json");
  await mkdir(state.agentDir, { recursive: true });
  await writeFile(mcpPath, "{\n");

  await assert.rejects(
    validateProfile(state),
    new Error(`Cannot parse personal Pi MCP configuration at ${mcpPath}`),
  );
});

test("symlinked agent directories reject before settings are read", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const targetAgentDir = join(state.root, "linked-agent");
  await mkdir(targetAgentDir, { recursive: true });
  await writeFile(join(targetAgentDir, "settings.json"), "{\n");
  await mkdir(join(state.root, "home", ".pi"), { recursive: true });
  await symlink(targetAgentDir, state.agentDir);

  await assert.rejects(
    validateProfile(state),
    new Error(
      `Cannot use symlinked personal Pi agent directory at ${state.agentDir}`,
    ),
  );
});

test("unknown local package sources reject with package index and path", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const settingsPath = join(state.agentDir, "settings.json");
  for (const source of ["./local-helper", join(state.root, "other-checkout")]) {
    await writeSettings(state.agentDir, { packages: [source] });

    await assert.rejects(
      validateProfile(state),
      new Error(
        `Unsupported local package source at package index 0 in ${settingsPath}: ${source}`,
      ),
    );
  }
});

test("unknown public package sources are preserved", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  await writeSettings(state.agentDir, {
    packages: [
      "npm:some-public-helper@1.2.3",
      "git:github.com/someone/other-plugin@main",
      "https://github.com/someone/other-plugin",
    ],
  });

  await reconcileSettings(state);
  const settings = JSON.parse(
    await readFile(join(state.agentDir, "settings.json"), "utf8"),
  );

  assert.deepEqual(settings.packages, [
    "npm:some-public-helper@1.2.3",
    "git:github.com/someone/other-plugin@main",
    "https://github.com/someone/other-plugin",
    state.repoDir,
    ...MANAGED_NPM_PACKAGES.map(({ source }) => source),
  ]);
});

test("work-only package and MCP markers are rejected", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const workMarker = ["data", "dog"].join("");
  const settingsPath = join(state.agentDir, "settings.json");
  const mcpPath = join(state.agentDir, "mcp.json");
  const forbiddenSource = `npm:@${workMarker}/private-plugin@1.0.0`;

  await writeSettings(state.agentDir, { packages: [forbiddenSource] });
  await assert.rejects(
    validateProfile(state),
    new Error(
      `Forbidden work-only package source at package index 0 in ${settingsPath}`,
    ),
  );

  await writeSettings(state.agentDir, { packages: [] });
  await writeFile(
    mcpPath,
    JSON.stringify({
      servers: [
        {
          url: `${["https", "://"].join("")}${workMarker}${[".", "example", ".com"].join("")}`,
        },
      ],
    }),
  );
  await assert.rejects(
    validateProfile(state),
    new Error(`Forbidden work-only MCP configuration at ${mcpPath}`),
  );
});

test("atomic write failures leave settings untouched and clean up temp files", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const settingsPath = join(state.agentDir, "settings.json");
  await writeSettings(state.agentDir, { customSetting: true, packages: [] });
  const originalBytes = await readFile(settingsPath, "utf8");

  await assert.rejects(
    reconcileSettings({
      ...state,
      fileOperations: {
        lstat,
        mkdir,
        readFile,
        rename: async () => {
          throw new Error("simulated rename failure");
        },
        rm,
        writeFile,
      },
    }),
    new Error(`Cannot replace personal Pi settings at ${settingsPath}`),
  );

  assert.equal(await readFile(settingsPath, "utf8"), originalBytes);
  assert.equal(
    (await readdir(state.agentDir)).some((entry) => entry.includes(".tmp-")),
    false,
  );
});

test("missing .zshrc creates the managed shell block", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const zshrcPath = join(state.root, ".zshrc");
  const result = await reconcileShell({ zshrcPath });

  assert.deepEqual(result, { changed: true });
  assert.equal(await readFile(zshrcPath, "utf8"), managedBlock);
  await assert.rejects(
    readFile(`${zshrcPath}.jpriverar-pi-bootstrap.bak`, "utf8"),
  );
});

test("shell reconciliation preserves unrelated bytes and reruns idempotently", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const zshrcPath = join(state.root, ".zshrc");
  const originalBytes = [
    "# existing header\r",
    "alias pi='pi --color=always'\r",
    "# >>> jpriverar pi bootstrap >>>",
    'export VOLTA_HOME="$HOME/.volta-old"',
    "# <<< jpriverar pi bootstrap <<<",
    "# existing footer\n",
  ].join("\n");
  await writeFile(zshrcPath, originalBytes);

  const first = await reconcileShell({ zshrcPath });
  const firstBytes = await readFile(zshrcPath, "utf8");
  const backupPath = `${zshrcPath}.jpriverar-pi-bootstrap.bak`;

  assert.deepEqual(first, { changed: true, backupPath });
  assert.equal(await readFile(backupPath, "utf8"), originalBytes);
  assert.equal(
    firstBytes,
    `${["# existing header\r", "alias pi='pi --color=always'\r"].join("\n")}\n${managedBlock}# existing footer\n`,
  );

  const second = await reconcileShell({ zshrcPath });
  const secondBytes = await readFile(zshrcPath, "utf8");

  assert.deepEqual(second, { changed: false });
  assert.equal(secondBytes, firstBytes);
});

test("shell reconciliation rejects malformed marker counts without changing the file", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const cases = [
    {
      name: "duplicate start marker",
      bytes: [
        "# >>> jpriverar pi bootstrap >>>",
        "# >>> jpriverar pi bootstrap >>>",
        "# <<< jpriverar pi bootstrap <<<",
        "",
      ].join("\n"),
    },
    {
      name: "duplicate end marker",
      bytes: [
        "# >>> jpriverar pi bootstrap >>>",
        "# <<< jpriverar pi bootstrap <<<",
        "# <<< jpriverar pi bootstrap <<<",
        "",
      ].join("\n"),
    },
    {
      name: "unmatched start marker",
      bytes: ["before", "# >>> jpriverar pi bootstrap >>>", "after", ""].join(
        "\n",
      ),
    },
    {
      name: "unmatched end marker",
      bytes: ["before", "# <<< jpriverar pi bootstrap <<<", "after", ""].join(
        "\n",
      ),
    },
  ];

  for (const { name, bytes } of cases) {
    await t.test(name, async () => {
      const zshrcPath = join(state.root, `${name}.zshrc`);
      const backupPath = `${zshrcPath}.jpriverar-pi-bootstrap.bak`;
      await writeFile(zshrcPath, bytes);

      await assert.rejects(
        reconcileShell({ zshrcPath }),
        /Cannot reconcile managed shell block/,
      );
      assert.equal(await readFile(zshrcPath, "utf8"), bytes);
      await assert.rejects(readFile(backupPath, "utf8"));
    });
  }
});

test("shell reconciliation rejects inline marker text without changing the file", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const cases = [
    {
      name: "quoted start marker",
      bytes: [
        'echo "# >>> jpriverar pi bootstrap >>>"',
        "# <<< jpriverar pi bootstrap <<<",
        "after",
        "",
      ].join("\n"),
    },
    {
      name: "quoted end marker",
      bytes: [
        "# >>> jpriverar pi bootstrap >>>",
        'echo "# <<< jpriverar pi bootstrap <<<"',
        "after",
        "",
      ].join("\n"),
    },
  ];

  for (const { name, bytes } of cases) {
    await t.test(name, async () => {
      const zshrcPath = join(state.root, `${name}.zshrc`);
      const backupPath = `${zshrcPath}.jpriverar-pi-bootstrap.bak`;
      await writeFile(zshrcPath, bytes);

      await assert.rejects(
        reconcileShell({ zshrcPath }),
        new Error(`Cannot reconcile managed shell block in ${zshrcPath}`),
      );
      assert.equal(await readFile(zshrcPath, "utf8"), bytes);
      await assert.rejects(readFile(backupPath, "utf8"));
    });
  }
});

test("symlinked .zshrc files reject", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const targetPath = join(state.root, "target.zshrc");
  const zshrcPath = join(state.root, ".zshrc");
  await writeFile(targetPath, "# existing\n");
  await symlink(targetPath, zshrcPath);

  await assert.rejects(
    reconcileShell({ zshrcPath }),
    new Error(`Cannot use symlinked shell profile at ${zshrcPath}`),
  );
});

test("installed package verification accepts exact versions and settings sources", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  await reconcileSettings(state);
  await writeInstalledPackages(
    state.agentDir,
    Object.fromEntries(
      MANAGED_NPM_PACKAGES.map(({ name, version }) => [name, version]),
    ),
  );

  await verifyInstalledPackages(state);
});

test("installed package verification rejects mismatched versions without leaking package metadata", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const mismatched = MANAGED_NPM_PACKAGES[2];
  await reconcileSettings(state);
  await writeInstalledPackages(
    state.agentDir,
    Object.fromEntries(
      MANAGED_NPM_PACKAGES.map(({ name, version }) => [
        name,
        name === mismatched.name ? "0.0.1" : version,
      ]),
    ),
  );

  await assert.rejects(
    async () => verifyInstalledPackages(state),
    (error) => {
      assert.equal(
        error instanceof Error ? error.message : String(error),
        `Resolved ${mismatched.name}@0.0.1; expected ${mismatched.version}`,
      );
      assert.equal(
        error instanceof Error
          ? error.message.includes('"version": "0.0.1"')
          : false,
        false,
      );
      return true;
    },
  );
});

test("installed package verification rejects missing packages", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  await reconcileSettings(state);
  await writeInstalledPackages(
    state.agentDir,
    Object.fromEntries(
      MANAGED_NPM_PACKAGES.slice(1).map(({ name, version }) => [name, version]),
    ),
  );

  await assert.rejects(
    verifyInstalledPackages(state),
    new Error(
      `Managed package is not installed: ${MANAGED_NPM_PACKAGES[0].name}`,
    ),
  );
});

test("installed package verification rejects missing managed settings sources", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  await writeSettings(state.agentDir, {
    packages: MANAGED_NPM_PACKAGES.map(({ source }) => source),
  });
  await writeInstalledPackages(
    state.agentDir,
    Object.fromEntries(
      MANAGED_NPM_PACKAGES.map(({ name, version }) => [name, version]),
    ),
  );

  await assert.rejects(
    verifyInstalledPackages(state),
    new Error(
      `Managed core package source is not configured exactly once: ${state.repoDir}`,
    ),
  );
});

test("installed package verification rejects malformed package metadata with the curated path error", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const malformedPackage = MANAGED_NPM_PACKAGES[0];
  await reconcileSettings(state);
  await writeInstalledPackages(
    state.agentDir,
    Object.fromEntries(
      MANAGED_NPM_PACKAGES.slice(1).map(({ name, version }) => [name, version]),
    ),
  );
  const packageJsonPath = await writeInstalledPackageBytes(
    state.agentDir,
    malformedPackage.name,
    '{\n  "name": "pi-mcp-adapter",\n  "token": "raw-json-must-not-leak",\n',
  );

  await assert.rejects(
    async () => verifyInstalledPackages(state),
    (error) => {
      assert.equal(
        error instanceof Error ? error.message : String(error),
        `Cannot parse installed managed package metadata at ${packageJsonPath}`,
      );
      assert.equal(
        error instanceof Error
          ? error.message.includes("raw-json-must-not-leak")
          : false,
        false,
      );
      return true;
    },
  );
});

test("CLI commands emit one JSON line on success", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const validate = spawnSync(
    process.execPath,
    [
      reconcilerPath,
      "validate",
      "--agent-dir",
      state.agentDir,
      "--repo-dir",
      state.repoDir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(validate.status, 0, validate.stderr);
  assert.deepEqual(JSON.parse(validate.stdout), { changed: false });
  assert.equal(validate.stderr, "");

  const settings = spawnSync(
    process.execPath,
    [
      reconcilerPath,
      "settings",
      "--agent-dir",
      state.agentDir,
      "--repo-dir",
      state.repoDir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(settings.status, 0, settings.stderr);
  assert.deepEqual(JSON.parse(settings.stdout), { changed: true });
  assert.equal(settings.stderr, "");

  await writeInstalledPackages(
    state.agentDir,
    Object.fromEntries(
      MANAGED_NPM_PACKAGES.map(({ name, version }) => [name, version]),
    ),
  );
  const verify = spawnSync(
    process.execPath,
    [
      reconcilerPath,
      "verify",
      "--agent-dir",
      state.agentDir,
      "--repo-dir",
      state.repoDir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(verify.status, 0, verify.stderr);
  assert.deepEqual(JSON.parse(verify.stdout), { changed: false });
  assert.equal(verify.stderr, "");

  const zshrcPath = join(state.root, ".zshrc");
  const shell = spawnSync(
    process.execPath,
    [reconcilerPath, "shell", "--zshrc", zshrcPath],
    { encoding: "utf8" },
  );
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(JSON.parse(shell.stdout), { changed: true });
  assert.equal(shell.stderr, "");
});

test("CLI rejects missing required flags with one-line contextual errors", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [reconcilerPath, "settings", "--agent-dir", state.agentDir],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Missing required flag --repo-dir for settings\n",
  );
});

test("CLI rejects unknown commands with one-line contextual errors", () => {
  const result = spawnSync(process.execPath, [reconcilerPath, "nope"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Unknown command: nope\n");
});
