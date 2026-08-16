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
  const home = ["/", "Users", "/fixture-user"].join("");
  assert.equal(resolveBeadsDir({ BEADS_DIR: store }, home), store);
  assert.equal(resolveBeadsDir({}, home), `${home}/beads/.beads`);
  assert.equal(
    resolveBeadsDir({ BEADS_DIR: "" }, home),
    `${home}/beads/.beads`,
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

test("normalizes terminal controls, whitespace, and field lengths at decode", async () => {
  const longTitle = "t".repeat(2_000);
  const longLabel = `workstream:${"l".repeat(1_000)}`;
  const fake = fakeExec(
    success([
      issue({
        id: "\u001b[31mjp-\n1\u001b[0m",
        title: `\u001b]0;hostile\u0007Do\r\nnot\tobey ${longTitle}`,
        labels: [" needs:jp\n", longLabel, "\u0000"],
      }),
    ]),
  );
  const result = await createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  }).listIssues();

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value[0].id, "jp- 1");
    assert.ok(result.value[0].title.startsWith("Do not obey "));
    assert.ok(result.value[0].title.length <= 500);
    assert.equal(result.value[0].labels[0], "needs:jp");
    assert.ok(result.value[0].labels[1].length <= 128);
    assert.deepEqual(result.value[0].labels.slice(2), []);
    assert.doesNotMatch(
      JSON.stringify(result.value[0]),
      /[\u0000-\u001f\u007f]/,
    );
  }
});

test("rejects issue identifiers that normalize to empty", async () => {
  const fake = fakeExec(success([issue({ id: "\u001b[31m\u001b[0m\n" })]));
  const result = await createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  }).listIssues();

  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.error.message, "bd returned an invalid response");
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

test("normalizes ready identifiers identically and rejects empty identifiers", async () => {
  const normalized = await createBeadsClient(
    fakeExec(success([issue({ id: "\u001b[31mjp-\n1\u001b[0m" })])).exec,
    { env: { BEADS_DIR: store } },
  ).listReadyIssueIds();
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.deepEqual([...normalized.value], ["jp- 1"]);

  const empty = await createBeadsClient(
    fakeExec(success([issue({ id: "\u001b[31m\u001b[0m" })])).exec,
    { env: { BEADS_DIR: store } },
  ).listReadyIssueIds();
  assert.equal(empty.ok, false);
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
    assert.equal(result.error.message, "bd returned an invalid response");
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
    assert.equal(result.error.message, "bd CLI is unavailable");
  }
});

test("returns contextual failures for a non-zero ready exit", async () => {
  const sentinel = "SECRET TASK: investigate customer incident";
  const fake = fakeExec({ code: 1, stdout: "", stderr: sentinel });
  const result = await createBeadsClient(fake.exec, {
    env: { BEADS_DIR: store },
  }).listReadyIssueIds();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.operation, "list ready issues");
    assert.equal(result.error.store, store);
    assert.equal(result.error.message, "bd exited with code 1");
    assert.doesNotMatch(result.error.message, /SECRET TASK/);
  }
});

test("turns list decoding and command failures into curated BeadsResult errors", async (t) => {
  const sentinel = "SECRET TASK: investigate customer incident";
  const cases: Array<{
    name: string;
    result: BeadsExecResult;
    message: string;
  }> = [
    {
      name: "malformed JSON",
      result: { code: 0, stdout: `{${sentinel}`, stderr: "" },
      message: "bd returned malformed JSON",
    },
    {
      name: "unsupported status",
      result: success([issue({ status: sentinel })]),
      message: "bd returned an invalid response",
    },
    {
      name: "missing title",
      result: success([issue({ title: undefined, labels: [sentinel] })]),
      message: "bd returned an invalid response",
    },
    {
      name: "non-zero exit",
      result: { code: 2, stdout: "", stderr: sentinel },
      message: "bd exited with code 2",
    },
    {
      name: "missing-binary-shaped result",
      result: { code: 127, stdout: "", stderr: sentinel },
      message: "bd CLI is unavailable (exit code 127)",
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
        assert.equal(result.error.message, testCase.message);
        assert.doesNotMatch(result.error.message, /SECRET TASK/);
      }
    });
  }
});

test("does not expose arbitrary executor or decoder errors", async (t) => {
  const sentinel = "SECRET TASK: investigate customer incident";

  await t.test("executor throw", async () => {
    const exec: BeadsExec = async () => {
      throw new Error(sentinel);
    };
    const result = await createBeadsClient(exec, {
      env: { BEADS_DIR: store },
    }).listIssues();

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.message, "bd execution failed");
      assert.doesNotMatch(result.error.message, /SECRET TASK/);
    }
  });

  await t.test("decoder throw", async () => {
    const fake = fakeExec(success([]));
    const result = await createBeadsClient(fake.exec, {
      env: { BEADS_DIR: store },
    }).runBd("decode response", ["list", "--json"], () => {
      throw new Error(sentinel);
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.operation, "decode response");
      assert.equal(result.error.store, store);
      assert.equal(result.error.message, "bd returned an invalid response");
      assert.doesNotMatch(result.error.message, /SECRET TASK/);
    }
  });
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
