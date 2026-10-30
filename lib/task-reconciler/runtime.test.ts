import { A, catalogFixture } from "../work-catalog/test-fixtures.js";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { loadDaemonConfig } from "./config.js";
import { createDaemonRuntime } from "./runtime.js";
import { configFixture, fixturePolicy, waitingTask } from "./test-fixtures.js";
import {
  check,
  NOW,
  OWNER,
  withCheck,
} from "../task-lifecycle/v2-test-fixtures.js";
import {
  blockLifecycleV2,
  fingerprintConditionV2,
} from "../task-lifecycle/v2-model.js";

for (const configVersion of [1, 2]) {
  test(`runtime v${configVersion} config recovers captured bindings with GETs and no replay`, async (t) => {
    const { caseUrl, newWorkManagementState } = await import(
      "../work-management/model.js"
    );
    const { createActionableLifecycle } = await import(
      "../task-lifecycle/model.js"
    );
    const { target } = await import("../work-management/test-fixtures.js");
    const f = await configFixture(t);
    const data = join(f.root, "issues.json");
    const bd = join(f.root, "fixture-bd.mjs");
    const auth = join(f.root, "fixture-http.mjs");
    const calls = join(f.root, "http-calls.jsonl");
    const prepared = catalogFixture();
    prepared.state = "prepared";
    prepared.areas[A].publication = { mode: "local" };
    const state = newWorkManagementState(target, "task", "why");
    state.remote = {
      id: "case-1",
      url: caseUrl(target.site, "case-1"),
    };
    state.lastSentStatus = "Open";
    state.inFlight = { kind: "comment", commentId: "c1" };
    const comment = {
      id: "c1",
      issue_id: "jp-sync",
      text: "progress\n\n[pi-task-log:v1]",
      created_at: "2026-10-07T12:00:00Z",
    };
    await writeFile(
      data,
      JSON.stringify([
        {
          id: "jp-sync",
          title: "task",
          status: "open",
          labels: ["workstream:api"],
          metadata: {
            piLifecycle: createActionableLifecycle(new Date().toISOString()),
            piWorkManagement: state,
          },
          dependencies: [],
        },
      ]),
    );
    await writeFile(
      bd,
      `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), path=${JSON.stringify(data)}, rows=JSON.parse(readFileSync(path,'utf8'));
if(args[0]==='config') console.log(JSON.stringify({key:'custom.pi-work-catalog',schema_version:1,value:${JSON.stringify(JSON.stringify(prepared))}}));
else if(args[0]==='list'||args[0]==='show') console.log(JSON.stringify(rows));
else if(args[0]==='comments') console.log(JSON.stringify([${JSON.stringify(comment)}]));
else if(args[0]==='update'){rows[0].metadata=JSON.parse(args[args.indexOf('--metadata')+1]);writeFileSync(path,JSON.stringify(rows));console.log(JSON.stringify(rows[0]));}
else process.exit(9);
`,
      { mode: 0o755 },
    );
    const remoteCase = {
      data: {
        id: "case-1",
        type: "case",
        attributes: { type_id: target.typeId, status_name: "Open" },
        relationships: {
          project: { data: { id: target.projectId, type: "project" } },
        },
      },
    };
    const timeline = {
      data: [
        {
          id: "cell-1",
          type: "timeline_cell",
          attributes: {
            type: "COMMENT",
            cell_content: {
              message: `progress\n\n2026-10-07T12:00:00Z\n\nPi sync: v1/${target.orgUuid}/${target.projectId}/jp-sync/comment/c1`,
            },
          },
        },
      ],
    };
    await writeFile(
      auth,
      `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--output')) process.stdout.write('DD_API_KEY=test_api\\nDD_APP_KEY=test_app\\n');
else {
  if(process.env.DD_API_KEY!=='test_api'||process.env.DD_APP_KEY!=='test_app') process.exit(9);
  const method=args[args.indexOf('--request')+1], url=new URL(args[args.indexOf('--url')+1]);
  appendFileSync(${JSON.stringify(calls)},JSON.stringify({method,path:url.pathname})+'\\n');
  const body=url.pathname.endsWith('/timelines') ? (url.searchParams.get('page[number]')==='0' ? ${JSON.stringify(timeline)} : {data:[]}) : ${JSON.stringify(remoteCase)};
  process.stdout.write(JSON.stringify(body)+'\\n200\\n');
}
`,
      { mode: 0o755 },
    );
    f.raw.executables = {
      node: process.execPath,
      bd,
      git: process.execPath,
      gh: process.execPath,
    };
    f.raw.limits = { commandTimeoutMs: 5000, observationTimeoutMs: 10_000 };
    await f.save();
    const config = await loadDaemonConfig(f.configPath);
    await writeFile(
      join(config.store, "pi-work-management.json"),
      JSON.stringify({
        version: configVersion,
        ddAuthPath: auth,
        curlPath: auth,
        ...(configVersion === 1
          ? { workstreams: {} }
          : { routingMode: "catalog" }),
      }),
    );
    const runtime = await createDaemonRuntime(config, {
      pid: process.pid,
      host: hostname(),
      sessionId: "recovery-test",
      started: Date.now(),
    });
    t.after(() => runtime.stop());
    runtime.start();
    const deadline = Date.now() + 10_000;
    while (true) {
      const saved = JSON.parse(await readFile(data, "utf8"))[0].metadata
        .piWorkManagement;
      assert.equal(
        saved.failure,
        null,
        "runtime must have a working observation adapter",
      );
      if (saved.inFlight === null) {
        assert.deepEqual(saved.deliveredCommentIds, ["c1"]);
        break;
      }
      assert.ok(Date.now() < deadline, JSON.stringify(runtime.snapshot()));
      await delay(10);
    }
    await runtime.stop();
    const requests = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      JSON.parse(await readFile(data, "utf8"))[0].metadata.piWorkManagement
        .target,
      state.target,
    );
    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.method === "GET"));
  });
}

