import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [mode, pidFile] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, String(process.pid));
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "overflow") {
  process.stdout.write("x".repeat(65536));
  setInterval(() => {}, 1000);
} else if (mode === "retained-pipe") {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 750)", pidFile],
    {
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  writeFileSync(`${pidFile}.child`, String(child.pid));
  child.unref();
  process.exit(0);
} else {
  throw new Error(`unsupported fixture mode ${mode}`);
}
