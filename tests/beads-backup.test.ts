import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createBeadsClient,
  withBeadsEnvironment,
  type BeadsExec,
} from "../lib/beads.js";
import { createLifecycleStore } from "../lib/task-lifecycle/beads-store.js";

const execute = promisify(execFile);

for (const integration of ["display", "lifecycle"] as const) {
  for (const inherited of [undefined, "true", "false"]) {
    test(`${integration} reads disable backups without changing the inherited ${inherited ?? "unset"} mutation setting`, async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-beads reads-"));
      const capture = join(root, "backup-env.txt");
      const store = join(root, ".beads");
      const parentSetting = process.env.BD_BACKUP_ENABLED;
      try {
        await writeFile(
          join(root, "bd"),
          '#!/bin/sh\nprintf "%s\\n" "${BD_BACKUP_ENABLED-unset}" >> "$BACKUP_CAPTURE"\nprintf "[]\\n"\n',
          { mode: 0o755 },
        );
        const executeCommand: BeadsExec = async (command, args, options) => {
          const result = await execute(command, [...args], {
            env: {
              ...process.env,
              PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
              BD_BACKUP_ENABLED: inherited,
              BACKUP_CAPTURE: capture,
              ...options?.env,
            },
          });
          return { ...result, code: 0 };
        };
        const exec =
          integration === "display"
            ? withBeadsEnvironment(executeCommand)
            : executeCommand;

        if (integration === "display") {
          const client = createBeadsClient(exec, { env: { BEADS_DIR: store } });
          assert.equal((await client.listIssues()).ok, true);
          assert.equal(
            (
              await client.updateIssueLabels(["jp-1"], {
                addLabels: ["needs:jp"],
              })
            ).ok,
            true,
          );
        } else {
          const client = createLifecycleStore(exec, { store });
          assert.deepEqual(await client.list(["open"]), []);
          await client.addBlocker("jp-1", "jp-blocker", {
            pid: process.pid,
            host: hostname(),
            sessionId: "backup-test",
            started: Date.now(),
          });
        }

        assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [
          "false",
          inherited ?? "unset",
        ]);
        assert.equal(process.env.BD_BACKUP_ENABLED, parentSetting);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