for (const lifecycleWriteVersion of [1, 2] as const) {
  test(`composes lifecycle v${lifecycleWriteVersion} runtime without commands before start`, async (t) => {
    const f = await configFixture(t);
    const bd = join(f.root, "fixture-bd.mjs");
    const calls = join(f.root, "calls.jsonl");
    const data = join(f.root, "issues.json");
    const source = waitingTask("due");
    if (lifecycleWriteVersion === 2) {
      const current = withCheck({
        activeCheck: check({
          kind: "time",
          predicate: { at: "2020-01-01T00:00:00Z" },
          nextCheckAt: NOW,
        }),
      });
      const lifecycle = blockLifecycleV2(current, {
        operationId: "block",
        sessionId: OWNER.sessionId,
        now: NOW,
        reason: "Wait for time",
        conditionFingerprint: fingerprintConditionV2(current, [])!,
      });
      source.lifecycle = lifecycle;
      source.metadata = { piLifecycle: lifecycle };
    }
    const { id, title, status, metadata, dependencies } = source;
    await writeFile(
      data,
      JSON.stringify([{ id, title, status, metadata, dependencies }]),
    );
    await writeFile(
      bd,
      `#!${process.execPath}\nimport {readFileSync,writeFileSync,appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2); const rows=JSON.parse(readFileSync(${JSON.stringify(data)},'utf8')); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');\nif(args[0]==='list') console.log(JSON.stringify(rows));\nelse if(args[0]==='show') console.log(JSON.stringify(rows.filter(x=>args.slice(1,args.indexOf('--long')).includes(x.id))));\nelse if(args[0]==='update'){const row=rows.find(x=>x.id===args[1]);row.status=args[args.indexOf('-s')+1];row.metadata=JSON.parse(args[args.indexOf('--metadata')+1]);writeFileSync(${JSON.stringify(data)},JSON.stringify(rows));console.log(JSON.stringify(row));}\nelse process.exit(9);\n`,
      { mode: 0o755 },
    );
    f.raw.executables = {
      node: process.execPath,
      bd,
      git: process.execPath,
      gh: process.execPath,
    };
    await f.save();
    const config = await loadDaemonConfig(f.configPath);
    await writeFile(
      config.lifecycleConfigPath,
      JSON.stringify({ ...fixturePolicy, lifecycleWriteVersion }),
    );
    const runtime = await createDaemonRuntime(config, {
      pid: process.pid,
      host: hostname(),
      sessionId: "daemon-test",
      started: Date.now(),
    });
    try {
      await assert.rejects(access(calls));
      runtime.start();
      const deadline = Date.now() + 10_000;
      while (true) {
        const saved = JSON.parse(await readFile(data, "utf8"));
        if (saved[0].metadata.piLifecycle.phase === "actionable") break;
        assert.ok(Date.now() < deadline, JSON.stringify(runtime.snapshot()));
        await delay(10);
      }
      assert.equal(runtime.lifecycleWriteVersion, lifecycleWriteVersion);
      if (lifecycleWriteVersion === 2)
        assert.deepEqual(
          JSON.parse(await readFile(data, "utf8"))[0].metadata.piLifecycle
            .owner,
          OWNER,
        );
      const commands = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(commands.filter((args) => args[0] === "update").length, 1);
      assert.ok(
        commands.every(
          (args) => args.at(-2) === "--db" && args.at(-1) === config.store,
        ),
      );
    } finally {
      await runtime.stop();
    }
  });
}

