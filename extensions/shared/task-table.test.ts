import assert from "node:assert/strict";
import test from "node:test";
import { classifyReadiness } from "../../lib/beads.js";
import { renderTaskTable, taskTableCells } from "./task-table.js";
const theme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
test("rollup tables show project labels without changing legacy table defaults", () => {
  const issues = classifyReadiness(
    [
      {
        id: "zz-1",
        title: "A task",
        status: "open",
        labels: ["workstream:API"],
      },
    ],
    new Set(["zz-1"]),
  );
  assert.doesNotMatch(
    renderTaskTable(issues, theme).lines.join("\n"),
    /\[API\]/,
  );
  assert.match(
    renderTaskTable(issues, theme, undefined, { showProject: true }).lines.join(
      "\n",
    ),
    /\[API\]/,
  );
  assert.deepEqual(
    taskTableCells(issues[0], theme, undefined, { showProject: true }).task,
    ["A task", "[API]"],
  );
});
