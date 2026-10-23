export interface WakeupTiming {
  delaySeconds?: number;
  at?: string;
  timeoutSeconds?: number;
}

export function resolveWakeupTiming(
  request: WakeupTiming,
  now: number,
): { dueAt: number; seconds: number; deadline: number } {
  if ((request.delaySeconds === undefined) === (request.at === undefined)) {
    throw new Error("Provide exactly one of delaySeconds or at.");
  }
  const seconds =
    request.timeoutSeconds === undefined ? 3600 : request.timeoutSeconds;
  integer(seconds, 61, 86400, "timeoutSeconds");
  let dueAt: number;
  if (request.at !== undefined) {
    dueAt = timestamp(request.at);
    if (dueAt - now < 60_000 || dueAt - now > 7 * 86_400_000) {
      throw new Error(
        `at=${JSON.stringify(request.at)} must be 60 seconds through one week in the future.`,
      );
    }
  } else {
    integer(request.delaySeconds, 60, 3600, "delaySeconds");
    dueAt = now + request.delaySeconds * 1000;
  }
  return {
    dueAt,
    seconds,
    deadline: (request.at === undefined ? now : dueAt) + seconds * 1000,
  };
}

function timestamp(at: string): number {
  const shown =
    typeof at === "string" ? JSON.stringify(at.slice(0, 64)) : String(at);
  const invalid = () =>
    new Error(
      `at=${shown} must be a valid YYYY-MM-DDTHH:mm:ss[.sss] timestamp with Z or an explicit UTC offset.`,
    );
  if (typeof at !== "string" || at.length > 64) throw invalid();
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      at,
    );
  if (!match || match[0] !== at) throw invalid();
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) throw invalid();
  const offset =
    match[3] === "Z"
      ? 0
      : (match[4] === "+" ? 1 : -1) *
        (Number(match[5]) * 60 + Number(match[6]));
  // Date.parse normalizes impossible dates; round-trip in the original offset.
  const local = new Date(parsed + offset * 60_000).toISOString();
  if (local !== `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`)
    throw invalid();
  return parsed;
}

function integer(
  value: unknown,
  min: number,
  max: number,
  name: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(
      `${name}=${String(value)} must be an integer between ${min} and ${max}.`,
    );
  }
}