for (const releaseReceipt of [true, false]) {
  test(
    releaseReceipt
      ? "shutdown drains an available delivery receipt before stopping"
      : "shutdown receipt drain stays bounded when the store is stalled",
    async (t) => {
      const { newWorkManagementState } = await import(
        "../work-management/model.js"
      );
      const { target } = await import("../work-management/test-fixtures.js");
      const { createActionableLifecycle } = await import(
        "../task-lifecycle/model.js"
      );
      const f = await configFixture(t);
      const data = join(f.root, "issues.json");
      const bd = join(f.root, "fixture-bd.mjs");
      const auth = join(f.root, "fixture-auth.mjs");
      const response = join(f.root, "response-available");
      const waiting = join(f.root, "receipt-waiting");
      const release = join(f.root, "release-receipt");
      const state = newWorkManagementState(target, "task", "why");
      await writeFile(
        data,
        JSON.stringify([
          {
            id: "jp-sync",
            title: "task",
            status: "open",
            metadata: {
              piLifecycle: createActionableLifecycle(new Date().toISOString()),
              piWorkManagement: state,
            },
            dependencies: [],
          },
        ]),
      );
      await writeFile(
        bd,
        `#!${process.execPath}\nimport {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const args=process.argv.slice(2), path=${JSON.stringify(data)};
if(args[0]==='show' && existsSync(${JSON.stringify(response)}) && JSON.parse(readFileSync(path,'utf8'))[0].metadata.piWorkManagement.remote===null) {
  writeFileSync(${JSON.stringify(waiting)},'');
  while(!existsSync(${JSON.stringify(release)})) await delay(10);
}
const rows=JSON.parse(readFileSync(path,'utf8'));
if(args[0]==='list'||args[0]==='show') console.log(JSON.stringify(rows));
else if(args[0]==='comments') console.log('[]');
else if(args[0]==='update'){const row=rows[0]; if(args.includes('-s'))row.status=args[args.indexOf('-s')+1]; row.metadata=JSON.parse(args[args.indexOf('--metadata')+1]); writeFileSync(path,JSON.stringify(rows));console.log(JSON.stringify(row));}
else process.exit(9);\n`,
        { mode: 0o755 },
      );
      await writeFile(
        auth,
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
if(process.argv.includes('--output')) process.stdout.write('DD_API_KEY=your_api_key_here\\nDD_APP_KEY=your_secret_here\\n');
else {
  if(process.env.DD_API_KEY!=='your_api_key_here'||process.env.DD_APP_KEY!=='your_secret_here') process.exit(9);
  process.stdin.resume(); process.stdin.on('end',()=>{writeFileSync(${JSON.stringify(response)},'');process.stdout.write(JSON.stringify({data:{id:'case-1'}})+'\\n201\\n');});
}\n`,
        { mode: 0o755 },
      );
      f.raw.executables = {
        node: process.execPath,
        bd,
        git: process.execPath,
        gh: process.execPath,
      };
      f.raw.limits = { commandTimeoutMs: 1000, observationTimeoutMs: 5000 };
      await f.save();
      const config = await loadDaemonConfig(f.configPath);
      await writeFile(
        join(config.store, "pi-work-management.json"),
        JSON.stringify({
          version: 1,
          ddAuthPath: auth,
          curlPath: auth,
          workstreams: {},
        }),
      );
      const runtime = await createDaemonRuntime(config, {
        pid: process.pid,
        host: hostname(),
        sessionId: "shutdown-test",
        started: Date.now(),
      });
      t.after(() => runtime.stop());
      runtime.start();
      const deadline = Date.now() + 10_000;
      while (true) {
        try {
          await access(waiting);
          break;
        } catch {
          assert.ok(Date.now() < deadline, JSON.stringify(runtime.snapshot()));
          await delay(10);
        }
      }
      const stopped = runtime.stop();
      if (releaseReceipt) await writeFile(release, "");
      await stopped;
      const saved = JSON.parse(await readFile(data, "utf8"))[0].metadata
        .piWorkManagement;
      if (releaseReceipt) {
        assert.equal(saved.remote?.id, "case-1");
        assert.equal(saved.inFlight, null);
        assert.equal(saved.failure, null);
      } else {
        assert.equal(saved.remote, null);
        assert.deepEqual(saved.inFlight, { kind: "create" });
      }
    },
  );
}
