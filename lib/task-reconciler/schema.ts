export class ProtocolError extends Error {
  constructor(
    readonly code: "invalid_frame" | "invalid_request" | "incompatible",
    message: string,
  ) {
    super(message);
  }
}
export function record(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolError("invalid_request", "expected protocol object");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !fields.includes(key)) ||
    fields.some((key) => !optional.includes(key) && !Object.hasOwn(object, key))
  )
    throw new ProtocolError("invalid_request", "invalid protocol fields");
  return object;
}
export function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new ProtocolError("invalid_request", "invalid protocol string");
  return value;
}
export function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new ProtocolError("invalid_request", "invalid protocol integer");
  return value;
}
export function oneOf<const T extends string>(
  value: unknown,
  options: readonly T[],
): T {
  if (typeof value !== "string" || !options.includes(value as T))
    throw new ProtocolError("invalid_request", "invalid protocol enum");
  return value as T;
}
export function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!Number.isFinite(Date.parse(result)))
    throw new ProtocolError("invalid_request", "invalid protocol timestamp");
  return result;
}
export function identifier(value: unknown): string {
  const result = text(value);
  if (result.startsWith("-"))
    throw new ProtocolError("invalid_request", "invalid task identifier");
  return result;
}
export function protocolVersion(value: unknown): void {
  if (value !== 1)
    throw new ProtocolError("incompatible", "incompatible protocol version");
}
