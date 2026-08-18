import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const HERDR_BLOCKED_EVENT = "herdr:blocked";

function activeState(payload: unknown): boolean | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const active = (payload as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : undefined;
}

export function createHerdrAskUserBridge() {
  return function herdrAskUserBridge(pi: Pick<ExtensionAPI, "events">): void {
    pi.events.on(ASK_USER_BLOCKED_EVENT, (payload: unknown) => {
      const active = activeState(payload);
      if (active === undefined) return;

      pi.events.emit(
        HERDR_BLOCKED_EVENT,
        active
          ? { active: true, label: "Waiting for user input" }
          : { active: false },
      );
    });
  };
}

export default createHerdrAskUserBridge();
