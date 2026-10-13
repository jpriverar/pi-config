import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeScope,
  parseReport,
  serializeReport,
  validateCoverage,
  validateId,
  validateWindow,
} from "./model.mjs";

/** @typedef {import('./model.mjs').Report} Report */
/** @typedef {import('./model.mjs').History} History */
/** @typedef {import('./model.mjs').RunRequest} RunRequest */
/** @typedef {import('./model.mjs').Coverage} Coverage */
/** @typedef {import('./model.mjs').SaveResult} SaveResult */

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** @param {string} path */
async function directory(path) {
  try {
    const info = await lstat(path);
    assert(
      info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
      `Unsafe directory (symlink or permissions): ${path}`,
    );
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** @param {string} root @returns {Promise<History>} */
export async function readHistory(root) {
  const reportsPath = join(root, "reports");
  if (!(await directory(root)) || !(await directory(reportsPath)))
    return { reports: [], head: null };
  /** @type {Report[]} */
  const records = [];
  for (const name of await readdir(reportsPath)) {
    if (/^\.standup-[a-f0-9-]{36}\.tmp$/.test(name)) continue;
    assert(
      name.endsWith(".md"),
      `Unknown report history file: ${join(reportsPath, name)}`,
    );
    validateId(name.slice(0, -3), "report filename");
    const path = join(reportsPath, name);
    assert(
      !(await lstat(path)).isSymbolicLink(),
      `Unsafe symlink report: ${path}`,
    );
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      assert(
        info.isFile() && info.size <= 1024 * 1024,
        `Unsafe or oversized report: ${path}`,
      );
      const report = parseReport(await file.readFile("utf8"));
      assert.equal(
        report.meta.id,
        name.slice(0, -3),
        `Report ID/filename mismatch: ${path}`,
      );
      assert(
        report.meta.coverage.every((item) => item.status === "complete"),
        `Incomplete committed report: ${path}`,
      );
      records.push(report);
    } finally {
      await file.close();
    }
  }
  if (!records.length) return { reports: [], head: null };
  /** @type {Map<string|null, Report>} */
  const children = new Map();
  for (const report of records) {
    assert(
      !children.has(report.meta.previousId),
      "Ambiguous report history: multiple roots or successors",
    );
    children.set(report.meta.previousId, report);
  }
  /** @type {Report[]} */
  const ordered = [];
  let current = children.get(null);
  while (current) {
    const previous = ordered.at(-1);
    if (previous) {
      assert(
        isDeepStrictEqual(current.meta.scope, previous.meta.scope),
        "Report history scope changed",
      );
      if (current.meta.revisesId !== null) {
        assert.equal(
          current.meta.revisesId,
          previous.meta.id,
          "Invalid history revision target",
        );
        assert(
          isDeepStrictEqual(current.meta.window, previous.meta.window),
          "Revision changed history interval",
        );
      } else
        assert.equal(
          current.meta.window.start,
          previous.meta.window.end,
          "Noncontiguous report history",
        );
    } else
      assert.equal(
        current.meta.revisesId,
        null,
        "First report cannot be a revision",
      );
    ordered.push(current);
    assert(ordered.length <= records.length, "Cyclic report history");
    current = children.get(current.meta.id);
  }
  assert.equal(
    ordered.length,
    records.length,
    "Disconnected report history chain",
  );
  return { reports: ordered, head: ordered.at(-1) ?? null };
}

/** @param {string} root @param {RunRequest} request @param {Coverage[]} coverage @param {string} body @param {string} generatedAt @returns {Promise<SaveResult>} */
export async function saveReport(root, request, coverage, body, generatedAt) {
  assert.equal(request.version, 1, "Unsupported request version");
  validateId(request.id);
  if (request.expectedHeadId !== null)
    validateId(request.expectedHeadId, "expected predecessor");
  assert(
    request.mode === "next" || request.mode === "regenerate",
    "Invalid request mode",
  );
  validateWindow(request.window);
  validateCoverage(coverage);
  assert(
    coverage.every((item) => item.status === "complete"),
    "Cannot save incomplete source coverage",
  );
  const scope = await normalizeScope(request.scope);
  /** @type {Report} */
  const report = {
    meta: {
      version: 1,
      id: request.id,
      previousId: request.expectedHeadId,
      revisesId: request.mode === "regenerate" ? request.expectedHeadId : null,
      window: request.window,
      scope,
      generatedAt,
      coverage,
    },
    body,
  };
  const text = serializeReport(report);
  assert(Buffer.byteLength(text) <= 1024 * 1024, "Report exceeds 1 MiB limit");
  const reportsPath = join(root, "reports");
  const path = join(reportsPath, `${request.id}.md`);
  const lock = join(root, ".lock");
  /** @param {History} history @returns {SaveResult|undefined} */
  function existing(history) {
    const prior = history.reports.find((item) => item.meta.id === request.id);
    if (!prior) return;
    assert(
      isDeepStrictEqual(
        {
          ...report,
          meta: { ...report.meta, generatedAt: prior.meta.generatedAt },
        },
        prior,
      ),
      `Report ID conflicts with different content: ${request.id}`,
    );
    return { path, id: request.id, alreadySaved: true };
  }
  let history = await readHistory(root);
  const prior = existing(history);
  if (prior) {
    try {
      await lstat(lock);
      prior.recovery = `Saved report exists; inspect leftover lock at ${lock}`;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    return prior;
  }
  if (!(await directory(root)))
    await mkdir(root, { recursive: true, mode: 0o700 });
  assert(await directory(root), `Missing report root: ${root}`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    throw new Error(
      `Cannot acquire standup lock ${lock}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  /** @type {SaveResult|undefined} */
  let saved;
  /** @type {unknown} */
  let failure;
  let temporaryOwned = false;
  const temporary = join(reportsPath, `.standup-${request.id}.tmp`);
  try {
    history = await readHistory(root);
    const prior = existing(history);
    if (prior) saved = prior;
    else {
      assert.equal(
        history.head?.meta.id ?? null,
        request.expectedHeadId,
        "Stale expected predecessor; keep this run as a draft",
      );
      if (history.head)
        assert(
          isDeepStrictEqual(history.head.meta.scope, scope),
          "Cannot change reporting scope across checkpoints",
        );
      if (request.mode === "regenerate") {
        assert(
          history.head &&
            isDeepStrictEqual(history.head.meta.window, request.window),
          "Regeneration requires the same latest interval",
        );
      } else if (history.head)
        assert.equal(
          request.window.start,
          history.head.meta.window.end,
          "Next report start must be contiguous",
        );
      if (!(await directory(reportsPath)))
        await mkdir(reportsPath, { mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      temporaryOwned = true;
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, path);
      saved = { path, id: request.id, alreadySaved: false };
    }
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = [];
  if (temporaryOwned) {
    try {
      await unlink(temporary);
    } catch (error) {
      cleanupErrors.push(`temporary ${temporary}: ${String(error)}`);
    }
  }
  try {
    await rmdir(lock);
  } catch (error) {
    cleanupErrors.push(`lock ${lock}: ${String(error)}`);
  }
  if (saved) {
    if (cleanupErrors.length)
      saved.recovery = `Report saved; inspect ${cleanupErrors.join("; ")}`;
    return saved;
  }
  if (cleanupErrors.length)
    throw new Error(
      `Standup save failed: ${String(failure)}; inspect ${cleanupErrors.join("; ")}`,
    );
  throw failure;
}
