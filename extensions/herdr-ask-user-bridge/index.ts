import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUTH_CHALLENGE_EVENT = "auth-aware-bash:challenge";
const HERDR_BLOCKED_EVENT = "herdr:blocked";
const AUTH_LABEL = "Waiting for browser authentication";

type EventAPI = Pick<ExtensionAPI, "events">;

type AuthChallengeLifecycle = {
  challengeId: string;
  phase: "started" | "finished";
};

function activeState(payload: unknown): boolean | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const active = (payload as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : undefined;
}

function authChallengeLifecycle(
  payload: unknown,
): AuthChallengeLifecycle | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const event = payload as Record<string, unknown>;
  if (
    typeof event.challengeId !== "string" ||
    event.challengeId.length === 0 ||
    typeof event.toolCallId !== "string" ||
    event.toolCallId.length === 0
  ) {
    return undefined;
  }
  if (event.phase !== "started" && event.phase !== "finished") {
    return undefined;
  }
  if (event.method !== "browser" && event.method !== "device-code") {
    return undefined;
  }

  const expectedKeys =
    event.phase === "started"
      ? ["challengeId", "method", "phase", "toolCallId"]
      : ["challengeId", "method", "outcome", "phase", "toolCallId"];
  const keys = Object.keys(event).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return undefined;
  }

  if (
    event.phase === "finished" &&
    event.outcome !== "succeeded" &&
    event.outcome !== "failed" &&
    event.outcome !== "tool-ended"
  ) {
    return undefined;
  }

  return { challengeId: event.challengeId, phase: event.phase };
}

function bridgeBlockedEvent(
  pi: EventAPI,
  sourceEvent: string,
  label: string,
): void {
  pi.events.on(sourceEvent, (payload: unknown) => {
    const active = activeState(payload);
    if (active === undefined) return;

    pi.events.emit(
      HERDR_BLOCKED_EVENT,
      active ? { active: true, label } : { active: false },
    );
  });
}

function bridgeAuthChallengeEvent(pi: EventAPI): void {
  const activeChallengeIds = new Set<string>();

  pi.events.on(AUTH_CHALLENGE_EVENT, (payload: unknown) => {
    const event = authChallengeLifecycle(payload);
    if (!event) return;

    const wasBlocked = activeChallengeIds.size > 0;
    if (event.phase === "started") {
      activeChallengeIds.add(event.challengeId);
    } else {
      activeChallengeIds.delete(event.challengeId);
    }
    const isBlocked = activeChallengeIds.size > 0;
    if (wasBlocked === isBlocked) return;

    pi.events.emit(
      HERDR_BLOCKED_EVENT,
      isBlocked ? { active: true, label: AUTH_LABEL } : { active: false },
    );
  });
}

export default function herdrAskUserBridge(pi: EventAPI): void {
  bridgeBlockedEvent(pi, "rpiv:ask-user:blocked", "Waiting for user input");
  bridgeBlockedEvent(
    pi,
    "research-web:blocked",
    "Waiting for web search approval",
  );
  bridgeBlockedEvent(
    pi,
    "force-push:blocked",
    "Waiting for force-push approval",
  );
  bridgeAuthChallengeEvent(pi);
}
