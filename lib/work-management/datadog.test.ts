import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareDatadogOperation,
  type DatadogRuntime,
  type DatadogOperationRequest,
} from "./datadog.js";
import * as datadog from "./datadog.js";
import { target } from "./test-fixtures.js";
import type { runBoundedCommand } from "../task-reconciler/commands.js";

const authenticated = {
  code: 0,
  stdout:
    "DD_API_KEY=your_api_key_here\nDD_APP_KEY=your_secret_here\nDD_SITE=datadoghq.com\n",
  stderr: "",
};
async function sendDatadogOperation(
  request: DatadogOperationRequest,
  runtime: DatadogRuntime,
) {
  const prepared = await prepareDatadogOperation(request, runtime);
  return prepared.kind === "ready" ? prepared.send() : prepared;
}

const runtime = {
  ddAuthPath: "/test/dd-auth",
  curlPath: "/usr/bin/curl",
  env: {},
  timeoutMs: 30_000,
  maxOutputBytes: 100_000,
};
const request: DatadogOperationRequest = {
  target,
  taskId: "jp-test",
  operation: { kind: "create" },
  initial: { title: "$(private title)", description: "private description" },
};
const reply = (code: number, body: unknown = {}, retry = "") => ({
  code: 0,
  stdout: `${JSON.stringify(body)}\n${code}\n${retry}`,
  stderr: "",
});

test("create, status and comment requests preserve their exact API contract without leaking payloads into argv", async () => {
  const calls: Array<{ args: readonly string[]; input: string }> = [];
  const run: typeof runBoundedCommand = async (file, args, options) => {
    if (file === "/test/dd-auth") {
      assert.deepEqual(args, [
        "--org-uuid",
        target.orgUuid,
        "--site",
        "datadoghq.com",
        "--output",
      ]);
      assert.equal(options.input, undefined);
      return authenticated;
    }
    assert.equal(file, "/usr/bin/curl");
    assert.equal(args[0], "-q");
    assert.equal(options.env.DD_API_KEY, "your_api_key_here");
    assert.equal(options.env.DD_APP_KEY, "your_secret_here");
    assert.ok(!args.join(" ").includes("your_api_key_here"));
    assert.ok(!args.join(" ").includes("your_secret_here"));
    assert.ok(args.includes("--no-location"));
    assert.equal(args[args.indexOf("--retry") + 1], "0");
    assert.ok(args.includes("%DD_APP_KEY"));
    assert.ok(!args.join(" ").includes("private"));
    calls.push({ args, input: options.input! });
    return reply(calls.length === 1 ? 201 : 200, {
      data: { id: "case-1", attributes: { key: "TEAM-1" } },
    });
  };
  const created = await sendDatadogOperation(request, { ...runtime, run });
  assert.deepEqual(created, {
    kind: "success",
    remote: {
      id: "case-1",
      key: "TEAM-1",
      url: "https://app.datadoghq.com/cases/case-1",
    },
  });
  assert.deepEqual(JSON.parse(calls[0].input), {
    data: {
      type: "case",
      attributes: {
        title: "$(private title)",
        description:
          "private description\n\nLocal task: jp-test\n\nPi sync: v1/8dee7c38-00cb-11ea-a77b-8b5a08d3b091/e555e290-ed65-49bd-ae18-8acbfcf18db7/jp-test/case",
        type_id: target.typeId,
        priority: "NOT_DEFINED",
        status_name: "Open",
      },
      relationships: {
        project: { data: { id: target.projectId, type: "project" } },
      },
    },
  });
  await sendDatadogOperation(
    {
      target,
      taskId: "jp-test",
      remoteId: "case-1",
      operation: { kind: "status", statusName: "In Progress" },
    },
    { ...runtime, run },
  );
  assert.deepEqual(JSON.parse(calls[1].input), {
    data: { type: "case", attributes: { status_name: "In Progress" } },
  });
  await sendDatadogOperation(
    {
      target,
      taskId: "jp-test",
      remoteId: "case-1",
      operation: { kind: "comment", commentId: "c1" },
      comment: {
        id: "c1",
        issueId: "jp-test",
        text: "private progress\n\n[pi-task-log:v1]",
        createdAt: "2026-10-07T12:00:00Z",
      },
    },
    { ...runtime, run },
  );
  assert.deepEqual(JSON.parse(calls[2].input), {
    data: {
      type: "case",
      attributes: {
        comment:
          "private progress\n\n2026-10-07T12:00:00Z\n\nPi sync: v1/8dee7c38-00cb-11ea-a77b-8b5a08d3b091/e555e290-ed65-49bd-ae18-8acbfcf18db7/jp-test/comment/c1",
      },
    },
  });
});

