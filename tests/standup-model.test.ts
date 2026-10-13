import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeScope,
  parseReport,
  parseStart,
  selectWindow,
  serializeReport,
} from "../skills/standup/model.mjs";
import type { Report } from "../skills/standup/model.mjs";

export function report(): Report {
  return {
    meta: {
      version: 1,
      id: "11111111-1111-4111-8111-111111111111",
      previousId: null,
      revisesId: null,
      window: {
        start: "2026-10-08T14:00:00.000Z",
        end: "2026-10-09T14:00:00.000Z",
      },
      scope: {
        beadsDir: "/example/beads",
        sessionsRoot: "/example/sessions",
        github: [{ host: "github.com", login: "example", owners: [] }],
      },
      generatedAt: "2026-10-09T14:05:00.000Z",
      coverage: ["beads", "github", "sessions"].map((source) => ({
        source: source as "beads" | "github" | "sessions",
        status: "complete",
        checked: ["fixture scope"],
        limitations: [],
      })),
    },
    body: "## Progress\n\nNo new progress.\n",
  };
}

test("first start is required and offset timestamps normalize to UTC", () => {
  assert.throws(
    () => selectWindow(null, { now: "2026-10-13T14:00:00.000Z", mode: "next" }),
    /start|since/i,
  );
  assert.equal(
    parseStart("2026-10-12T09:00:00-04:00"),
    "2026-10-12T13:00:00.000Z",
  );
});

test("dates resolve to local midnight across DST without assuming 24h", () => {
  const script = `import {parseStart} from ${JSON.stringify(new URL("../skills/standup/model.mjs", import.meta.url).href)}; console.log(JSON.stringify([parseStart('2026-03-08'), parseStart('2026-03-09')]));`;
  const actual = execFileSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: "America/New_York" },
  });
  assert.deepEqual(JSON.parse(actual), [
    "2026-03-08T05:00:00.000Z",
    "2026-03-09T04:00:00.000Z",
  ]);
});

test("rejects invalid calendar dates, implicit timezones, and invalid offsets", () => {
  for (const input of [
    "2026-02-30",
    "2026-02-30T10:00:00Z",
    "2026-11-01T01:30:00",
    "2026-10-12T25:00:00Z",
    "2026-10-12T10:00:00+25:00",
    "now",
    "",
  ]) {
    assert.throws(() => parseStart(input), /date|time|start/i, input);
  }
});

test("next starts at previous end across skipped days", () => {
  assert.deepEqual(
    selectWindow(report(), { now: "2026-10-13T14:00:00.000Z", mode: "next" }),
    {
      start: "2026-10-09T14:00:00.000Z",
      end: "2026-10-13T14:00:00.000Z",
    },
  );
});

test("regeneration keeps the exact interval and requires existing history", () => {
  assert.deepEqual(
    selectWindow(report(), {
      now: "2026-10-13T14:00:00.000Z",
      mode: "regenerate",
    }),
    report().meta.window,
  );
  assert.throws(
    () =>
      selectWindow(null, {
        now: "2026-10-13T14:00:00.000Z",
        mode: "regenerate",
      }),
    /history|report/i,
  );
});

test("rejects reversed or empty intervals and attempts to override existing start", () => {
  for (const now of ["2026-10-08T14:00:00.000Z", "2026-10-09T14:00:00.000Z"]) {
    assert.throws(
      () => selectWindow(report(), { now, mode: "next" }),
      /clock|interval|end/i,
    );
  }
  assert.throws(
    () =>
      selectWindow(report(), {
        now: "2026-10-13T14:00:00.000Z",
        since: "2026-10-12",
        mode: "next",
      }),
    /since|start/i,
  );
});

test("report roundtrips and metadata cannot terminate its Markdown comment", () => {
  const value = report();
  value.meta.coverage[0].limitations = ["text --> # not report body"];
  const text = serializeReport(value);
  assert.match(text, /^<!-- standup-report:v1\n/);
  assert.deepEqual(parseReport(text), value);
  assert.equal(text.match(/-->/g)?.length, 1);
});

test("report validation rejects missing or duplicate coverage and invalid metadata", () => {
  const missing = report();
  missing.meta.coverage.pop();
  const duplicate = report();
  duplicate.meta.coverage[1] = duplicate.meta.coverage[0];
  const badId = report();
  badId.meta.id = "../../escape";
  const empty = report();
  empty.body = " ";
  const badWindow = report();
  badWindow.meta.window.end = badWindow.meta.window.start;
  for (const value of [missing, duplicate, badId, empty, badWindow]) {
    assert.throws(() => serializeReport(value));
  }
  assert.throws(() => parseReport("ordinary Markdown"));
  assert.throws(() =>
    parseReport('<!-- standup-report:v1\n{"version": 2}\n-->\ntext'),
  );
});

test("scope normalization resolves roots and ignores account and owner ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "standup-model-"));
  try {
    const a = {
      beadsDir: root,
      sessionsRoot: root,
      github: [
        { host: "GITHUB.COM", login: "Zed", owners: ["Beta", "Alpha"] },
        { host: "github.com", login: "Ann", owners: [] },
      ],
    };
    const b = {
      ...a,
      github: [
        { host: "github.com", login: "ann", owners: [] },
        { host: "github.com", login: "zed", owners: ["alpha", "beta"] },
      ],
    };
    assert.deepEqual(await normalizeScope(a), await normalizeScope(b));
    assert.notDeepEqual(
      await normalizeScope(a),
      await normalizeScope({ ...a, github: a.github.slice(1) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
