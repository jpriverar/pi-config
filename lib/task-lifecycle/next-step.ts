export const NEXT_STEP_KEY = "next_step";
export const NEXT_STEP_MAX_CHARS = 2000;

export function normalizeNextStep(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`next_step must be text or null, received ${typeof value}`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error("next_step must not contain control characters");
  }
  if (
    value.length > NEXT_STEP_MAX_CHARS * 2 ||
    [...value].length > NEXT_STEP_MAX_CHARS
  ) {
    throw new Error(`next_step exceeds ${NEXT_STEP_MAX_CHARS} characters`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("next_step must not be blank");
  return normalized;
}
