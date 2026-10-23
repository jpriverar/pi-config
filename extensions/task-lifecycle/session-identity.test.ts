import assert from "node:assert/strict";
import test from "node:test";
import type { WorkingIdentity } from "../../lib/session-identity.js";
import { resolveSessionWorkScope } from "../../lib/session-project.js";
import {
  A,
  B,
  P,
  Q,
  catalogFixture,
} from "../../lib/work-catalog/test-fixtures.js";
import {
  applySessionIdentity,
  WORKING_IDENTITY_ENTRY_TYPE,
} from "./session-identity.js";

const SESSION = "11111111-1111-4111-8111-1111580c8e67";
const assigned: WorkingIdentity = {
  kind: "assigned",
  taskId: "zz-owned",
  taskTitle: "Current work",
  projectId: P,
  projectName: "api",
  areaId: A,
  areaName: "Product",
};
function fixture() {
  let name = "manual name";
  const entries: Array<{ type: string; customType: string; data: unknown }> =
    [];
  const writes: unknown[] = [];
  const host = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
      writes.push({ customType, data });
    },
    setSessionName(value: string) {
      name = value;
      writes.push({ name: value });
    },
  };
  const session = {
    getSessionId: () => SESSION,
    getEntries: () => entries,
    getSessionName: () => name,
  };
  const browse = (scope: unknown) =>
    host.appendEntry("jp-project-scope", { version: 2, scope });
  const scope = () => resolveSessionWorkScope(session, catalogFixture());
  const apply = (
    identity: WorkingIdentity = assigned,
    options: Partial<{
      recover: boolean;
      allowBrowseReset: boolean;
      current: () => boolean;
    }> = {},
  ) =>
    applySessionIdentity(
      {
        identity,
        session,
        recover: false,
        allowBrowseReset: true,
        current: () => true,
        ...options,
      },
      host,
    );
  return { session, host, entries, writes, browse, scope, apply };
}

test("claim and relinquishment apply one project/global transition with automatic names", () => {
  const f = fixture();
  f.browse({ kind: "area", areaId: B });
  assert.deepEqual(f.apply(), { applied: true, browseChanged: true });
  assert.equal(f.session.getSessionName(), "api-580c8e67");
  assert.deepEqual(f.scope(), {
    kind: "resolved",
    scope: { kind: "project", projectId: P },
    source: "explicit",
  });
  assert.deepEqual(f.apply({ kind: "unassigned" }), {
    applied: true,
    browseChanged: true,
  });
  assert.equal(f.session.getSessionName(), "unassigned-580c8e67");
  assert.deepEqual(f.scope(), {
    kind: "resolved",
    scope: { kind: "global" },
    source: "explicit",
  });
});

test("ordinary observations preserve browsing and avoid redundant name/marker writes", () => {
  const f = fixture();
  f.apply();
  f.browse({ kind: "project", projectId: Q });
  const count = f.writes.length;
  assert.deepEqual(f.apply(), { applied: true, browseChanged: false });
  assert.equal(f.writes.length, count);
  assert.deepEqual(f.scope(), {
    kind: "resolved",
    scope: { kind: "project", projectId: Q },
    source: "explicit",
  });
});

test("manual name edits and catalog renames do not reset browsing", () => {
  const f = fixture();
  f.apply();
  f.browse({ kind: "area", areaId: B });
  f.host.setSessionName("hand edited");
  assert.equal(f.apply().browseChanged, false);
  assert.equal(f.session.getSessionName(), "api-580c8e67");
  assert.equal(
    f.apply({
      ...assigned,
      projectName: "Renamed",
      areaId: B,
      areaName: "Tooling",
    }).browseChanged,
    false,
  );
  assert.equal(f.session.getSessionName(), "Renamed-580c8e67");
  assert.deepEqual(f.scope(), {
    kind: "resolved",
    scope: { kind: "area", areaId: B },
    source: "explicit",
  });
});

