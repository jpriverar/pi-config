import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import herdrCloneExtension from "./index.js";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

function assistant(sm: SessionManager, text: string) {
  return sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "herdr-clone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p2";
  process.env.HERDR_SOCKET_PATH = "/tmp/herdr-test.sock";
  t.after(() => {
    for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  const cwd = join(root, "project with 'quotes'");
  const sm = SessionManager.create(cwd, join(root, "sessions"));
  sm.appendModelChange("openai", "gpt-5.4");
  sm.appendThinkingLevelChange("high");
  const firstUser = sm.appendMessage({
    role: "user",
    content: "Review this PR",
    timestamp: 1,
  });
  assistant(sm, "Address A, B, and C");
  sm.appendCompaction("Review context", firstUser, 100);
  const activeLeaf = assistant(sm, "Retained answer");
  sm.appendMessage({ role: "user", content: "Abandoned branch", timestamp: 2 });
  assistant(sm, "Not part of the selected branch");
  sm.branch(activeLeaf);

  const commands = new Map<string, Command>();
  const notifications: Array<{ text: string; level?: string }> = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  let exec: ExtensionAPI["exec"] = async (_command, args) => ({
    code: 0,
    killed: false,
    stderr: "",
    stdout: JSON.stringify({
      id: "test",
      result:
        args[0] === "pane"
          ? { type: "pane_info", pane: { pane_id: "w1:p3" } }
          : {
              type: "agent_info",
              agent: {
                pane_id: "w1:p3",
                terminal_id: "terminal-3",
                name: args[2],
                kind: "pi",
                state: "idle",
              },
            },
    }),
  });
  const pi = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    getThinkingLevel: () => "high",
    exec: async (
      command: string,
      args: string[],
      options: Parameters<ExtensionAPI["exec"]>[2],
    ) => {
      calls.push({ command, args });
      return exec(command, args, options);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd,
    sessionManager: sm,
    model: { provider: "openai", id: "gpt-5.4" },
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify(text: string, level?: string) {
        notifications.push({ text, level });
      },
    },
  } as unknown as ExtensionCommandContext;
  herdrCloneExtension(pi);
  return {
    sm,
    ctx,
    cwd,
    calls,
    notifications,
    commands,
    setExec(value: typeof exec) {
      exec = value;
    },
    files: () => readdirSync(sm.getSessionDir()),
    async clone(args = "") {
      const command = commands.get("herdr-clone");
      assert.ok(command, "registers /herdr-clone");
      await command.handler(args, ctx);
    },
  };
}

for (const [argument, direction] of [
  ["", "right"],
  ["v", "right"],
  ["vertical", "right"],
  ["h", "down"],
  ["horizontal", "down"],
]) {
  test(`clones the active path in a ${argument || "default"} split without changing the source`, async (t) => {
    const h = harness(t);
    const sourceFile = h.sm.getSessionFile()!;
    const sourceBytes = readFileSync(sourceFile, "utf8");
    const sourceId = h.sm.getSessionId();
    const sourceLeaf = h.sm.getLeafId();
    const branch = JSON.parse(JSON.stringify(h.sm.getBranch()));
    await h.clone(argument);

    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[0], {
      command: "herdr",
      args: [
        "pane",
        "split",
        "w1:p2",
        "--direction",
        direction,
        "--cwd",
        h.cwd,
        "--focus",
      ],
    });
    const launch = h.calls[1];
    assert.equal(launch.command, "herdr");
    const file = launch.args[launch.args.indexOf("--session") + 1];
    const clone = SessionManager.open(file);
    assert.deepEqual(launch.args, [
      "agent",
      "start",
      launch.args[2],
      "--kind",
      "pi",
      "--pane",
      "w1:p3",
      "--timeout",
      "30000",
      "--",
      "--session",
      file,
      "--provider",
      "openai",
      "--model",
      "gpt-5.4",
      "--thinking",
      "high",
    ]);
    assert.notEqual(clone.getSessionId(), sourceId);
    assert.equal(clone.getHeader()!.parentSession, sourceFile);
    assert.equal(clone.getCwd(), h.cwd);
    assert.deepEqual(clone.getBranch(), branch);
    assert.deepEqual(
      clone.buildSessionContext().messages,
      h.sm.buildSessionContext().messages,
    );
    assert.equal(h.sm.getSessionId(), sourceId);
    assert.equal(h.sm.getLeafId(), sourceLeaf);
    assert.equal(readFileSync(sourceFile, "utf8"), sourceBytes);
    assert.equal(h.notifications.at(-1)?.level, "info");
  });
}

test("uses distinct agent aliases within Herdr's 32-character limit", async (t) => {
  const h = harness(t);
  await h.clone();
  await h.clone();
  const first = h.calls[1].args[2];
  const second = h.calls[3].args[2];
  assert.match(first, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.match(second, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(first, second);
});

test("captures the model and thinking level before launching a pane", async (t) => {
  const h = harness(t);
  h.setExec(async (_command, args) => {
    if (args[0] === "pane") {
      h.ctx.model = {
        provider: "another-provider",
        id: "another-model",
      } as typeof h.ctx.model;
      return {
        code: 0,
        killed: false,
        stderr: "",
        stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }),
      };
    }
    return {
      code: 0,
      killed: false,
      stderr: "",
      stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p3" } } }),
    };
  });
  await h.clone();
  assert.deepEqual(h.calls[1].args.slice(-6), [
    "--provider",
    "openai",
    "--model",
    "gpt-5.4",
    "--thinking",
    "high",
  ]);
});

