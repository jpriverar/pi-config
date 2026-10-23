import { constants, realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  createReadToolDefinition,
  type ExtensionAPI,
  type ReadOperations,
} from "@earendil-works/pi-coding-agent";

const reason =
  "Proposal-only fixture: only reads within the fixture and selected skill are permitted.";
export function blockProposalMutation(event: { toolName: string }) {
  return event.toolName === "read" ? undefined : { block: true, reason };
}
export function createProposalReadOperations(roots: string[]): ReadOperations {
  const allowed = roots.map((root) => realpathSync(root));
  function authorized(path: string): string {
    const target = realpathSync(path);
    if (
      !allowed.some((root) => {
        const path = relative(root, target);
        return (
          path === "" ||
          (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        );
      })
    )
      throw new Error(reason);
    return target;
  }
  // Check the native reader's expanded path, not its pre-normalization arguments.
  return {
    access: async (path) => access(authorized(path), constants.R_OK),
    readFile: async (path) => readFile(authorized(path)),
  };
}
export default function (pi: ExtensionAPI) {
  const roots: unknown = JSON.parse(
    process.env.PI_SKILL_TEST_READ_ROOTS ?? "null",
  );
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    roots.some((root) => typeof root !== "string")
  )
    throw new Error("Proposal fixture requires explicit read roots");
  pi.registerTool(
    createReadToolDefinition(process.cwd(), {
      operations: createProposalReadOperations(roots),
    }),
  );
  pi.on("tool_call", blockProposalMutation);
}