test("identical journal text and timestamps retain distinct stable native identities", async () => {
  const bodies: string[] = [];
  for (const id of ["c1", "c1", "c2"]) {
    await sendDatadogOperation(
      {
        target,
        taskId: "jp-test",
        remoteId: "case-1",
        operation: { kind: "comment", commentId: id },
        comment: {
          id,
          issueId: "jp-test",
          text: "same progress\n\n[pi-task-log:v1]",
          createdAt: "2026-10-07T12:00:00Z",
        },
      },
      {
        ...runtime,
        run: async (file, _args, options) => {
          if (file === runtime.ddAuthPath) return authenticated;
          bodies.push(JSON.parse(options.input!).data.attributes.comment);
          return reply(200);
        },
      },
    );
  }
  assert.equal(bodies[0], bodies[1]);
  assert.notEqual(bodies[0], bodies[2]);
  assert.ok(bodies[2].endsWith("/jp-test/comment/c2"));
});

test("assignment and workstream are sent only in the create payload", async () => {
  const bodies: Array<{
    data: {
      attributes: Record<string, unknown>;
      relationships?: Record<string, unknown>;
    };
  }> = [];
  const configured = {
    ...target,
    assigneeId: "11111111-1111-1111-1111-111111111111",
    workstreamAttributeKey: "pi_workstream",
  };
  const run: typeof runBoundedCommand = async (file, _args, options) => {
    if (file === runtime.ddAuthPath) return authenticated;
    bodies.push(JSON.parse(options.input!));
    return reply(bodies.length === 1 ? 201 : 200, {
      data: { id: "case-1", attributes: { key: "TEAM-1" } },
    });
  };
  assert.equal(
    (
      await sendDatadogOperation(
        {
          ...request,
          target: configured,
          initial: { ...request.initial!, workstream: "pi-setup" },
        },
        { ...runtime, run },
      )
    ).kind,
    "success",
  );
  assert.deepEqual(bodies[0].data.relationships, {
    project: { data: { id: target.projectId, type: "project" } },
    assignee: {
      data: { id: "11111111-1111-1111-1111-111111111111", type: "user" },
    },
  });
  assert.deepEqual(bodies[0].data.attributes.custom_attributes, {
    pi_workstream: { type: "TEXT", is_multi: false, value: "pi-setup" },
  });
  await sendDatadogOperation(
    {
      target: configured,
      taskId: "jp-test",
      remoteId: "case-1",
      operation: { kind: "status", statusName: "In Progress" },
    },
    { ...runtime, run },
  );
  await sendDatadogOperation(
    {
      target: configured,
      taskId: "jp-test",
      remoteId: "case-1",
      operation: { kind: "comment", commentId: "c1" },
      comment: {
        id: "c1",
        issueId: "jp-test",
        text: "progress\n\n[pi-task-log:v1]",
        createdAt: "2026-10-07T12:00:00Z",
      },
    },
    { ...runtime, run },
  );
  assert.deepEqual(bodies.slice(1), [
    { data: { type: "case", attributes: { status_name: "In Progress" } } },
    {
      data: {
        type: "case",
        attributes: {
          comment:
            "progress\n\n2026-10-07T12:00:00Z\n\nPi sync: v1/8dee7c38-00cb-11ea-a77b-8b5a08d3b091/e555e290-ed65-49bd-ae18-8acbfcf18db7/jp-test/comment/c1",
        },
      },
    },
  ]);
});

