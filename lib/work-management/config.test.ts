import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkManagementConfig } from "./config.js";

import { target } from "./test-fixtures.js";

function loadLegacyConfig(path: string) {
  const config = loadWorkManagementConfig(path);
  assert.ok(config?.version === 1);
  return config;
}

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
    assert.deepEqual(loadLegacyConfig(dir).workstreams.team, target);
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

test("config decodes a default destination and preserves normalized opt-outs", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-default-"));
  try {
    writeFileSync(
      join(dir, "pi-work-management.json"),
      JSON.stringify({
        version: 1,
        ddAuthPath: "/bin/dd-auth",
        curlPath: "/usr/bin/curl",
        defaultTarget: target,
        workstreams: { "LOCAL  ": null, Team: target },
      }),
    );
    const config = loadLegacyConfig(dir);
    assert.deepEqual(config.defaultTarget, target);
    assert.equal(config.workstreams.local, null);
    assert.deepEqual(config.workstreams.team, target);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("config rejects invalid defaults and collisions involving opt-outs", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-default-invalid-"));
  const path = join(dir, "pi-work-management.json");
  const config = {
    version: 1,
    ddAuthPath: "/bin/dd-auth",
    curlPath: "/usr/bin/curl",
    defaultTarget: target,
    workstreams: {},
  };
  try {
    for (const invalid of [
      { ...config, defaultTarget: null },
      { ...config, defaultTarget: { ...target, site: "attacker.example" } },
      { ...config, defaultTarget: { ...target, projectId: "" } },
      { ...config, defaultTarget: { ...target, statuses: {} } },
      { ...config, workstreams: { local: null, "LOCAL  ": target } },
      { ...config, workstreams: { local: false } },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(
        () => loadWorkManagementConfig(dir),
        /invalid work management configuration.*pi-work-management.json/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("configuration canonicalizes displayed labels before detecting duplicate mappings", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-canonical-"));
  const path = join(dir, "pi-work-management.json");
  const config = {
    version: 1,
    ddAuthPath: "/bin/dd-auth",
    curlPath: "/usr/bin/curl",
    workstreams: { "ALPHA  ": target },
  };
  try {
    writeFileSync(path, JSON.stringify(config));
    assert.deepEqual(Object.keys(loadLegacyConfig(dir).workstreams), ["alpha"]);
    writeFileSync(
      path,
      JSON.stringify({
        ...config,
        workstreams: { alpha: target, "ALPHA ": target },
      }),
    );
    assert.throws(
      () => loadWorkManagementConfig(dir),
      /invalid work management configuration/,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("catalog config carries only helpers and refuses legacy fallbacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-catalog-config-"));
  const path = join(dir, "pi-work-management.json");
  const config = {
    version: 2,
    routingMode: "catalog",
    ddAuthPath: "/bin/dd-auth",
    curlPath: "/bin/curl",
  };
  try {
    writeFileSync(path, JSON.stringify(config));
    assert.deepEqual(loadWorkManagementConfig(dir), config);
    const legacy = await import(
      "../../tests/fixtures/work-management-config-v1.js"
    );
    assert.throws(
      () => legacy.loadWorkManagementConfig(dir),
      /invalid work management configuration/,
    );
    for (const invalid of [
      { ...config, defaultTarget: target },
      { ...config, workstreams: {} },
      { ...config, routingMode: "fallback" },
      { ...config, ddAuthPath: "dd-auth" },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(
        () => loadWorkManagementConfig(dir),
        /invalid work management configuration/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
