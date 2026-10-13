import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** @typedef {{start: string, end: string}} Window */
/** @typedef {{beadsDir: string, sessionsRoot: string, github: Array<{host: string, login: string, owners: string[]}>}} Scope */
/** @typedef {{version: 1, id: string, mode: 'next'|'regenerate', expectedHeadId: string|null, window: Window, scope: Scope}} RunRequest */
/** @typedef {{source: 'beads'|'github'|'sessions', status: 'complete'|'incomplete', checked: string[], limitations: string[]}} Coverage */
/** @typedef {{version: 1, id: string, previousId: string|null, revisesId: string|null, window: Window, scope: Scope, generatedAt: string, coverage: Coverage[]}} ReportMeta */
/** @typedef {{meta: ReportMeta, body: string}} Report */
/** @typedef {{reports: Report[], head: Report|null}} History */
/** @typedef {{path: string, id: string, alreadySaved: boolean, recovery?: string}} SaveResult */
/** @typedef {{refs: string[], occurredAt: string, role: string, text: string}} SessionEvidence */
/** @typedef {{evidence: SessionEvidence[], coverage: Coverage}} SessionResult */

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const prefix = "<!-- standup-report:v1\n";

/** @param {unknown} value @param {string} name @returns {asserts value is string} */
export function validateId(value, name = "report id") {
  assert(
    typeof value === "string" && uuid.test(value),
    `Invalid ${name}: ${String(value)}`,
  );
}

/** @param {string} value @returns {string} */
export function parseStart(value) {
  assert(typeof value === "string", "Start must be a date or offset timestamp");
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      value,
    );
  assert(match, `Invalid start date/time or missing offset: ${value}`);
  const [, y, m, d, hour, minute, second] = match;
  const day = new Date(`${y}-${m}-${d}T00:00:00Z`);
  assert(
    Number.isFinite(day.valueOf()) &&
      day.toISOString().slice(0, 10) === `${y}-${m}-${d}`,
    `Invalid calendar date: ${value}`,
  );
  if (hour !== undefined) {
    assert(
      +hour < 24 && +minute < 60 && +second < 60,
      `Invalid time: ${value}`,
    );
    const instant = new Date(value);
    assert(Number.isFinite(instant.valueOf()), `Invalid timestamp: ${value}`);
    return instant.toISOString();
  }
  const local = new Date(`${y}-${m}-${d}T00:00:00`);
  assert(
    local.getFullYear() === +y &&
      local.getMonth() === +m - 1 &&
      local.getDate() === +d &&
      local.getHours() === 0,
    `Invalid local midnight: ${value}`,
  );
  return local.toISOString();
}

/** @param {unknown} value @returns {asserts value is string} */
function timestamp(value) {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value),
    `Invalid canonical timestamp: ${String(value)}`,
  );
  assert.equal(
    parseStart(value),
    value,
    `Invalid canonical timestamp: ${value}`,
  );
}

/** @param {unknown} value @returns {Record<string, any>} */
function object(value) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected metadata object",
  );
  return value;
}

/** @param {unknown} value @returns {asserts value is Window} */
export function validateWindow(value) {
  const window = object(value);
  timestamp(window.start);
  timestamp(window.end);
  assert(
    window.start < window.end,
    `Invalid interval: ${window.start} to ${window.end}`,
  );
}

/** @param {Report|null} head @param {{now: string, since?: string, mode: 'next'|'regenerate'}} options @returns {Window} */
export function selectWindow(head, options) {
  timestamp(options.now);
  assert(
    options.mode === "next" || options.mode === "regenerate",
    "Invalid window mode",
  );
  assert(
    !head || options.since === undefined,
    "Cannot override start with --since after saved history",
  );
  if (options.mode === "regenerate") {
    assert(head, "Cannot regenerate without report history");
    return { ...head.meta.window };
  }
  assert(head || options.since, "First report requires a start via --since");
  const window = {
    start: head?.meta.window.end ?? parseStart(options.since ?? ""),
    end: options.now,
  };
  validateWindow(window);
  return window;
}