test("create omits workstream metadata without both a field mapping and a value", async () => {
  for (const input of [
    { ...request, initial: { ...request.initial!, workstream: "pi-setup" } },
    {
      ...request,
      target: { ...target, workstreamAttributeKey: "pi_workstream" },
    },
  ]) {
    let body: { data: { attributes: Record<string, unknown> } } | undefined;
    const outcome = await sendDatadogOperation(input, {
      ...runtime,
      run: async (file, _args, options) => {
        if (file === runtime.ddAuthPath) return authenticated;
        body = JSON.parse(options.input!);
        return reply(201, { data: { id: "case-1" } });
      },
    });
    assert.equal(outcome.kind, "success");
    assert.equal(body!.data.attributes.custom_attributes, undefined);
  }
});

test("ambiguous writes are not classified as retryable", async () => {
  for (const [response, kind] of [
    [reply(429, {}, "10"), "retryable"],
    [reply(401), "rejected"],
    [reply(500), "unknown"],
    [reply(302), "rejected"],
    [reply(201, { bad: true }), "unknown"],
    [{ code: 1, stdout: "", stderr: "secret credentials" }, "unknown"],
  ] as const) {
    const result = await sendDatadogOperation(request, {
      ...runtime,
      run: async (file) =>
        file === runtime.ddAuthPath ? authenticated : response,
    });
    assert.equal(result.kind, kind);
    assert.ok(!JSON.stringify(result).includes("secret"));
    if (result.kind === "retryable") assert.equal(result.retryAfterMs, 10_000);
  }
  assert.equal(
    (
      await sendDatadogOperation(request, {
        ...runtime,
        run: async (file) => {
          if (file === runtime.ddAuthPath) return authenticated;
          throw new Error("secret timeout");
        },
      })
    ).kind,
    "unknown",
  );
  let dispatched = false;
  const result = await sendDatadogOperation(
    { ...request, target: { ...target, site: "attacker.example" } },
    {
      ...runtime,
      run: async () => {
        dispatched = true;
        return reply(201);
      },
    },
  );
  assert.equal(result.kind, "rejected");
  assert.equal(dispatched, false);
});

test("a command error without dispatch proof remains unknown", async () => {
  const { CommandExecutionError } = await import(
    "../task-reconciler/commands.js"
  );
  const outcome = await sendDatadogOperation(request, {
    ...runtime,
    run: async (file) => {
      if (file === runtime.ddAuthPath) return authenticated;
      throw new CommandExecutionError("curl", "spawn_failed");
    },
  });
  assert.equal(outcome.kind, "unknown");
});

test("real curl consumes injected variables and stdin but never follows redirects", async (t) => {
  const { createServer } = await import("node:http");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "wm-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{
    api?: string | string[];
    app?: string | string[];
    body: string;
  }> = [];
  let redirect = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        api: req.headers["dd-api-key"],
        app: req.headers["dd-application-key"],
        body,
      });
      if (redirect) {
        res.writeHead(302, { location: "/unexpected" });
        res.end("{}");
      } else {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: "case-1" } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const auth = join(root, "fake-auth");
  await writeFile(
    auth,
    `#!${process.execPath}\nif (!process.env.TEST_MISSING) process.stdout.write('DD_API_KEY=your_api_key_here\\nDD_APP_KEY=your_secret_here\\n');\n`,
    { mode: 0o700 },
  );
  await writeFile(join(root, ".curlrc"), "location\n");
  const localUrl = new URL("http://127.0.0.1/create");
  localUrl.port = String(address.port);
  const local = {
    ...runtime,
    ddAuthPath: auth,
    env: { HOME: root },
    run: (async (file, args, options) => {
      const { runBoundedCommand } = await import(
        "../task-reconciler/commands.js"
      );
      if (file === auth) return runBoundedCommand(file, args, options);
      const localArgs = [...args];
      assert.ok(
        localArgs[localArgs.indexOf("--url") + 1].startsWith(
          "https://api.datadoghq.com/",
        ),
      );
      localArgs[localArgs.indexOf("--url") + 1] = localUrl.toString();
      localArgs[localArgs.indexOf("--proto") + 1] = "=http";
      return runBoundedCommand(file, localArgs, options);
    }) satisfies typeof runBoundedCommand,
  };
  assert.equal((await sendDatadogOperation(request, local)).kind, "success");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].api, "your_api_key_here");
  assert.equal(requests[0].app, "your_secret_here");
  assert.equal(
    JSON.parse(requests[0].body).data.attributes.title,
    "$(private title)",
  );
  redirect = true;
  assert.equal((await sendDatadogOperation(request, local)).kind, "rejected");
  assert.equal(requests.length, 2);
  assert.equal(
    (
      await sendDatadogOperation(request, {
        ...local,
        env: { ...local.env, TEST_MISSING: "1" },
      })
    ).kind,
    "retryable",
  );
  assert.equal(requests.length, 2);
});

