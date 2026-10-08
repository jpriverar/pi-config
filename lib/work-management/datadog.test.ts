import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sendDatadogOperation,
  type DatadogOperationRequest,
} from "./datadog.js";
import { target } from "./test-fixtures.js";
import type { runBoundedCommand } from "../task-reconciler/commands.js";

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
    assert.equal(file, "/test/dd-auth");
    assert.equal(args[0], "--org-uuid");
    assert.equal(args[1], target.orgUuid);
    assert.equal(args[args.indexOf("/usr/bin/curl") + 1], "-q");
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
        description: "private description\n\nLocal task: jp-test",
        type_id: target.typeId,
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
      attributes: { comment: "private progress\n\n2026-10-07T12:00:00Z" },
    },
  });
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
      run: async () => response,
    });
    assert.equal(result.kind, kind);
    assert.ok(!JSON.stringify(result).includes("secret"));
    if (result.kind === "retryable") assert.equal(result.retryAfterMs, 10_000);
  }
  assert.equal(
    (
      await sendDatadogOperation(request, {
        ...runtime,
        run: async () => {
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
    run: async () => {
      throw new CommandExecutionError("dd-auth", "spawn_failed");
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
    `#!${process.execPath}\nconst fs = require('fs'), cp = require('child_process');
const args = process.argv.slice(2), sep = args.indexOf('--'), curl = args.slice(sep + 2);
if (!curl[curl.indexOf('--url') + 1].startsWith('https://api.datadoghq.com/')) process.exit(2);
curl[curl.indexOf('--url') + 1] = process.env.TEST_BASE;
curl[curl.indexOf('--proto') + 1] = '=http';
const env = {...process.env};
if (!env.TEST_MISSING) { env.DD_API_KEY='fake-api'; env.DD_APP_KEY='fake-app'; }
const r=cp.spawnSync(args[sep+1],curl,{env,input:fs.readFileSync(0),encoding:'utf8'});
process.stdout.write(r.stdout||''); process.stderr.write(r.stderr||''); process.exit(r.status||0);\n`,
    { mode: 0o700 },
  );
  await writeFile(join(root, ".curlrc"), "location\n");
  const local = {
    ...runtime,
    ddAuthPath: auth,
    env: { HOME: root, TEST_BASE: `http://127.0.0.1:${address.port}/create` },
  };
  assert.equal((await sendDatadogOperation(request, local)).kind, "success");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].api, "fake-api");
  assert.equal(requests[0].app, "fake-app");
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
    "unknown",
  );
  assert.equal(requests.length, 2);
});
