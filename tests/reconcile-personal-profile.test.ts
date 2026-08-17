import assert from "node:assert/strict";
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

import {
  MANAGED_NPM_PACKAGES,
  reconcileSettings,
  validateProfile,
} from "../scripts/reconcile-personal-profile.mjs";

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
    JSON.stringify({ servers: [{ url: `https://${workMarker}.example.com` }] }),
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
