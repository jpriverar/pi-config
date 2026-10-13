import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectSessions } from "../skills/standup/sessions.mjs";

const window = {
  start: "2026-10-12T14:00:00.000Z",
  end: "2026-10-13T14:00:00.000Z",
};
function message(
  id: string,
  text: string,
  timestamp = window.start,
  role = "assistant",
  parentId: string | null = null,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role,
      timestamp: Date.parse(timestamp),
      content: [{ type: "text", text }],
    },
  };
}
function header(version = 3) {
  return {
    type: "session",
    version,
    id: "session",
    timestamp: window.start,
    cwd: "/fixture",
  };
}
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  entries: unknown[],
) {
  const root = await mkdtemp(join(tmpdir(), "standup-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "first.jsonl");
  await writeFile(
    path,
    [header(), ...entries].map((entry) => JSON.stringify(entry)).join("\n") +
      "\n",
  );
  return { root, path };
}

test("filters by original occurrence time including start but excluding end", async (t) => {
  const { root, path } = await fixture(t, [
    message("old", "yesterday", "2026-10-11T14:00:00.000Z"),
    message("start", "investigated failure"),
    message("end", "later", window.end),
  ]);
  const before = await readFile(path, "utf8");
  const result = await collectSessions(root, window);
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(
    result.evidence.map((e) => e.text),
    ["investigated failure"],
  );
  assert.equal(result.evidence[0].occurredAt, window.start);
  assert.equal(await readFile(path, "utf8"), before);
});

test("deduplicates cloned entries but retains short-ID collisions and repeated actions", async (t) => {
  const { root, path } = await fixture(t, [
    message("same", "investigated"),
    message("repeat1", "ran tests"),
    message("repeat2", "ran tests"),
  ]);
  await writeFile(join(root, "clone.jsonl"), await readFile(path));
  await writeFile(
    join(root, "distinct.jsonl"),
    [header(), message("same", "different action")]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const result = await collectSessions(root, window);
  assert.equal(result.evidence.length, 4);
  assert.equal(
    result.evidence.find((e) => e.text === "investigated")?.refs.length,
    2,
  );
});

test("excludes private/non-evidence content while preserving unrelated text", async (t) => {
  const privateMessage = message("private", "excluded");
  const { root } = await fixture(t, [
    message("system", "system prompt", window.start, "system"),
    {
      ...message("thinking", "visible reasoning result"),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "visible result" },
        ],
      },
    },
    {
      ...privateMessage,
      message: { ...privateMessage.message, excludeFromContext: true },
    },
    {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp: window.start,
      summary: "old accomplishment",
    },
    {
      type: "branch_summary",
      id: "branch",
      parentId: null,
      timestamp: window.start,
      summary: "old branch",
    },
    message(
      "recap",
      "<!-- standup-summary:v1 -->old report<!-- /standup-summary -->\nnew investigation",
    ),
    message("token", "token=YOUR_TOKEN_HERE"),
    message("rawtool", "arbitrary raw file", window.start, "toolResult"),
    message("test", "Tests: 4 passed, 4 total", window.start, "toolResult"),
  ]);
  const result = await collectSessions(root, window);
  const text = result.evidence.map((e) => e.text).join("\n");
  assert.match(text, /visible result/);
  assert.match(text, /new investigation/);
  assert.match(text, /Tests: 4 passed/);
  for (const excluded of [
    "hidden reasoning",
    "old accomplishment",
    "old branch",
    "old report",
    "excluded",
    "system prompt",
    "YOUR_TOKEN_HERE",
    "arbitrary raw file",
  ])
    assert(!text.includes(excluded), excluded);
});

test("context edits suppress original copies and retain original event time", async (t) => {
  const original = message("target", "removed original");
  const { root } = await fixture(t, [
    original,
    {
      type: "context_edit",
      id: "edit",
      parentId: "target",
      timestamp: "2026-10-13T10:00:00.000Z",
      targetId: "target",
      replacement: "safe replacement",
    },
  ]);
  await writeFile(
    join(root, "copy.jsonl"),
    [header(), original].map((entry) => JSON.stringify(entry)).join("\n") +
      "\n",
  );
  const result = await collectSessions(root, window);
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(
    result.evidence.map((e) => [e.text, e.occurredAt]),
    [["safe replacement", window.start]],
  );
});

