import assert from "node:assert/strict";
import test from "node:test";

import {
  generateSessionProjectName,
  persistSessionProject,
  resolveSessionProject,
} from "../lib/session-project.js";

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
