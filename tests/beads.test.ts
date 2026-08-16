import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReadiness,
  createBeadsClient,
  resolveBeadsDir,
  type BeadsExec,
  type BeadsExecResult,
  type BeadsIssue,
} from "../lib/beads.js";

const store = "/tmp/personal/.beads";

function fakeExec(...results: BeadsExecResult[]): {
  exec: BeadsExec;
  calls: Array<{ command: string; args: readonly string[] }>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let next = 0;

  return {
    calls,
    exec: async (command, args) => {
      calls.push({ command, args });
      const result = results[next++];
      assert.ok(result, `missing fake result for call ${next}`);
      return result;
    },
  };
}

function success(value: unknown): BeadsExecResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function issue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "jp-1",
    title: "First issue",
    status: "open",
    labels: ["workstream:core"],
    ...overrides,
  };
}

test("resolves the Beads store from BEADS_DIR before the home fallback", () => {
  assert.equal(resolveBeadsDir({ BEADS_DIR: store }, "/Users/jp"), store);
  assert.equal(resolveBeadsDir({}, "/Users/jp"), "/Users/jp/beads/.beads");
  assert.equal(
    resolveBeadsDir({ BEADS_DIR: "" }, "/Users/jp"),
    "/Users/jp/beads/.beads",
  );
});

test("lists active issues by default and decodes normalized fields", async () => {
  const fake = fakeExec(
    success([issue({ labels: undefined, updated_at: "2026-08-16T12:00:00Z" })]),
  );
  const client = createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
    home: "/ignored",
  });

  const result = await client.listIssues();

  assert.deepEqual(fake.calls, [
    {
      command: "bd",
      args: [
        "list",
        "-s",
        "open,in_progress,blocked",
        "-n",
        "0",
        "--json",
        "--db",
        store,
      ],
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    value: [
      {
        id: "jp-1",
        title: "First issue",
        status: "open",
        labels: [],
        updatedAt: "2026-08-16T12:00:00Z",
      },
    ],
  });
});

test("lists explicitly requested issue statuses", async () => {
  const fake = fakeExec(success([]));
  const client = createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  });

  const result = await client.listIssues(["closed"]);

  assert.deepEqual(fake.calls[0], {
    command: "bd",
    args: ["list", "-s", "closed", "-n", "0", "--json", "--db", store],
  });
  assert.deepEqual(result, { ok: true, value: [] });
});

test("lists ready issue IDs in source order", async () => {
  const fake = fakeExec(
    success([
      issue({ id: "jp-3" }),
      issue({ id: "jp-1" }),
      issue({ id: "jp-2" }),
    ]),
  );
  const client = createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  });

  const result = await client.listReadyIssueIds();

  assert.deepEqual(fake.calls, [
    {
      command: "bd",
      args: ["ready", "--json", "--db", store],
    },
  ]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual([...result.value], ["jp-3", "jp-1", "jp-2"]);
  }
});

test("accepts an empty ready result", async () => {
  const fake = fakeExec(success([]));
  const result = await createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  }).listReadyIssueIds();

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual([...result.value], []);
  }
});

test("rejects malformed ready records", async () => {
  const fake = fakeExec(success([{ id: "jp-1" }]));
  const result = await createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  }).listReadyIssueIds();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.operation, "list ready issues");
    assert.equal(result.error.store, store);
    assert.match(result.error.message, /title/);
  }
});

test("returns contextual failures for a missing ready CLI", async () => {
  const missingCli: BeadsExec = async () => {
    const error = new Error("spawn bd ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };
  const result = await createBeadsClient(missingCli, {
    env: { BEADS_DIR: store },
  }).listReadyIssueIds();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.operation, "list ready issues");
    assert.equal(result.error.store, store);
    assert.match(result.error.message, /ENOENT/);
  }
});

test("returns contextual failures for a non-zero ready exit", async () => {
  const fake = fakeExec({ code: 1, stdout: "", stderr: "store unavailable" });
  const result = await createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  }).listReadyIssueIds();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.operation, "list ready issues");
    assert.equal(result.error.store, store);
    assert.match(result.error.message, /store unavailable/);
  }
});

test("turns list decoding and command failures into BeadsResult errors", async (t) => {
  const cases: Array<{
    name: string;
    result: BeadsExecResult;
    message: RegExp;
  }> = [
    {
      name: "malformed JSON",
      result: { code: 0, stdout: "not json", stderr: "" },
      message: /JSON/,
    },
    {
      name: "unsupported status",
      result: success([issue({ status: "unknown" })]),
      message: /status/,
    },
    {
      name: "missing title",
      result: success([issue({ title: undefined })]),
      message: /title/,
    },
    {
      name: "non-zero exit",
      result: { code: 2, stdout: "", stderr: "database missing" },
      message: /database missing/,
    },
    {
      name: "missing-binary-shaped result",
      result: { code: 127, stdout: "", stderr: "bd: command not found" },
      message: /command not found/,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fake = fakeExec(testCase.result);
      const result = await createBeadsClient(fake.exec, {
        env: { BEADS_DIR: store },
      }).listIssues();

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.operation, "list issues");
        assert.equal(result.error.store, store);
        assert.match(result.error.message, testCase.message);
      }
    });
  }
});

test("classifies readiness and derives labels once in source order", () => {
  const issues: BeadsIssue[] = [
    {
      id: "doing",
      title: "Doing",
      status: "in_progress",
      labels: ["workstream:first", "needs:jp", "workstream:second"],
    },
    {
      id: "blocked",
      title: "Blocked",
      status: "blocked",
      labels: [],
    },
    {
      id: "ready",
      title: "Ready",
      status: "open",
      labels: ["workstream:core"],
    },
    {
      id: "waiting",
      title: "Waiting",
      status: "open",
      labels: ["other"],
    },
  ];

  assert.deepEqual(classifyReadiness(issues, new Set(["ready"])), [
    {
      ...issues[0],
      readiness: "in_progress",
      workstreams: ["first", "second"],
      needsJp: true,
    },
    {
      ...issues[1],
      readiness: "blocked",
      workstreams: [],
      needsJp: false,
    },
    {
      ...issues[2],
      readiness: "ready",
      workstreams: ["core"],
      needsJp: false,
    },
    {
      ...issues[3],
      readiness: "waiting",
      workstreams: [],
      needsJp: false,
    },
  ]);
});
