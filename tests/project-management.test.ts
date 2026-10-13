import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBeadsClient,
  type BeadsExec,
  type BeadsIssue,
} from "../lib/beads.js";
import {
  decodeProjectArchiveRegistry,
  encodeProjectArchiveRegistry,
} from "../lib/project-archives.js";
import {
  collectProjects,
  createProjectManager,
  isProjectHidden,
} from "../lib/project-management.js";

const issue = (
  id: string,
  status: BeadsIssue["status"],
  ...names: string[]
): BeadsIssue => ({
  id,
  title: id,
  status,
  labels: names.map((name) => `workstream:${name}`),
});

test("project membership includes secondary labels without counting variants twice", () => {
  const projects = collectProjects([
    issue("one", "closed", "Alpha", "alpha"),
    issue("two", "deferred", "Beta", "ALPHA"),
  ]);
  assert.deepEqual(
    projects.map((project) => [
      project.name,
      project.issues.map((issue) => issue.id),
    ]),
    [
      ["Alpha", ["one", "two"]],
      ["Beta", ["two"]],
    ],
  );
  assert.equal(
    isProjectHidden(projects[0], { version: 1, archived: ["alpha"] }),
    false,
  );
});

test("archive codec accepts missing data and normalizes valid registries", () => {
  assert.deepEqual(decodeProjectArchiveRegistry(""), {
    version: 1,
    archived: [],
  });
  assert.deepEqual(decodeProjectArchiveRegistry(undefined), {
    version: 1,
    archived: [],
  });
  assert.equal(
    encodeProjectArchiveRegistry({
      version: 1,
      archived: ["zulu", "alpha", "alpha"],
    }),
    '{"version":1,"archived":["alpha","zulu"]}',
  );
});

for (const invalid of [
  "{",
  "null",
  "[]",
  '{"version":2,"archived":[]}',
  '{"version":1,"archived":["Alpha"]}',
  '{"version":1,"archived":[""]}',
  '{"version":1,"archived":["x,y"]}',
  '{"version":1,"archived":[42]}',
]) {
  test(`archive codec rejects invalid data: ${invalid}`, () => {
    assert.throws(() => decodeProjectArchiveRegistry(invalid));
  });
}

test("concurrent project managers preserve each other's archive changes", async (t) => {
  const store = await mkdtemp(join(tmpdir(), "pi-project-management-"));
  t.after(() => rm(store, { recursive: true, force: true }));
  let value = "";
  const calls: string[][] = [];
  const exec: BeadsExec = async (_command, args) => {
    calls.push([...args]);
    assert.deepEqual(args.slice(-2), ["--db", store]);
    if (args[0] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify([
          issue("a", "closed", "Alpha"),
          issue("b", "closed", "Beta"),
        ]),
        stderr: "",
      };
    }
    assert.deepEqual(args.slice(0, 3), [
      "config",
      args[1],
      "custom.pi-project-archives",
    ]);
    if (args[1] === "get")
      return {
        code: 0,
        stdout: JSON.stringify({ key: args[2], value }),
        stderr: "",
      };
    assert.equal(args[1], "set");
    value = args[3];
    return { code: 0, stdout: "", stderr: "" };
  };
  const client = createBeadsClient(exec, { env: { BEADS_DIR: store } });
  const first = createProjectManager(client, store);
  const second = createProjectManager(client, store);
  await Promise.all([
    first.setArchived("Alpha", true),
    second.setArchived("Beta", true),
  ]);
  assert.deepEqual(JSON.parse(value), {
    version: 1,
    archived: ["alpha", "beta"],
  });
  await first.setArchived("ALPHA", false);
  assert.deepEqual(JSON.parse(value), { version: 1, archived: ["beta"] });
  assert.equal(calls.filter((args) => args[1] === "set").length, 3);
});

test("archive storage rejects invalid writes before invoking bd", async () => {
  let invoked = false;
  const client = createBeadsClient(async () => {
    invoked = true;
    throw new Error("unexpected invocation");
  });
  const result = await client.setProjectArchiveRegistry({
    version: 1,
    archived: ["Alpha"],
  });
  assert.equal(result.ok, false);
  assert.equal(invoked, false);
});
