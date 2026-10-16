import assert from "node:assert/strict";
import { test } from "node:test";
import { observeDatadogOperation } from "./recovery.js";
import type { DatadogOperationRequest, DatadogRuntime } from "./datadog.js";
import { target } from "./test-fixtures.js";

const reference =
  "Pi sync: v1/8dee7c38-00cb-11ea-a77b-8b5a08d3b091/e555e290-ed65-49bd-ae18-8acbfcf18db7/jp-test";
const description = `why\n\nLocal task: jp-test\n\n${reference}/case`;
const message = `progress\n\n2026-10-07T12:00:00Z\n\n${reference}/comment/c1`;
const createRequest: DatadogOperationRequest = {
  target,
  taskId: "jp-test",
  operation: { kind: "create" },
  initial: { title: "task", description: "why" },
};
const commentRequest: DatadogOperationRequest = {
  target,
  taskId: "jp-test",
  remoteId: "case-1",
  operation: { kind: "comment", commentId: "c1" },
  comment: {
    id: "c1",
    issueId: "jp-test",
    text: "progress\n\n[pi-task-log:v1]",
    createdAt: "2026-10-07T12:00:00Z",
  },
};
function caseRow(id = "case-1", overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "case",
    attributes: {
      key: "TEAM-1",
      title: "task",
      description,
      status_name: "In Progress",
      type_id: target.typeId,
      ...overrides,
    },
    relationships: {
      project: { data: { type: "project", id: target.projectId } },
    },
  };
}
function cell(id: string, text = message, type = "COMMENT") {
  return {
    id,
    type: "timeline_cell",
    attributes: {
      type,
      cell_content: { message: text },
      created_at: "2026-10-07T12:00:01Z",
      author: { type: "USER", content: { id: "user-1" } },
      can_reply: true,
      reply_count: 0,
    },
  };
}
function fixture(
  handler: (url: URL) => { body?: unknown; status?: number; raw?: string },
) {
  const urls: URL[] = [];
  const runtime: DatadogRuntime = {
    ddAuthPath: "/test/dd-auth",
    curlPath: "/test/curl",
    env: {},
    timeoutMs: 30_000,
    maxOutputBytes: 100_000,
    run: async (file, args, options) => {
      if (file === "/test/dd-auth")
        return {
          code: 0,
          stdout: "DD_API_KEY=test_api\nDD_APP_KEY=test_app\n",
          stderr: "",
        };
      assert.equal(file, "/test/curl");
      assert.equal(args[args.indexOf("--request") + 1], "GET");
      assert.equal(options.input, undefined);
      const url = new URL(args[args.indexOf("--url") + 1]);
      assert.equal(url.origin, "https://api.datadoghq.com");
      urls.push(url);
      const response = handler(url);
      return {
        code: 0,
        stdout: `${response.raw ?? JSON.stringify(response.body ?? {})}\n${response.status ?? 200}\n`,
        stderr: "",
      };
    },
  };
  return { runtime, urls };
}
function timelineFixture(pages: unknown[][], boundCase = caseRow()) {
  return fixture((url) =>
    url.pathname.endsWith("/timelines")
      ? {
          body: {
            data: pages[Number(url.searchParams.get("page[number]"))] ?? [],
          },
        }
      : { body: { data: boundCase } },
  );
}

test("a later-page marked comment is confirmed only after the complete timeline is checked", async () => {
  const h = timelineFixture([[cell("other", "")], [cell("delivered")], []]);
  assert.deepEqual(await observeDatadogOperation(commentRequest, h.runtime), {
    kind: "observed",
  });
  const pages = h.urls.filter((u) => u.pathname.endsWith("/timelines"));
  assert.deepEqual(
    pages.map((u) => u.searchParams.get("page[number]")),
    ["0", "1", "2"],
  );
  assert.ok(
    pages.every(
      (u) =>
        u.searchParams.get("page[size]") === "50" &&
        u.searchParams.get("sort[ascending]") === "true",
    ),
  );
});

test("unmarked legacy text, changed content, wrong native IDs, and non-comment cells are not delivery evidence", async () => {
  for (const candidate of [
    cell("old", "progress\n\n2026-10-07T12:00:00Z"),
    cell("edited", message.replace("progress", "different content")),
    cell("other-id", message.replace("/comment/c1", "/comment/c2")),
    cell("status", message, "CASE_LIFECYCLE"),
  ]) {
    const h = timelineFixture([[candidate], []]);
    assert.deepEqual(await observeDatadogOperation(commentRequest, h.runtime), {
      kind: "attention",
      code: "remote_delivery_not_found",
    });
  }
});

