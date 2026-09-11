import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const RESEARCH_WEB_BLOCKED_EVENT = "research-web:blocked";
const HERDR_BLOCKED_EVENT = "herdr:blocked";

function activeState(payload: unknown): boolean | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const active = (payload as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : undefined;
}

function bridgeBlockedEvent(
  pi: Pick<ExtensionAPI, "events">,
  channel: string,
  label: string,
): void {
  pi.events.on(channel, (payload: unknown) => {
    const active = activeState(payload);
    if (active === undefined) return;

    pi.events.emit(
      HERDR_BLOCKED_EVENT,
      active ? { active: true, label } : { active: false },
    );
  });
}

export function createHerdrAskUserBridge() {
  return function herdrAskUserBridge(pi: Pick<ExtensionAPI, "events">): void {
    bridgeBlockedEvent(pi, ASK_USER_BLOCKED_EVENT, "Waiting for user input");
    bridgeBlockedEvent(
      pi,
      RESEARCH_WEB_BLOCKED_EVENT,
      "Waiting for web search approval",
    );
  };
}

export default createHerdrAskUserBridge();
