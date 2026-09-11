import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const promptUrl = new URL("../prompts/review.md", import.meta.url);
const skillUrl = new URL(
  "../skills/thermo-nuclear-code-quality-review/SKILL.md",
  import.meta.url,
);

test("review prompt applies the Thermo-Nuclear skill inline", async () => {
  const prompt = await readFile(promptUrl, "utf8");

  assert.match(prompt, /argument-hint: ["']?<PR-URL or review target>/);
  assert.match(prompt, /thermo-nuclear-code-quality-review/);
  assert.match(prompt, /\$ARGUMENTS/);
  assert.match(prompt, /inline/i);
  assert.match(prompt, /do not spawn (?:a )?subagent/i);
});

test("Thermo-Nuclear skill preserves its pinned review contract", async () => {
  const skill = await readFile(skillUrl, "utf8");

  assert.match(skill, /^---\nname: thermo-nuclear-code-quality-review\n/m);
  assert.match(skill, /description: Use when /);
  assert.match(skill, /github\.com\/cursor\/plugins/);
  assert.match(skill, /1,000 lines/);
  assert.match(skill, /code judo/i);
  assert.match(skill, /spaghetti/i);
  assert.match(skill, /approval bar/i);
});
