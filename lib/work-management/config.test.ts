import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkManagementConfig } from "./config.js";

import { target } from "./test-fixtures.js";

test("config is opt-in, case-normalized and fails closed with its file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-config-"));
  const path = join(dir, "pi-work-management.json");
  try {
    assert.equal(loadWorkManagementConfig(dir), null);
    const config = {
      version: 1,
      ddAuthPath: "/bin/dd-auth",
      curlPath: "/usr/bin/curl",
      workstreams: { Team: target },
    };
    writeFileSync(path, JSON.stringify(config));
    assert.deepEqual(loadWorkManagementConfig(dir)?.workstreams.team, target);
    for (const invalid of [
      { ...config, workstreams: { Team: target, team: target } },
      {
        ...config,
        workstreams: { team: { ...target, site: "attacker.example" } },
      },
      { ...config, workstreams: { team: { ...target, typeId: "" } } },
      {
        ...config,
        workstreams: { team: { ...target, statuses: { actionable: "Open" } } },
      },
      { ...config, ddAuthPath: "dd-auth" },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(
        () => loadWorkManagementConfig(dir),
        /pi-work-management.json/,
      );
    }
    writeFileSync(path, "{bad");
    assert.throws(
      () => loadWorkManagementConfig(dir),
      /pi-work-management.json/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
