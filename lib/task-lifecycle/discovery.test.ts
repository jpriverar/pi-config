import assert from "node:assert/strict";
import test from "node:test";
import { createBeadsClient } from "../beads.js";
import {
  readOwnedTaskContext,
  readSessionFacts,
} from "../../extensions/task-lifecycle/task-context.js";
import { fixture, session } from "./v2-service-test-fixtures.js";
import { readLifecycleV2MigrationSnapshot } from "./v2-migration.js";
import { state, OWNER, resource } from "./v2-test-fixtures.js";

const hiddenKinds = [
  { issue_type: "gate" },
  { issue_type: "agent" },
  { issue_type: "role" },
  { issue_type: "message" },
  { is_template: true },
  { ephemeral: true },
];
for (const hidden of hiddenKinds) {
  test(`ownership discovery includes normally hidden native records ${JSON.stringify(hidden)}`, async (t) => {
    const h = await fixture(t, [
      { id: "jp-held", lifecycle: state({ phase: "active", owner: OWNER }) },
      { id: "jp-next", lifecycle: state() },
    ]);
    Object.assign(h.records.get("jp-held")!, hidden);
    assert.deepEqual(
      (await h.sut.ownedTasksForSession(OWNER.sessionId)).map((row) => row.id),
      ["jp-held"],
    );
    await assert.rejects(
      h.sut.claim("jp-next", session(), "second-claim"),
      /already owns/,
    );
    assert.deepEqual(h.writes, []);
  });
}

test("complete discovery refuses an unsupported native status rather than losing its owner", async (t) => {
  const h = await fixture(t, [
    { id: "jp-held", lifecycle: state({ phase: "active", owner: OWNER }) },
  ]);
  Object.assign(h.records.get("jp-held")!, {
    status: "hooked",
    issue_type: "gate",
  });
  await assert.rejects(
    h.sut.ownedTasksForSession(OWNER.sessionId),
    /invalid|status|unsupported/,
  );
});

test("hidden invalid metadata cannot be interpreted as an unassociated resource", async (t) => {
  const h = await fixture(t, [
    { id: "jp-held", lifecycle: state({ phase: "active", owner: OWNER }) },
  ]);
  const row = h.records.get("jp-held")!;
  row.issue_type = "gate";
  row.metadata.piLifecycle = { version: 99 };
  await assert.rejects(
    h.sut.associatedTasksForClaim("claim-1"),
    /invalid|unsupported|unavailable/,
  );
});

test("resource association and migration snapshots include hidden owned tasks", async (t) => {
  const h = await fixture(t, [
    {
      id: "jp-held",
      lifecycle: state({
        phase: "active",
        owner: OWNER,
        resources: [resource()],
      }),
    },
  ]);
  h.records.get("jp-held")!.issue_type = "gate";
  assert.deepEqual(
    (await h.sut.associatedTasksForClaim("claim-1")).map((row) => row.id),
    ["jp-held"],
  );
  assert.deepEqual(
    (await readLifecycleV2MigrationSnapshot(h.store)).map((row) => row.id),
    ["jp-held"],
  );
});

test("claim readiness is not truncated by the native default result limit", async (t) => {
  const h = await fixture(
    t,
    Array.from({ length: 101 }, (_, i) => ({
      id: `jp-${i}`,
      lifecycle: state(),
    })),
  );
  const claimed = await h.sut.claim("jp-100", session(), "claim-last");
  assert.equal(claimed.lifecycle?.phase, "active");
});

test("complete client reads retain hidden ownership without changing normal browse visibility", async () => {
  const calls: string[][] = [];
  const hidden = {
    id: "jp-held",
    title: "Hidden owned task",
    labels: [],
    status: "in_progress",
    metadata: { piLifecycle: state({ phase: "active", owner: OWNER }) },
  };
  const visible = {
    id: "jp-visible",
    title: "Visible",
    labels: [],
    status: "open",
    metadata: {},
  };
  const client = createBeadsClient(
    async (_command, args) => {
      calls.push([...args]);
      const complete = [
        "--all",
        "--include-gates",
        "--include-infra",
        "--include-templates",
        "--include-ephemeral",
      ].every((flag) => args.includes(flag));
      return {
        code: 0,
        stdout: JSON.stringify(complete ? [hidden, visible] : [visible]),
        stderr: "",
      };
    },
    { env: { BEADS_DIR: "/tmp/discovery-fixture" } },
  );
  const facts = await readSessionFacts(client, async () => null);
  assert.equal(facts.kind, "available");
  if (facts.kind !== "available") throw new Error("missing facts");
  assert.equal(facts.issues.length, 2);
  const context = await readOwnedTaskContext(client, {
    getSessionId: () => OWNER.sessionId,
    getEntries: () => [],
    getSessionName: () => undefined,
  });
  assert.equal(context.kind, "available");
  if (context.kind === "available")
    assert.equal(context.value.taskId, "jp-held");
  const normal = await client.listIssues();
  assert.equal(normal.ok, true);
  if (normal.ok)
    assert.deepEqual(
      normal.value.map((row) => row.id),
      ["jp-visible"],
    );
  assert.equal(calls.at(-1)!.includes("--include-gates"), false);
});

test("complete-read failures remain unavailable without a narrower fallback", async () => {
  const calls: string[][] = [];
  const client = createBeadsClient(
    async (_command, args) => {
      calls.push([...args]);
      return args.includes("--all")
        ? {
            code: 2,
            stdout: "",
            stderr: "complete read unsupported or exceeds native bound",
          }
        : { code: 0, stdout: "[]", stderr: "" };
    },
    { env: { BEADS_DIR: "/tmp/discovery-fixture" } },
  );
  assert.equal(
    (await readSessionFacts(client, async () => null)).kind,
    "unavailable",
  );
  assert.equal(calls.length, 1);
});

test("browse readiness requests an unlimited result set", async () => {
  const client = createBeadsClient(
    async (_command, args) => ({
      code: 0,
      stdout: JSON.stringify(
        Array.from(
          {
            length:
              args.includes("-n") && args[args.indexOf("-n") + 1] === "0"
                ? 101
                : 100,
          },
          (_, i) => ({
            id: `jp-${i}`,
            title: "Ready",
            status: "open",
            labels: [],
          }),
        ),
      ),
      stderr: "",
    }),
    { env: { BEADS_DIR: "/tmp/discovery-fixture" } },
  );
  const ready = await client.listReadyIssueIds();
  assert.equal(ready.ok, true);
  if (ready.ok) assert.equal(ready.value.has("jp-100"), true);
});
