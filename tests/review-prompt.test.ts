import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
);
// Expansion is native Pi behavior, but is not re-exported at the SDK root.
const sdkEntry = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { expandPromptTemplate } = await import(
  pathToFileURL(join(dirname(sdkEntry), "core/prompt-templates.js")).href
);

for (const [command, skillName] of [
  ["review", "correctness-review"],
  ["review-quality", "thermo-nuclear-code-quality-review"],
]) {
  test(`/${command} loads its canonical skill and forwards the review target`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-review-prompts-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const loader = new DefaultResourceLoader({
      cwd: temporary,
      agentDir: join(temporary, "agent"),
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: manifest.pi.skills.map((p: string) =>
        resolve(repository, p),
      ),
      additionalPromptTemplatePaths: manifest.pi.prompts.map((p: string) =>
        resolve(repository, p),
      ),
    });
    await loader.reload();
    const { prompts, diagnostics } = loader.getPrompts();
    assert.deepEqual(diagnostics, []);
    const prompt = prompts.find((p) => p.name === command);
    assert.ok(prompt, `/${command} is exposed by the package manifest`);
    assert.equal(prompt.filePath, join(repository, "prompts", `${command}.md`));
    assert.deepEqual(loader.getSkills().diagnostics, []);
    assert.ok(
      loader.getSkills().skills.some((skill) => skill.name === skillName),
      `${skillName} is available to the consuming agent`,
    );
    const target = "https://github.com/example/repo/pull/42";
    const expanded = expandPromptTemplate(`/${command} ${target}`, prompts);
    assert.ok(
      expanded.includes(`Apply the \`${skillName}\` skill inline`),
      `/${command} must select ${skillName}`,
    );
    assert.ok(
      expanded.includes(target),
      "the requested target reaches the prompt",
    );
    assert.ok(
      !expanded.includes("$ARGUMENTS"),
      "no unbound target placeholder",
    );
  });
}
