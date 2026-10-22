import assert from "node:assert/strict";
import test from "node:test";

import {
  generateSessionProjectName,
  persistSessionProject,
  resolveSessionProject,
  resolveSessionWorkScope,
  persistSessionWorkScope,
} from "../lib/session-project.js";

import {
  A,
  P,
  NEW,
  catalogFixture,
} from "../lib/work-catalog/test-fixtures.js";

interface Entry {
  type?: string;
  customType?: string;
  data?: unknown;
}

function session(
  entries: readonly Entry[] = [],
  name: string | undefined = undefined,
) {
  const appended: Array<{ customType: string; data: unknown }> = [];
  return {
    appended,
    getEntries: () => entries,
    getSessionName: () => name,
    appendCustomEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  };
}

function projectEntry(data: unknown): Entry {
  return { type: "custom", customType: "jp-project-scope", data };
}

test("explicit project metadata overrides a different display name", () => {
  const manager = session(
    [projectEntry({ version: 1, workstream: "pi-setup" })],
    "legacy-project",
  );

  assert.deepEqual(resolveSessionProject(manager), {
    workstream: "pi-setup",
    source: "explicit",
  });
});

test("explicit global metadata overrides a non-empty display name", () => {
  const manager = session(
    [projectEntry({ version: 1, workstream: null })],
    "legacy-project",
  );

  assert.deepEqual(resolveSessionProject(manager), {
    workstream: undefined,
    source: "explicit",
  });
});

test("sessions without metadata use the exact display name", () => {
  const manager = session([], "Project Name-ABC12345");

  assert.deepEqual(resolveSessionProject(manager), {
    workstream: "Project Name-ABC12345",
    source: "legacy-display-name",
  });
});

test("sessions without metadata or a display name resolve with no source", () => {
  assert.deepEqual(resolveSessionProject(session()), {
    workstream: undefined,
    source: "none",
  });
});

test("malformed latest metadata does not fall back to the display name", () => {
  const malformed = [
    { version: 2, workstream: "wrong-version" },
    { version: 1, workstream: "" },
    { version: 1, workstream: 42 },
    null,
  ];

  for (const data of malformed) {
    assert.deepEqual(
      resolveSessionProject(session([projectEntry(data)], "pi-setup-deadbeef")),
      { workstream: undefined, source: "malformed-explicit" },
    );
  }
});

test("the latest explicit scope entry wins", () => {
  const entries = [
    projectEntry({ version: 1, workstream: "first" }),
    { type: "message", customType: "jp-project-scope", data: null },
    projectEntry({ version: 1, workstream: null }),
  ];

  assert.deepEqual(resolveSessionProject(session(entries, "legacy")), {
    workstream: undefined,
    source: "explicit",
  });

  entries.push(projectEntry({ version: 1, workstream: "last" }));
  assert.deepEqual(resolveSessionProject(session(entries, "legacy")), {
    workstream: "last",
    source: "explicit",
  });
});

test("persists project and global entries with the versioned payload", () => {
  const manager = session();

  persistSessionProject(manager, "pi-setup");
  persistSessionProject(manager, null);

  assert.deepEqual(manager.appended, [
    {
      customType: "jp-project-scope",
      data: { version: 1, workstream: "pi-setup" },
    },
    {
      customType: "jp-project-scope",
      data: { version: 1, workstream: null },
    },
  ]);
});

test("generates a stable eight-character suffix from the session ID", () => {
  const manager = {
    getSessionId: () => "019ff29e-4652-7c2d-90c5-bdf1580c8e67",
  };

  assert.equal(
    generateSessionProjectName(manager, "pi-setup"),
    "pi-setup-580c8e67",
  );
  assert.equal(
    generateSessionProjectName(manager, "pi-setup"),
    "pi-setup-580c8e67",
  );
});

test("uses short and non-hyphen session IDs without a dangling separator", () => {
  assert.equal(
    generateSessionProjectName({ getSessionId: () => "AB.cd-12" }, "core"),
    "core-abcd12",
  );
  assert.equal(
    generateSessionProjectName({ getSessionId: () => "---" }, "core"),
    "core",
  );
});

test("catalog scopes resolve v2 entries, legacy aliases and fresh global sessions", () => {
  const catalog = catalogFixture();
  catalog.projects[P].aliases = ["old-api"];
  for (const scope of [
    { kind: "global" as const },
    { kind: "area" as const, areaId: A },
    { kind: "project" as const, projectId: P },
  ]) {
    assert.deepEqual(
      resolveSessionWorkScope(
        session([projectEntry({ version: 2, scope })], "wrong name"),
        catalog,
      ),
      { kind: "resolved", scope, source: "explicit" },
    );
    const writer = session();
    persistSessionWorkScope(writer, scope);
    assert.deepEqual(writer.appended, [
      { customType: "jp-project-scope", data: { version: 2, scope } },
    ]);
  }
  const legacy = resolveSessionWorkScope(
    session([projectEntry({ version: 1, workstream: "OLD-API" })]),
    catalog,
  );
  assert.deepEqual(legacy, {
    kind: "resolved",
    scope: { kind: "project", projectId: P },
    source: "explicit",
  });
  assert.deepEqual(resolveSessionWorkScope(session(), catalog), {
    kind: "resolved",
    scope: { kind: "global" },
    source: "none",
  });
});
test("catalog scope never falls back from malformed or unknown references", () => {
  const catalog = catalogFixture();
  for (const data of [
    null,
    { version: 2, scope: { kind: "project", projectId: NEW } },
    { version: 2, scope: { kind: "area", areaId: NEW } },
    { version: 2, scope: { kind: "global", extra: true } },
    { version: 1, workstream: "unknown" },
  ]) {
    assert.equal(
      resolveSessionWorkScope(session([projectEntry(data)], "API"), catalog)
        .kind,
      "invalid",
    );
  }
  assert.equal(
    resolveSessionWorkScope(session([], "API-12345678"), catalog).kind,
    "invalid",
  );
});
test("scope selection remains session-wide across conversation navigation", () => {
  const previous = projectEntry({
    version: 2,
    scope: { kind: "project", projectId: P },
  });
  const selected = projectEntry({
    version: 2,
    scope: { kind: "area", areaId: A },
  });
  const manager = {
    ...session([previous, selected]),
    getBranch: () => [previous],
  };
  assert.deepEqual(resolveSessionWorkScope(manager, catalogFixture()), {
    kind: "resolved",
    scope: { kind: "area", areaId: A },
    source: "explicit",
  });
});
