import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const minimum = manifest.devDependencies["@earendil-works/pi-coding-agent"];
const family = minimum.split(".").slice(0, 2).join(".");

test("CI minimum matches the SDK used for native contracts", () => {
  assert.equal(workflow.match(/PI_VERSION=(\d+\.\d+\.\d+)/)?.[1], minimum);
  assert.equal(manifest.devDependencies["@earendil-works/pi-tui"], minimum);
});

test("CI latest lane selects stable patches of the SDK family", () => {
  assert.ok(workflow.includes(`- latest-${family}`));
  const selector = workflow.match(/=> \/(.+?)\/\.test\(v\)/)?.[1];
  assert.ok(selector, "CI must expose its stable-version selector");
  const versions = [
    "0.84.1",
    "1.1.9",
    minimum,
    `${family}.17`,
    `${family}.18-beta.1`,
    "2.0.0",
  ];
  assert.deepEqual(
    versions.filter((version) => new RegExp(selector).test(version)),
    [minimum, `${family}.17`],
  );
});