for (const condition of [
  "invalid direction",
  "outside Herdr",
  "missing pane",
  "missing socket",
  "headless",
  "busy",
  "queued input",
  "unsaved",
  "empty",
  "no model",
]) {
  test(`refuses ${condition} without creating a session or pane`, async (t) => {
    const h = harness(t);
    let argument = "";
    switch (condition) {
      case "invalid direction":
        argument = "h extra";
        break;
      case "outside Herdr":
        delete process.env.HERDR_ENV;
        break;
      case "missing pane":
        delete process.env.HERDR_PANE_ID;
        break;
      case "missing socket":
        delete process.env.HERDR_SOCKET_PATH;
        break;
      case "headless":
        h.ctx.mode = "rpc";
        break;
      case "busy":
        h.ctx.isIdle = () => false;
        break;
      case "queued input":
        h.ctx.hasPendingMessages = () => true;
        break;
      case "unsaved":
        h.ctx.sessionManager = SessionManager.inMemory();
        break;
      case "empty":
        h.sm.resetLeaf();
        break;
      case "no model":
        h.ctx.model = undefined;
        break;
    }
    const files = h.files();
    await h.clone(argument);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.files(), files);
    assert.ok(
      h.notifications.some((n) => n.level === "error" || n.level === "warning"),
    );
  });
}

test("refuses a branch before its first assistant response", async (t) => {
  const h = harness(t);
  const firstUser = h.sm
    .getBranch()
    .find((e) => e.type === "message" && e.message.role === "user")!;
  h.sm.branch(firstUser.id);
  const files = h.files();
  await h.clone();
  assert.deepEqual(h.files(), files);
  assert.deepEqual(h.calls, []);
  assert.match(h.notifications.at(-1)!.text, /assistant response/i);
});

for (const failure of [
  "command error",
  "API error",
  "malformed JSON",
  "missing pane id",
  "timeout",
  "killed",
]) {
  test(`reports split ${failure} with the saved clone and never retries`, async (t) => {
    const h = harness(t);
    h.setExec(async () => {
      if (failure === "timeout") throw new Error("split timed out");
      return {
        code: failure === "command error" ? 1 : 0,
        killed: failure === "killed",
        stdout:
          failure === "malformed JSON"
            ? "not JSON"
            : JSON.stringify(
                failure === "API error"
                  ? {
                      error: {
                        code: "pane_not_found",
                        message: "source pane missing",
                      },
                    }
                  : { result: {} },
              ),
        stderr: failure === "command error" ? "connection refused" : "",
      };
    });
    await h.clone();
    assert.equal(h.calls.length, 1);
    assert.equal(h.files().length, 2);
    const error = h.notifications.at(-1)!;
    assert.equal(error.level, "error");
    assert.match(error.text, /\.jsonl/);
    if (failure === "command error")
      assert.match(error.text, /connection refused/);
    if (failure === "API error")
      assert.match(error.text, /pane_not_found.*source pane missing/);
  });
}

test("reports a failed Pi launch with the pane and session for recovery", async (t) => {
  const h = harness(t);
  h.setExec(async (_command, args) =>
    args[0] === "pane"
      ? {
          code: 0,
          killed: false,
          stderr: "",
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }),
        }
      : { code: 1, killed: false, stderr: "Pi startup timed out", stdout: "" },
  );
  await h.clone();
  assert.equal(h.calls.length, 2);
  const error = h.notifications.at(-1)!;
  assert.equal(error.level, "error");
  assert.match(error.text, /Pi startup timed out/);
  assert.match(error.text, /w1:p3/);
  assert.match(error.text, /\.jsonl/);
});

test("does not report success when Herdr confirms a different pane", async (t) => {
  const h = harness(t);
  h.setExec(async (_command, args) => ({
    code: 0,
    killed: false,
    stderr: "",
    stdout: JSON.stringify({
      result:
        args[0] === "pane"
          ? { pane: { pane_id: "w1:p3" } }
          : { agent: { pane_id: "w1:p4" } },
    }),
  }));
  await h.clone();
  assert.equal(h.calls.length, 2);
  assert.equal(h.notifications.at(-1)!.level, "error");
  assert.match(
    h.notifications.at(-1)!.text,
    /did not confirm Pi in pane w1:p3/,
  );
});

test("blocks another clone while the first pane launch is pending", async (t) => {
  const h = harness(t);
  let resolve!: (result: ExecResult) => void;
  h.setExec(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = h.clone();
  await h.clone("h");
  assert.equal(h.calls.length, 1);
  assert.equal(h.files().length, 2);
  assert.match(h.notifications.at(-1)!.text, /already.*progress/i);
  resolve({
    code: 1,
    killed: false,
    stderr: "cancelled test launch",
    stdout: "",
  });
  await first;
  h.setExec(async () => ({
    code: 1,
    killed: false,
    stderr: "new attempt",
    stdout: "",
  }));
  await h.clone();
  assert.equal(h.calls.length, 2);
});
