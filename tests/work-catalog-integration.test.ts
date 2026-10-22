import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBeadsClient, type BeadsExec } from "../lib/beads.js";
import { createCatalogStore } from "../lib/work-catalog/store.js";
import { catalogFixture, P } from "../lib/work-catalog/test-fixtures.js";
const exec = promisify(execFile);

test(
  "real Beads persists a complete 63 KiB work catalog",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-catalog-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { BEADS_DIR: _dir, BEADS_DB: _db, ...env } = process.env;
    await exec(
      "bd",
      ["init", "--init-if-missing", "--non-interactive", "--prefix", "zz"],
      { cwd: root, env, timeout: 20000 },
    );
    const storePath = join(root, ".beads");
    let commandFailure: { code?: number | string; stderr: string } | undefined;
    const run: BeadsExec = async (command, args, options) => {
      try {
        const output = await exec(command, [...args], {
          cwd: root,
          env: { ...env, ...options?.env },
          maxBuffer: 1024 * 1024,
          timeout: 10000,
        });
        return { code: 0, ...output };
      } catch (error) {
        const e = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        commandFailure = {
          code: e.code,
          stderr: (e.stderr ?? "").slice(-1000),
        };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    };
    const store = createCatalogStore(
      createBeadsClient(run, { env: { BEADS_DIR: storePath } }),
    );
    assert.equal(await store.read(), null);
    const catalog = catalogFixture();
    for (let i = 0; i < 60; i++) {
      const id = "77777777-7777-4777-8777-" + String(i).padStart(12, "0");
      catalog.projects[id] = {
        ...catalog.projects[P],
        id,
        name: "project-" + i,
        workstreamKey: "project-" + i,
        description: "x",
        aliases: [],
      };
    }
    for (const project of Object.values(catalog.projects)) {
      const remaining = 64512 - Buffer.byteLength(JSON.stringify(catalog));
      project.description += "x".repeat(
        Math.min(remaining, 1024 - project.description!.length),
      );
    }
    assert.equal(Buffer.byteLength(JSON.stringify(catalog)), 64512);
    try {
      await store.write(catalog);
    } catch (error) {
      throw new Error(
        `${String(error)}; synthetic-fixture command error: ${JSON.stringify(commandFailure)}`,
      );
    }
    assert.deepEqual(await store.read(), catalog);
  },
);
