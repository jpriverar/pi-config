import type {
  ConditionDefinition,
  LifecycleCheck,
} from "../../lib/task-lifecycle/types.js";

const text = { type: "string", minLength: 1 } as const;
const strings = { type: "array", items: text } as const;
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const check = object({
  id: text,
  kind: { type: "string", enum: ["github_pull_request", "time", "manual"] },
  targetArtifactIds: strings,
  predicate: {
    type: "object",
    additionalProperties: true,
    description:
      "Only existing automated predicates are supported; use a manual check for approval, fresh review response, or CI criteria.",
  },
  onSatisfied: { type: "string", enum: ["close", "actionable"] },
  wakeOn: strings,
});
const definitions = [
  {
    kind: { const: "check" },
    purpose: { type: "string", enum: ["completion", "continuation"] },
    check,
  },
  {
    kind: { const: "dependency" },
    purpose: { const: "completion" },
    blockerIds: { ...strings, minItems: 1 },
  },
];
export const conditionSchema = {
  anyOf: definitions.map((properties) => object(properties)),
};
export const conditionUpdateSchema = {
  anyOf: [...definitions, { kind: { const: "clear" } }].map((properties) =>
    object({ ...properties, reason: text }),
  ),
};

type CheckDefinitionInput = Pick<
  LifecycleCheck,
  "id" | "kind" | "targetArtifactIds" | "predicate" | "onSatisfied" | "wakeOn"
>;
export type ConditionInput =
  | {
      kind: "check";
      purpose: "completion" | "continuation";
      check: CheckDefinitionInput;
    }
  | Extract<ConditionDefinition, { kind: "dependency" }>;

export function conditionFromInput(
  input: ConditionInput,
  now: string,
): ConditionDefinition {
  if (input.kind === "dependency") return input;
  return {
    ...input,
    check: {
      ...input.check,
      state: "pending",
      createdAt: now,
      lastCheckedAt: null,
      nextCheckAt: input.check.kind === "manual" ? null : now,
      lastObservation: null,
      errorCount: 0,
    },
  };
}