test("multiple matching comment cells remain ambiguous without another POST", async () => {
  const h = timelineFixture([[cell("first")], [cell("second")], []]);
  assert.deepEqual(await observeDatadogOperation(commentRequest, h.runtime), {
    kind: "attention",
    code: "multiple_remote_matches",
  });
});

test("case binding must match the captured identity, project, and type before reading its timeline", async () => {
  const wrongProject = caseRow();
  wrongProject.relationships.project.data.id =
    "11111111-1111-1111-1111-111111111111";
  for (const row of [
    caseRow("another-case"),
    wrongProject,
    caseRow("case-1", { type_id: "11111111-1111-1111-1111-111111111111" }),
  ]) {
    const h = timelineFixture([[cell("delivered")]], row);
    assert.deepEqual(await observeDatadogOperation(commentRequest, h.runtime), {
      kind: "attention",
      code: "remote_binding_mismatch",
    });
    assert.equal(h.urls.length, 1);
  }
});

test("malformed or repeated pages never confirm a partial match", async () => {
  for (const page of [
    {},
    { data: null },
    { data: [{ id: "broken" }] },
    { data: [cell("delivered")] },
  ]) {
    const h = fixture((url) => {
      if (!url.pathname.endsWith("/timelines"))
        return { body: { data: caseRow() } };
      return {
        body:
          url.searchParams.get("page[number]") === "0"
            ? { data: [cell("delivered")] }
            : page,
      };
    });
    const outcome = await observeDatadogOperation(commentRequest, h.runtime);
    assert.equal(outcome.kind, "retryable");
    assert.ok(h.urls.length <= 3);
  }
});

test("a scan cap remains visible instead of treating an unfinished timeline as complete", async () => {
  const h = fixture((url) =>
    !url.pathname.endsWith("/timelines")
      ? { body: { data: caseRow() } }
      : {
          body: {
            data: [
              cell(`page-${url.searchParams.get("page[number]")}`, "unrelated"),
            ],
          },
        },
  );
  assert.deepEqual(await observeDatadogOperation(commentRequest, h.runtime), {
    kind: "attention",
    code: "remote_scan_limit",
  });
  assert.equal(
    h.urls.filter((u) => u.pathname.endsWith("/timelines")).length,
    20,
  );
});

test("read errors cannot authorize replay or acknowledge an incomplete match", async () => {
  for (const [status, kind] of [
    [500, "retryable"],
    [429, "retryable"],
    [403, "attention"],
    [404, "attention"],
  ] as const) {
    const h = fixture(() => ({ status }));
    const outcome = await observeDatadogOperation(commentRequest, h.runtime);
    assert.equal(outcome.kind, kind);
    assert.equal(h.urls.length, 1);
  }
});

test("a uniquely marked creation binds the existing case and observed status", async () => {
  const h = fixture((url) => {
    assert.equal(url.pathname, "/api/v2/cases");
    assert.equal(
      url.searchParams.get("filter"),
      `project_id:${target.projectId}`,
    );
    assert.equal(url.searchParams.get("sort[field]"), "created_at");
    assert.equal(url.searchParams.get("sort[asc]"), "true");
    const page = Number(url.searchParams.get("page[number]"));
    return {
      body: {
        data:
          page === 1
            ? [
                caseRow("unrelated", {
                  description: "unrelated",
                  type_id: "another-type",
                }),
              ]
            : page === 2
              ? [
                  caseRow("case-1", {
                    title: "updated title",
                    description: `updated details\n\n${reference}/case`,
                  }),
                ]
              : [],
      },
    };
  });
  assert.deepEqual(await observeDatadogOperation(createRequest, h.runtime), {
    kind: "observed",
    statusName: "In Progress",
    remote: {
      id: "case-1",
      key: "TEAM-1",
      url: "https://app.datadoghq.com/cases/case-1",
    },
  });
  assert.equal(h.urls.length, 3);
});

test("case search honors verified one-based pagination metadata", async () => {
  const h = fixture((url) => {
    assert.equal(url.searchParams.get("page[number]"), "1");
    return {
      body: {
        data: [caseRow()],
        meta: { page: { current: 1, size: 1, total: 1 }, total_cases: 1 },
      },
    };
  });
  const result = await observeDatadogOperation(createRequest, h.runtime);
  assert.equal(result.kind, "observed");
  assert.equal(h.urls.length, 1);
});