test("a different task in the same project is a context transition", () => {
  const f = fixture();
  f.apply();
  f.browse({ kind: "project", projectId: Q });
  assert.equal(f.apply({ ...assigned, taskId: "zz-next" }).browseChanged, true);
});

test("explicit startup/resume recovery resets browsing once, unlike later observations", () => {
  const f = fixture();
  f.apply();
  f.browse({ kind: "project", projectId: Q });
  assert.equal(f.apply(assigned, { recover: true }).browseChanged, true);
  f.browse({ kind: "project", projectId: Q });
  assert.equal(f.apply().browseChanged, false);
});

test("newer explicit browsing consumes a transition without later reverting that choice", () => {
  const f = fixture();
  f.browse({ kind: "project", projectId: Q });
  assert.equal(
    f.apply(assigned, { allowBrowseReset: false }).browseChanged,
    false,
  );
  assert.equal(f.session.getSessionName(), "api-580c8e67");
  assert.equal(f.apply().browseChanged, false);
  assert.deepEqual(f.scope(), {
    kind: "resolved",
    scope: { kind: "project", projectId: Q },
    source: "explicit",
  });
});

test("foreign or invalid markers cannot suppress authoritative recovery", () => {
  for (const patch of [
    { sessionId: "parent-session" },
    { version: 99 },
    { projectId: null },
  ]) {
    const f = fixture();
    f.host.appendEntry(WORKING_IDENTITY_ENTRY_TYPE, {
      version: 1,
      sessionId: SESSION,
      taskId: "zz-owned",
      projectId: P,
      ...patch,
    });
    f.browse({ kind: "project", projectId: Q });
    assert.equal(f.apply().browseChanged, true);
  }
});

test("markers contain only session binding and transition keys, never display or mission data", () => {
  const f = fixture();
  f.apply();
  assert.deepEqual(
    f.entries
      .filter((e) => e.customType === WORKING_IDENTITY_ENTRY_TYPE)
      .map((e) => e.data),
    [
      {
        version: 1,
        sessionId: SESSION,
        taskId: "zz-owned",
        projectId: P,
      },
    ],
  );
  f.apply({ kind: "unassigned" });
  assert.deepEqual(f.entries.at(-1)?.data, {
    version: 1,
    sessionId: SESSION,
    taskId: null,
    projectId: null,
  });
});

test("stale and unavailable observations never clear or rename the session", () => {
  const f = fixture();
  assert.deepEqual(f.apply(assigned, { current: () => false }), {
    applied: false,
    browseChanged: false,
  });
  assert.deepEqual(f.apply({ kind: "unavailable", reason: "read failed" }), {
    applied: false,
    browseChanged: false,
  });
  assert.deepEqual(f.writes, []);
  assert.equal(f.session.getSessionName(), "manual name");
});

test("freshness is checked between writes, not only before applying a projection", () => {
  const f = fixture();
  let current = true;
  const append = f.host.appendEntry;
  f.host.appendEntry = (type, data) => {
    append(type, data);
    current = false;
  };
  assert.deepEqual(f.apply(assigned, { current: () => current }), {
    applied: false,
    browseChanged: true,
  });
  assert.equal(f.writes.length, 1);
  assert.equal(f.session.getSessionName(), "manual name");
});

test("name-write failure does not cause retry to repeat a completed navigation transition", () => {
  const f = fixture();
  const setName = f.host.setSessionName;
  f.host.setSessionName = () => {
    throw new Error("name write failed");
  };
  assert.throws(() => f.apply(), /name write failed/);
  f.browse({ kind: "project", projectId: Q });
  f.host.setSessionName = setName;
  assert.equal(f.apply().browseChanged, false);
  assert.equal(f.session.getSessionName(), "api-580c8e67");
  assert.deepEqual(f.scope(), {
    kind: "resolved",
    scope: { kind: "project", projectId: Q },
    source: "explicit",
  });
});