test("stock authentication failure is safe to retry without running curl or exposing output", async () => {
  let curls = 0;
  const result = await sendDatadogOperation(request, {
    ...runtime,
    run: async (file) => {
      if (file === runtime.curlPath) curls++;
      return {
        code: 1,
        stdout: "private credentials",
        stderr: "private credentials",
      };
    },
  });
  assert.deepEqual(result, {
    kind: "retryable",
    code: "authentication_required",
  });
  assert.equal(curls, 0);
});

test("preparation holds credentials privately and sends only when requested", async () => {
  let curls = 0;
  const prepared = await prepareDatadogOperation(request, {
    ...runtime,
    run: async (file) => {
      if (file === runtime.ddAuthPath) return authenticated;
      curls++;
      return reply(201, { data: { id: "case-1" } });
    },
  });
  assert.equal(curls, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), { kind: "ready" });
  assert.equal(prepared.kind, "ready");
  if (prepared.kind !== "ready") throw new Error("expected prepared sender");
  assert.equal((await prepared.send()).kind, "success");
  assert.equal(curls, 1);
});

test("partial, duplicate, and malformed credentials never reach curl", async () => {
  for (const stdout of [
    "DD_API_KEY=your_api_key_here\n",
    "DD_API_KEY=your_api_key_here\nDD_APP_KEY=\n",
    "DD_API_KEY=your_api_key_here\nDD_APP_KEY=bad value\n",
    "DD_API_KEY=your_api_key_here\nDD_APP_KEY=your_secret_here\nDD_APP_KEY=duplicate\n",
  ]) {
    let curls = 0;
    const prepared = await prepareDatadogOperation(request, {
      ...runtime,
      run: async (file) => {
        if (file === runtime.curlPath) curls++;
        return { code: 0, stdout, stderr: "" };
      },
    });
    assert.deepEqual(prepared, {
      kind: "retryable",
      code: "authentication_required",
    });
    assert.equal(curls, 0);
  }
});

test("prepared reads share authentication but stay GET-only and inside the case API", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const prepared = await datadog.prepareDatadogReader?.(target, {
    ...runtime,
    run: async (file, args, options) => {
      calls.push({ file, args });
      assert.equal(options.input, undefined);
      if (file === runtime.ddAuthPath) return authenticated;
      assert.equal(args[0], "-q");
      assert.equal(args[args.indexOf("--request") + 1], "GET");
      assert.equal(args[args.indexOf("--retry") + 1], "0");
      assert.ok(args.includes("--no-location"));
      assert.ok(!args.includes("--data-binary"));
      assert.ok(!args.join(" ").includes("your_secret_here"));
      assert.equal(options.env.DD_APP_KEY, "your_secret_here");
      return reply(200, { data: [] });
    },
  });
  assert.equal(prepared?.kind, "ready");
  if (prepared?.kind !== "ready") throw new Error("expected reader");
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)), { kind: "ready" });
  assert.deepEqual(await prepared.get("/api/v2/cases/case-1"), {
    kind: "success",
    body: { data: [] },
  });
  assert.equal(
    (await prepared.get("/api/v2/cases/case-1/timelines")).kind,
    "success",
  );
  for (const path of [
    "https://attacker.example/cases",
    "//attacker.example/cases",
    "/api/v2/users",
    "/api/v2/cases/../users",
    "/api/v2/cases/..%2fusers",
  ]) {
    assert.equal((await prepared.get(path)).kind, "rejected");
  }
  assert.equal(calls.filter((c) => c.file === runtime.ddAuthPath).length, 1);
  assert.deepEqual(
    calls
      .filter((c) => c.file === runtime.curlPath)
      .map((c) => c.args[c.args.indexOf("--url") + 1]),
    [
      "https://api.datadoghq.com/api/v2/cases/case-1",
      "https://api.datadoghq.com/api/v2/cases/case-1/timelines",
    ],
  );
});

