import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERDR_BLOCKED_EVENT = "herdr:blocked";

type EventAPI = Pick<ExtensionAPI, "events">;

function activeState(payload: unknown): boolean | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const active = (payload as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : undefined;
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

export default function herdrAskUserBridge(pi: EventAPI): void {
  bridgeBlockedEvent(pi, "rpiv:ask-user:blocked", "Waiting for user input");
  bridgeBlockedEvent(
    pi,
    "research-web:blocked",
    "Waiting for web search approval",
  );
}