/** @param {unknown} value @returns {asserts value is Scope} */
export function validateScope(value) {
  const scope = object(value);
  for (const key of ["beadsDir", "sessionsRoot"]) {
    assert(
      typeof scope[key] === "string" && isAbsolute(scope[key]),
      `Invalid scope path: ${key}`,
    );
  }
  assert(
    Array.isArray(scope.github) && scope.github.length > 0,
    "GitHub scope requires at least one declared account",
  );
  const accounts = new Set();
  for (const item of scope.github) {
    const account = object(item);
    assert(
      typeof account.host === "string" && /^[a-z0-9.-]+$/i.test(account.host),
      "Invalid GitHub host",
    );
    // Managed users include an enterprise suffix separated by an underscore.
    assert(
      typeof account.login === "string" && /^[a-z0-9_-]+$/i.test(account.login),
      "Invalid GitHub login",
    );
    assert(
      Array.isArray(account.owners) &&
        account.owners.every(
          (/** @type {unknown} */ owner) =>
            typeof owner === "string" && /^[a-z0-9_-]+$/i.test(owner),
        ),
      "Invalid GitHub owners",
    );
    const key = `${account.host}/${account.login}`.toLowerCase();
    assert(!accounts.has(key), `Duplicate GitHub account: ${key}`);
    accounts.add(key);
  }
}

/** @param {Scope} scope @returns {Promise<Scope>} */
export async function normalizeScope(scope) {
  validateScope(scope);
  return {
    beadsDir: await realpath(scope.beadsDir),
    sessionsRoot: await realpath(scope.sessionsRoot),
    github: scope.github
      .map((account) => ({
        host: account.host.toLowerCase(),
        login: account.login.toLowerCase(),
        owners: [
          ...new Set(account.owners.map((owner) => owner.toLowerCase())),
        ].sort(),
      }))
      .sort((a, b) =>
        `${a.host}/${a.login}`.localeCompare(`${b.host}/${b.login}`),
      ),
  };
}

/** @param {unknown} value @returns {asserts value is Coverage[]} */
export function validateCoverage(value) {
  assert(
    Array.isArray(value) && value.length === 3,
    "Coverage requires exactly three sources",
  );
  const sources = new Set();
  for (const entry of value) {
    const item = object(entry);
    assert(
      ["beads", "github", "sessions"].includes(item.source) &&
        !sources.has(item.source),
      `Invalid or duplicate coverage source: ${item.source}`,
    );
    assert(
      ["complete", "incomplete"].includes(item.status),
      `Invalid coverage status: ${item.status}`,
    );
    for (const key of ["checked", "limitations"]) {
      assert(
        Array.isArray(item[key]) &&
          item[key].every(
            (/** @type {unknown} */ text) => typeof text === "string",
          ),
        `Invalid coverage ${key}`,
      );
    }
    assert(
      item.checked.length > 0,
      `Coverage must identify checked scope: ${item.source}`,
    );
    sources.add(item.source);
  }
}

/** @param {unknown} value @returns {asserts value is Report} */
function validateReport(value) {
  const report = object(value);
  const meta = object(report.meta);
  assert.equal(meta.version, 1, "Unsupported report version");
  validateId(meta.id);
  for (const key of ["previousId", "revisesId"]) {
    if (meta[key] !== null) validateId(meta[key], key);
  }
  validateWindow(meta.window);
  timestamp(meta.generatedAt);
  assert(
    meta.generatedAt >= meta.window.end,
    "Report generated before coverage end",
  );
  validateScope(meta.scope);
  validateCoverage(meta.coverage);
  assert(
    typeof report.body === "string" && report.body.trim(),
    "Report body must not be empty",
  );
}

/** @param {Report} report @returns {string} */
export function serializeReport(report) {
  validateReport(report);
  const metadata = JSON.stringify(report.meta)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `${prefix}${metadata}\n-->\n${report.body}`;
}

/** @param {string} text @returns {Report} */
export function parseReport(text) {
  assert(text.startsWith(prefix), "Missing standup report metadata header");
  const end = text.indexOf("\n-->\n", prefix.length);
  assert(end !== -1, "Unterminated standup report metadata");
  const report = {
    meta: JSON.parse(text.slice(prefix.length, end)),
    body: text.slice(end + 5),
  };
  validateReport(report);
  return report;
}
