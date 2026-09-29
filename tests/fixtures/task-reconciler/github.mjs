import { writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
const root = dirname(fileURLToPath(import.meta.url));
if (args[0] === "auth") console.log("fixture-token");
else if (args[0] === "pr") {
  const number = new URL(args[2]).pathname.split("/").at(-1);
  if (number === "2") process.exit(1);
  if (number === "3") {
    await writeFile(join(root, "observing-3"), "observing");
    while (
      !(await access(join(root, "release-3")).then(
        () => true,
        () => false,
      ))
    )
      await delay(20);
  }
  console.log(
    JSON.stringify({
      state: "MERGED",
      mergedAt: "2026-01-01T00:00:00.000Z",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
    }),
  );
  if (number === "4") {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 3000)"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    await writeFile(join(root, "pipe-child"), String(child.pid));
    child.unref();
  }
} else throw new Error("unsupported fixture GitHub command");
