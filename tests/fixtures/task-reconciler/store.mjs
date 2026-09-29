import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  rmdir,
  rename,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
const db = args[args.indexOf("--db") + 1];
if (!db || !db.startsWith("/"))
  throw new Error("fixture requires an explicit absolute store");
const file = join(db, "rows.json");
const lock = join(db, "fixture-db-lock");
await appendFile(join(db, "calls.jsonl"), JSON.stringify(args) + "\n");
if (args[0] === "list" || args[0] === "ready") {
  const rows = JSON.parse(await readFile(file, "utf8"));
  console.log(
    JSON.stringify(
      args[0] === "ready"
        ? rows.filter(
            (/** @type {{status: string}} */ row) => row.status === "open",
          )
        : rows,
    ),
  );
} else if (args[0] === "show") {
  const end = args.findIndex((a) => a.startsWith("--"));
  console.log(
    JSON.stringify(
      JSON.parse(await readFile(file, "utf8")).filter(
        (/** @type {{id: string}} */ row) =>
          args.slice(1, end).includes(row.id),
      ),
    ),
  );
} else if (args[0] === "update") {
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST" ||
        Date.now() > deadline
      )
        throw error;
      await delay(10);
    }
  }
  let row;
  try {
    const rows = JSON.parse(await readFile(file, "utf8"));
    row = rows.find((/** @type {{id: string}} */ r) => r.id === args[1]);
    row.status = args[args.indexOf("-s") + 1];
    row.metadata = JSON.parse(args[args.indexOf("--metadata") + 1]);
    await writeFile(file + ".tmp", JSON.stringify(rows));
    await rename(file + ".tmp", file);
  } finally {
    await rmdir(lock);
  }
  if (
    row.id === "manual-retry" &&
    (await access(join(db, "pause-response")).then(
      () => true,
      () => false,
    ))
  ) {
    await writeFile(join(db, "committed-manual"), "committed");
    while (
      await access(join(db, "pause-response")).then(
        () => true,
        () => false,
      )
    )
      await delay(20);
  }
  console.log(JSON.stringify(row));
} else throw new Error(`unsupported fixture command: ${args[0]}`);