test("an empty nonterminal case-search page cannot confirm an earlier match", async () => {
  const h = fixture((url) => {
    const page = Number(url.searchParams.get("page[number]"));
    const data =
      page === 1
        ? [
            caseRow(),
            ...Array.from({ length: 49 }, (_, i) =>
              caseRow(`unrelated-${i}`, { description: "unrelated" }),
            ),
          ]
        : [];
    return {
      body: {
        data,
        meta: { page: { current: page, size: data.length, total: 3 } },
      },
    };
  });
  assert.deepEqual(await observeDatadogOperation(createRequest, h.runtime), {
    kind: "retryable",
    code: "invalid_remote_response",
  });
  assert.equal(h.urls.length, 2);
});

for (const [firstTotal, nextTotal] of [
  [3, 2],
  [2, 3],
]) {
  test(`case-search totals changing from ${firstTotal} to ${nextTotal} cannot confirm an earlier match`, async () => {
    const h = fixture((url) => {
      const page = Number(url.searchParams.get("page[number]"));
      return {
        body: {
          data: [
            page === 1
              ? caseRow()
              : caseRow(`unrelated-${page}`, { description: "unrelated" }),
          ],
          meta: {
            page: {
              current: page,
              size: 1,
              total: page === 1 ? firstTotal : nextTotal,
            },
          },
        },
      };
    });
    assert.deepEqual(await observeDatadogOperation(createRequest, h.runtime), {
      kind: "retryable",
      code: "invalid_remote_response",
    });
    assert.equal(h.urls.length, 2);
  });
}

test("missing case-search metadata cannot discard a previously reported total", async () => {
  const h = fixture((url) => ({
    body:
      url.searchParams.get("page[number]") === "1"
        ? {
            data: [caseRow()],
            meta: { page: { current: 1, size: 1, total: 3 } },
          }
        : { data: [] },
  }));
  assert.deepEqual(await observeDatadogOperation(createRequest, h.runtime), {
    kind: "retryable",
    code: "invalid_remote_response",
  });
  assert.equal(h.urls.length, 2);
});

test("consistent case-search totals confirm a match only after the final page", async () => {
  const h = fixture((url) => {
    const page = Number(url.searchParams.get("page[number]"));
    return {
      body: {
        data: [
          page === 1
            ? caseRow()
            : caseRow("unrelated", { description: "unrelated" }),
        ],
        meta: { page: { current: page, size: 1, total: 2 } },
      },
    };
  });
  const result = await observeDatadogOperation(createRequest, h.runtime);
  assert.equal(result.kind, "observed");
  assert.equal(h.urls.length, 2);
});

test("an empty first case-search page with no remaining pages stays not found", async () => {
  for (const total of [0, 1]) {
    const h = fixture(() => ({
      body: {
        data: [],
        meta: { page: { current: 1, size: 0, total } },
      },
    }));
    assert.deepEqual(await observeDatadogOperation(createRequest, h.runtime), {
      kind: "attention",
      code: "remote_delivery_not_found",
    });
    assert.equal(h.urls.length, 1);
  }
});

test("unmarked, absent, conflicting and wrong-project creates do not bind an arbitrary case", async () => {
  const wrongProject = caseRow();
  wrongProject.relationships.project.data.id =
    "11111111-1111-1111-1111-111111111111";
  for (const [rows, code] of [
    [[], "remote_delivery_not_found"],
    [
      [caseRow("old", { description: "why\n\nLocal task: jp-test" })],
      "remote_delivery_not_found",
    ],
    [[caseRow("first"), caseRow("second")], "multiple_remote_matches"],
    [[wrongProject], "remote_binding_mismatch"],
  ] as const) {
    const h = fixture((url) => ({
      body: { data: url.searchParams.get("page[number]") === "1" ? rows : [] },
    }));
    assert.deepEqual(await observeDatadogOperation(createRequest, h.runtime), {
      kind: "attention",
      code,
    });
  }
});

test("status observation reports actual remote state rather than pretending the reserved status was applied", async () => {
  const h = fixture(() => ({
    body: { data: caseRow("case-1", { status_name: "Done" }) },
  }));
  assert.deepEqual(
    await observeDatadogOperation(
      {
        target,
        taskId: "jp-test",
        remoteId: "case-1",
        operation: { kind: "status", statusName: "In Progress" },
      },
      h.runtime,
    ),
    { kind: "observed", statusName: "Done" },
  );
  assert.equal(h.urls.length, 1);
});

test("invalid local comment identity is rejected before authentication", async () => {
  const h = timelineFixture([]);
  assert.deepEqual(
    await observeDatadogOperation(
      {
        ...commentRequest,
        comment: { ...commentRequest.comment!, id: "other" },
      },
      h.runtime,
    ),
    { kind: "attention", code: "invalid_recovery_request" },
  );
  assert.equal(h.urls.length, 0);
});
