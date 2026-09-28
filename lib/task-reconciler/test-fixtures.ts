import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const fixturePolicy = {
  version: 1,
  executionTimeoutMs: 21_600_000,
  activityWriteIntervalMs: 300_000,
  sessionReconcileLimit: 10,
  sessionPrCheckLimit: 5,
  prPollIntervalMs: 900_000,
  maxBackoffMs: 21_600_000,
  warningErrorCount: 3,
};

export async function configFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "reconciler-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".beads"));
  await writeFile(join(root, "pool.json"), "{}");
  await writeFile(join(root, "lifecycle.json"), JSON.stringify(fixturePolicy));
  const raw: Record<string, unknown> = {
    version: 1,
    store: join(root, ".beads"),
    poolConfigPath: join(root, "pool.json"),
    lifecycleConfigPath: join(root, "lifecycle.json"),
    runtimeRoot: join(root, "runtime"),
    executables: {
      node: process.execPath,
      bd: process.execPath,
      git: process.execPath,
      gh: process.execPath,
    },
    githubAccounts: { example: "account-one" },
  };
  const configPath = join(root, "config.json");
  const save = () => writeFile(configPath, JSON.stringify(raw));
  await save();
  return { root, raw, configPath, save };
}
