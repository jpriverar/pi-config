import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseStart, validateWindow } from "./model.mjs";

/** @typedef {import('./model.mjs').Window} Window */
/** @typedef {import('./model.mjs').SessionResult} SessionResult */
/** @typedef {import('./model.mjs').SessionEvidence} SessionEvidence */
/** @typedef {{maxFiles: number, maxBytes: number, maxEvidenceBytes: number}} Limits */
/** @typedef {{origin: string, replacement: boolean, key: string, evidence: SessionEvidence}} Candidate */

const defaults = {
  maxFiles: 10000,
  maxBytes: 256 * 1024 * 1024,
  maxEvidenceBytes: 1024 * 1024,
};
const knownTypes = new Set([
  "message",
  "context_edit",
  "model_change",
  "thinking_level_change",
  "usage",
  "custom",
  "custom_message",
  "compaction",
  "branch_summary",
  "label",
  "session_info",
]);

/** @param {unknown} content @returns {string} */
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** @param {string} text @param {string} role */
function safeText(text, role) {
  if (text.includes("<!-- standup-report:v1")) return "";
  text = text
    .replace(
      /<!-- standup-summary:v1 -->[\s\S]*?<!-- \/standup-summary -->/g,
      "",
    )
    .replace(
      /<untrusted-task-metadata>[\s\S]*?<\/untrusted-task-metadata>/g,
      "",
    )
    .trim();
  if (
    /-----BEGIN .*PRIVATE KEY-----|\b(?:api[_-]?key|app[_-]?key|token|password|secret)\s*[:=]\s*["']?\S{6,}|https?:\/\/[^\s/]+:[^\s/]+@/i.test(
      text,
    )
  )
    return "";
  if (role === "toolResult" || role === "bashExecution") {
    // Raw tool output can contain private files; retain only numeric test summaries.
    return text
      .split("\n")
      .filter((line) =>
        /^(?:# (?:tests|pass|fail) \d+|Tests: \d+ passed, \d+ total|Test Suites: \d+ passed, \d+ total)$/.test(
          line,
        ),
      )
      .join("\n");
  }
  return text;
}

