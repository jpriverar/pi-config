import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const RESEARCH_WEB_BLOCKED_EVENT = "research-web:blocked";
const HERDR_BLOCKED_EVENT = "herdr:blocked";

const RESEARCH_WEB_LABEL = "Waiting for web search approval";

type ResearchWebBlockedEvent = {
  toolCallId: string;
  phase: "started" | "finished";
};

function activeState(payload: unknown): boolean | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const active = (payload as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : undefined;
}

function researchWebBlockedEvent(
  payload: unknown,
): ResearchWebBlockedEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = payload as Record<string, unknown>;
  if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) {
    return undefined;
  }
  if (event.phase !== "started" && event.phase !== "finished") {
    return undefined;
  }
  if (event.reason !== "long_query" && event.reason !== "high_context") {
    return undefined;
  }
  return { toolCallId: event.toolCallId, phase: event.phase };
}

function bridgeQuestionnaireBlockedEvent(
  pi: Pick<ExtensionAPI, "events">,
): void {
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
}

function bridgeResearchWebBlockedEvent(pi: Pick<ExtensionAPI, "events">): void {
  const activeToolCalls = new Set<string>();

  pi.events.on(RESEARCH_WEB_BLOCKED_EVENT, (payload: unknown) => {
    const event = researchWebBlockedEvent(payload);
    if (!event) return;

    const wasBlocked = activeToolCalls.size > 0;
    if (event.phase === "started") {
      activeToolCalls.add(event.toolCallId);
    } else {
      activeToolCalls.delete(event.toolCallId);
    }
    const isBlocked = activeToolCalls.size > 0;
    if (wasBlocked === isBlocked) return;

    pi.events.emit(
      HERDR_BLOCKED_EVENT,
      isBlocked
        ? { active: true, label: RESEARCH_WEB_LABEL }
        : { active: false },
    );
  });
}

export function createHerdrAskUserBridge() {
  return function herdrAskUserBridge(pi: Pick<ExtensionAPI, "events">): void {
    bridgeQuestionnaireBlockedEvent(pi);
    bridgeResearchWebBlockedEvent(pi);
  };
}

export default createHerdrAskUserBridge();