test("null edits remove text and ambiguous branch edits are incomplete", async (t) => {
  const { root, path } = await fixture(t, [
    message("a", "do not disclose"),
    {
      type: "context_edit",
      id: "e",
      parentId: "a",
      timestamp: window.start,
      targetId: "a",
      replacement: null,
    },
  ]);
  assert.equal((await collectSessions(root, window)).evidence.length, 0);
  await writeFile(
    path,
    [
      header(),
      message("a", "do not disclose"),
      {
        type: "context_edit",
        id: "e1",
        parentId: "a",
        timestamp: window.start,
        targetId: "a",
        replacement: "one branch",
      },
      {
        type: "context_edit",
        id: "e2",
        parentId: "a",
        timestamp: window.start,
        targetId: "a",
        replacement: "other branch",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const result = await collectSessions(root, window);
  assert.equal(result.coverage.status, "incomplete");
  assert.equal(result.evidence.length, 0);
});

test("malformed, truncated, unsupported, and cyclic input never silently completes", async (t) => {
  const { root, path } = await fixture(t, []);
  for (const text of [
    JSON.stringify(header()) + "\nnot json\n",
    JSON.stringify(header()) + '\n{"type":"message"',
    [header(99), message("a", "work")]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    [header(), message("a", "cycle", window.start, "assistant", "a")]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    [
      header(),
      message("a", "missing parent", window.start, "assistant", "missing"),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  ]) {
    await writeFile(path, text);
    assert.equal(
      (await collectSessions(root, window)).coverage.status,
      "incomplete",
    );
  }
});

test("missing or unsafe sources are incomplete and not followed", async (t) => {
  const { root } = await fixture(t, []);
  assert.equal(
    (await collectSessions(join(root, "missing"), window)).coverage.status,
    "incomplete",
  );
  await symlink("/not/a/real/source", join(root, "linked.jsonl"));
  assert.equal(
    (await collectSessions(root, window)).coverage.status,
    "incomplete",
  );
});

test("each collection budget surfaces incomplete coverage", async (t) => {
  const { root } = await fixture(t, [message("a", "long enough text")]);
  for (const limits of [
    { maxFiles: 0, maxBytes: 10000, maxEvidenceBytes: 10000 },
    { maxFiles: 100, maxBytes: 1, maxEvidenceBytes: 10000 },
    { maxFiles: 100, maxBytes: 10000, maxEvidenceBytes: 1 },
  ]) {
    const result = await collectSessions(root, window, limits);
    assert.equal(result.coverage.status, "incomplete");
    assert.match(result.coverage.limitations.join(" "), /limit|budget/i);
  }
});

test("session CLI emits only selected evidence and explicit coverage", async (t) => {
  const { root } = await fixture(t, [message("a", "investigated tests")]);
  const request = join(root, "request.json");
  await writeFile(
    request,
    JSON.stringify({ window, scope: { sessionsRoot: root } }),
  );
  const cli = fileURLToPath(
    new URL("../skills/standup/standup.mjs", import.meta.url),
  );
  const result = JSON.parse(
    execFileSync("node", [cli, "sessions", "--request", request], {
      encoding: "utf8",
      cwd: root,
    }),
  );
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(
    result.evidence.map((e: { text: string }) => e.text),
    ["investigated tests"],
  );
});

test("incomplete scans withhold candidate text when unseen edits could retract copies", async (t) => {
  const { root } = await fixture(t, [
    message("copied", "potentially retracted text"),
  ]);
  await writeFile(
    join(root, "unreadable-edits.jsonl"),
    JSON.stringify(header()) + '\n{"type":"context_edit"',
  );
  const result = await collectSessions(root, window);
  assert.equal(result.coverage.status, "incomplete");
  assert.deepEqual(result.evidence, []);
});

test("malformed session metadata is not echoed into coverage diagnostics", async (t) => {
  const { root, path } = await fixture(t, []);
  for (const entry of [
    { ...message("a", "safe"), timestamp: "YOUR_TOKEN_HERE" },
    { ...message("a", "safe"), type: "YOUR_TOKEN_HERE" },
  ]) {
    await writeFile(
      path,
      [header(), entry].map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
    const result = await collectSessions(root, window);
    assert.equal(result.coverage.status, "incomplete");
    assert(!JSON.stringify(result).includes("YOUR_TOKEN_HERE"));
  }
});

test("metadata discovery skips inactive archives before reading or charging byte budget", async (t) => {
  const start = new Date(Date.now() + 60_000).toISOString();
  const end = new Date(Date.parse(start) + 60_000).toISOString();
  const { root, path } = await fixture(t, [
    message("recent", "recent investigation", start),
  ]);
  const { utimes } = await import("node:fs/promises");
  await writeFile(
    join(root, "old-archive.jsonl"),
    "invalid old archive".repeat(10_000),
  );
  await utimes(path, new Date(end), new Date(end));
  const result = await collectSessions(
    root,
    { start, end },
    { maxFiles: 1, maxBytes: 4096, maxEvidenceBytes: 4096 },
  );
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(
    result.evidence.map((item) => item.text),
    ["recent investigation"],
  );
  assert.match(result.coverage.checked.join(" "), /metadata/);
});

test("candidate discovery includes activity after end and copies with preserved modification times", async (t) => {
  const start = new Date(Date.now() - 60_000).toISOString();
  const end = new Date(Date.now() - 30_000).toISOString();
  const { root, path } = await fixture(t, [
    message("copied", "in-window evidence", start),
  ]);
  const { utimes } = await import("node:fs/promises");
  await utimes(path, new Date(0), new Date(0));
  const result = await collectSessions(root, { start, end });
  assert.equal(result.coverage.status, "complete");
  assert.deepEqual(
    result.evidence.map((item) => item.text),
    ["in-window evidence"],
  );
});