/** @param {unknown[]} fields */
function hash(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** @param {string} root @param {Window} window @param {Limits} limits @returns {Promise<SessionResult>} */
export async function collectSessions(root, window, limits = defaults) {
  validateWindow(window);
  for (const [name, value] of Object.entries(limits))
    assert(
      Number.isSafeInteger(value) && value >= 0,
      `Invalid session limit ${name}: ${value}`,
    );
  /** @type {SessionResult} */
  const result = {
    evidence: [],
    coverage: {
      source: "sessions",
      status: "complete",
      checked: [root],
      limitations: [],
    },
  };
  /** @param {string} reason */
  function incomplete(reason) {
    result.coverage.status = "incomplete";
    result.coverage.limitations.push(reason);
  }
  /** @type {Candidate[]} */
  const candidates = [];
  /** @type {Map<string, string>} */
  const edited = new Map();
  const ambiguous = new Set();
  let files = 0,
    bytes = 0,
    traversed = 0,
    metadataFiles = 0;
  const startMs = Date.parse(window.start);
  const directories = [root];
  try {
    const info = await lstat(root);
    assert(
      info.isDirectory() && !info.isSymbolicLink(),
      `Unsafe session root: ${root}`,
    );
    while (directories.length) {
      const directory = directories.pop();
      assert(directory);
      for (const item of await readdir(directory, { withFileTypes: true })) {
        traversed++;
        assert(
          traversed <= Math.max(1, limits.maxFiles * 10),
          "Session directory traversal budget exhausted",
        );
        const path = join(directory, item.name);
        if (item.isSymbolicLink()) {
          incomplete(`Symlink not followed: ${path}`);
          continue;
        }
        if (item.isDirectory()) {
          // Exported subagent transcripts are not the native session history.
          if (item.name !== "subagent-artifacts") directories.push(path);
          continue;
        }
        if (!item.name.endsWith(".jsonl")) continue;
        const metadata = await lstat(path);
        metadataFiles++;
        assert(
          metadata.isFile() && !metadata.isSymbolicLink(),
          `Unsafe session file: ${path}`,
        );
        // Discovery only: later writes must not hide earlier in-window messages.
        if (Math.max(metadata.mtimeMs, metadata.ctimeMs) < startMs) continue;
        files++;
        if (files > limits.maxFiles)
          throw new Error("Session file limit exhausted");
        try {
          const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          /** @type {Record<string, any>[]} */
          const entries = [];
          try {
            const info = await file.stat();
            assert(info.isFile(), `Unsafe session file: ${path}`);
            bytes += info.size;
            assert(bytes <= limits.maxBytes, "Session byte budget exhausted");
            assert(info.size > 0, "Empty session file");
            const last = Buffer.alloc(1);
            await file.read(last, 0, 1, info.size - 1);
            assert(
              last[0] === 10,
              "Truncated or actively appended session tail",
            );
            const stream = file.createReadStream({
              start: 0,
              end: info.size - 1,
              autoClose: false,
            });
            const lines = createInterface({
              input: stream,
              crlfDelay: Infinity,
            });
            try {
              for await (const line of lines) {
                if (!line.trim()) continue;
                let entry;
                try {
                  entry = JSON.parse(line);
                } catch {
                  throw new Error("Malformed JSONL record");
                }
                assert(
                  entry && typeof entry === "object" && !Array.isArray(entry),
                  "Invalid JSONL record",
                );
                entries.push(entry);
              }
            } catch (error) {
              stream.destroy();
              throw error;
            } finally {
              lines.close();
            }
            assert.equal(
              (await file.stat()).size,
              info.size,
              "Session changed during collection; retry a stable snapshot",
            );
          } finally {
            await file.close();
          }
          const header = entries.shift();
          assert(header?.type === "session", "Missing session header");
          if (header.version !== 3) {
            const relevant = entries.some(
              (entry) =>
                typeof entry.timestamp !== "string" ||
                (entry.timestamp >= window.start &&
                  entry.timestamp < window.end),
            );
            if (relevant) incomplete(`Unsupported session version: ${path}`);
            continue;
          }
          const byId = new Map();
          for (const entry of entries) {
            assert(
              knownTypes.has(entry.type),
              "Unsupported session entry type",
            );
            assert(
              typeof entry.id === "string" &&
                /^[a-z0-9_-]{1,128}$/i.test(entry.id) &&
                !byId.has(entry.id),
              "Missing or duplicate session entry ID",
            );
            assert(
              entry.parentId === null || typeof entry.parentId === "string",
              "Invalid session parent",
            );
            try {
              entry.timestamp = parseStart(entry.timestamp);
            } catch {
              throw new Error("Invalid session entry timestamp");
            }
            byId.set(entry.id, entry);
          }
          const validated = new Set();
          for (const entry of entries) {
            let current = entry;
            const pathIds = new Set();
            while (current && !validated.has(current.id)) {
              assert(!pathIds.has(current.id), "Cyclic session ancestry");
              pathIds.add(current.id);
              if (current.parentId === null) break;
              assert(byId.has(current.parentId), "Missing session parent");
              current = byId.get(current.parentId);
            }
            for (const id of pathIds) validated.add(id);
          }
          /** @param {string} ancestor @param {string|null} descendant */
          function isAncestor(ancestor, descendant) {
            let steps = 0;
            while (descendant !== null) {
              assert(
                ++steps <= 10000,
                "Session edit ancestry budget exhausted",
              );
              if (descendant === ancestor) return true;
              descendant = byId.get(descendant)?.parentId ?? null;
            }
            return false;
          }
          /** @type {Map<string, Record<string, any>>} */
          const edits = new Map();
          const unsafeTargets = new Set();
          for (const entry of entries.filter(
            (entry) => entry.type === "context_edit",
          )) {
            assert(
              byId.has(entry.targetId) &&
                isAncestor(entry.targetId, entry.parentId),
              "Unresolved context edit target",
            );
            const previous = edits.get(entry.targetId);
            if (previous && !isAncestor(previous.id, entry.parentId)) {
              unsafeTargets.add(entry.targetId);
              incomplete(`Ambiguous branch edits: ${path}#${entry.targetId}`);
            }
            assert(
              entry.replacement === null ||
                typeof entry.replacement === "string" ||
                Array.isArray(entry.replacement),
              "Unsupported context replacement",
            );
            edits.set(entry.targetId, entry);
          }
          for (const entry of entries) {
            if (entry.type !== "message") continue;
            const message = entry.message;
            assert(
              message && typeof message.role === "string",
              "Invalid session message",
            );
            if (
              !["user", "assistant", "toolResult", "bashExecution"].includes(
                message.role,
              ) ||
              message.excludeFromContext
            )
              continue;
            let occurredAt = entry.timestamp;
            if (message.timestamp !== undefined) {
              assert(
                typeof message.timestamp === "number" &&
                  Number.isFinite(message.timestamp),
                "Invalid original message timestamp",
              );
              occurredAt = new Date(message.timestamp).toISOString();
            }
            const original = textContent(message.content ?? message.output);
            const origin = hash([entry.id, occurredAt, message.role, original]);
            const edit = edits.get(entry.id);
            let text = original;
            if (edit) {
              text =
                edit.replacement === null ? "" : textContent(edit.replacement);
              const editHash = hash([text]);
              if (edited.has(origin) && edited.get(origin) !== editHash) {
                ambiguous.add(origin);
                incomplete(
                  `Conflicting edits across copied sessions: ${path}#${entry.id}`,
                );
              }
              edited.set(origin, editHash);
              if (unsafeTargets.has(entry.id)) ambiguous.add(origin);
            }
            if (occurredAt < window.start || occurredAt >= window.end) continue;
            text = safeText(text, message.role);
            if (!text) continue;
            candidates.push({
              origin,
              replacement: Boolean(edit),
              key: hash([entry.id, occurredAt, message.role, text]),
              evidence: {
                refs: [`${path}#${entry.id}`],
                occurredAt,
                role: message.role,
                text,
              },
            });
          }
        } catch (error) {
          incomplete(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (bytes > limits.maxBytes)
          throw new Error("Session byte budget exhausted");
      }
    }
  } catch (error) {
    incomplete(error instanceof Error ? error.message : String(error));
  }
  const selected = new Map();
  let outputBytes = 0;
  for (const candidate of candidates) {
    if (
      ambiguous.has(candidate.origin) ||
      (edited.has(candidate.origin) && !candidate.replacement)
    )
      continue;
    const previous = selected.get(candidate.key);
    if (previous) {
      previous.refs.push(...candidate.evidence.refs);
      continue;
    }
    outputBytes += Buffer.byteLength(candidate.evidence.text);
    if (outputBytes > limits.maxEvidenceBytes) {
      incomplete("Session selected-text budget exhausted");
      break;
    }
    selected.set(candidate.key, candidate.evidence);
  }
  // An unscanned file may retract text copied into a file already inspected.
  result.evidence =
    result.coverage.status === "complete"
      ? [...selected.values()].sort((a, b) =>
          a.occurredAt.localeCompare(b.occurredAt),
        )
      : [];
  result.coverage.checked.push(
    `${metadataFiles} files checked by metadata; ${files} candidates with mtime/ctime >= ${window.start}; ${bytes} bytes; ${result.evidence.length} selected entries; [${window.start}, ${window.end})`,
  );
  result.coverage.limitations.push(
    "Discovery uses filesystem modification/change times; deliberately backdated or unreliable metadata can hide activity",
  );
  return result;
}