test("read failures never become successful empty results or expose command output", async () => {
  for (const [response, expected] of [
    [
      reply(429, {}, "10"),
      { kind: "retryable", code: "rate_limited", retryAfterMs: 10_000 },
    ],
    [reply(500), { kind: "retryable", code: "http_500" }],
    [reply(403), { kind: "rejected", code: "http_403" }],
    [reply(404), { kind: "rejected", code: "http_404" }],
    [reply(302), { kind: "rejected", code: "http_302" }],
    [
      { code: 0, stdout: "broken JSON\n200\n", stderr: "secret" },
      { kind: "retryable", code: "invalid_response" },
    ],
    [
      { code: 1, stdout: "secret", stderr: "secret" },
      { kind: "retryable", code: "command_failed" },
    ],
  ] as const) {
    const prepared = await datadog.prepareDatadogReader?.(target, {
      ...runtime,
      run: async (file) =>
        file === runtime.ddAuthPath ? authenticated : response,
    });
    assert.equal(prepared?.kind, "ready");
    if (prepared?.kind !== "ready") throw new Error("expected reader");
    assert.deepEqual(await prepared.get("/api/v2/cases/case-1"), expected);
  }
});

test("one observation budget includes authentication and every page", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000 });
  const budgets: Array<number | undefined> = [];
  const prepared = await datadog.prepareDatadogReader?.(target, {
    ...runtime,
    run: async (file, _args, options) => {
      budgets.push(options.timeoutMs);
      t.mock.timers.tick(1000);
      return file === runtime.ddAuthPath
        ? authenticated
        : reply(200, { data: [] });
    },
  });
  assert.equal(prepared?.kind, "ready");
  if (prepared?.kind !== "ready") throw new Error("expected reader");
  await prepared.get("/api/v2/cases/case-1/timelines");
  await prepared.get("/api/v2/cases/case-1/timelines?page%5Bnumber%5D=1");
  assert.deepEqual(budgets, [30_000, 29_000, 28_000]);
  t.mock.timers.tick(30_000);
  assert.deepEqual(await prepared.get("/api/v2/cases/case-1"), {
    kind: "retryable",
    code: "observation_timeout",
  });
  assert.equal(budgets.length, 3);
});

test("cancelled reads preserve credentials and make no further requests", async () => {
  const controller = new AbortController();
  let curls = 0;
  const prepared = await datadog.prepareDatadogReader?.(
    target,
    {
      ...runtime,
      run: async (file) => {
        if (file === runtime.ddAuthPath) return authenticated;
        curls++;
        return reply(200, {});
      },
    },
    controller.signal,
  );
  assert.equal(prepared?.kind, "ready");
  if (prepared?.kind !== "ready") throw new Error("expected reader");
  controller.abort();
  assert.deepEqual(await prepared.get("/api/v2/cases/case-1"), {
    kind: "retryable",
    code: "interrupted",
  });
  assert.equal(curls, 0);
});

test("create supplies the required priority without assigning a severity", async () => {
  const result = await sendDatadogOperation(request, {
    ...runtime,
    run: async (file, _args, options) => {
      if (file === runtime.ddAuthPath) return authenticated;
      const attributes = JSON.parse(options.input!).data.attributes;
      const accepted = ["NOT_DEFINED", "P1", "P2", "P3", "P4", "P5"].includes(
        attributes.priority,
      );
      if (!accepted) return reply(400, { errors: ["invalid priority"] });
      assert.equal(attributes.priority, "NOT_DEFINED");
      return reply(201, { data: { id: "case-unprioritized" } });
    },
  });
  assert.equal(result.kind, "success");
});
