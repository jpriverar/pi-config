import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { normalizeScope, selectWindow } from "./model.mjs";
import { readHistory, saveReport } from "./store.mjs";
import { collectSessions } from "./sessions.mjs";

/** @param {string|undefined} path */
async function jsonFile(path) {
  assert(path, "Missing required JSON file argument");
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON file: ${path}`);
  }
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      scope: { type: "string" },
      since: { type: "string" },
      regenerate: { type: "boolean" },
      request: { type: "string" },
      coverage: { type: "string" },
      body: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node standup.mjs history | prepare --scope FILE [--since DATE] [--regenerate] | sessions --request FILE | save --request FILE --coverage FILE --body FILE [--root DIR]",
    );
  } else {
    assert.equal(
      positionals.length,
      1,
      "Expected one command: prepare, history, sessions, or save",
    );
    const root = resolve(values.root ?? join(homedir(), ".pi", "standup"));
    const [command] = positionals;
    if (command === "prepare") {
      const now = new Date().toISOString();
      const scope = await normalizeScope(await jsonFile(values.scope));
      const { head } = await readHistory(root);
      assert(
        !head || isDeepStrictEqual(head.meta.scope, scope),
        "Reporting scope differs from saved history; request an explicit recovery decision",
      );
      const mode = values.regenerate ? "regenerate" : "next";
      const window = selectWindow(head, { now, since: values.since, mode });
      console.log(
        JSON.stringify({
          version: 1,
          id: randomUUID(),
          mode,
          expectedHeadId: head?.meta.id ?? null,
          window,
          scope,
        }),
      );
    } else if (command === "history") {
      const { head, reports } = await readHistory(root);
      console.log(
        JSON.stringify({
          count: reports.length,
          head: head?.meta ?? null,
          path: head ? join(root, "reports", `${head.meta.id}.md`) : null,
        }),
      );
    } else if (command === "sessions") {
      const request = await jsonFile(values.request);
      console.log(
        JSON.stringify(
          await collectSessions(request.scope.sessionsRoot, request.window),
        ),
      );
    } else if (command === "save") {
      assert(values.body, "Missing --body Markdown file");
      const result = await saveReport(
        root,
        await jsonFile(values.request),
        await jsonFile(values.coverage),
        await readFile(values.body, "utf8"),
        new Date().toISOString(),
      );
      console.log(JSON.stringify(result));
      if (result.recovery) console.error(result.recovery);
    } else throw new Error(`Unknown standup command: ${command}`);
  }
} catch (error) {
  console.error(
    `Standup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
