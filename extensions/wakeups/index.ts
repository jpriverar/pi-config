import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WakeupController, type WakeupState } from "../../lib/wakeups.js";

export default function wakeupExtension(pi: ExtensionAPI): void {
  registerWakeupTools(pi, VERSION);
}

export function registerWakeupTools(pi: ExtensionAPI, version: string): void {
  const release = /^1\.(\d+)\.\d+(?:\+[\w.-]+)?$/.exec(version);
  if (!release || Number(release[1]) < 2) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `Wakeup tools are disabled on Pi ${version}; they require Pi 1.2 or newer within 1.x for abort-aware settlement.`,
        "warning",
      );
    });
    return;
  }

  let context: ExtensionContext | undefined;
  const wakeups = new WakeupController({
    canDeliver: () =>
      Boolean(context?.isIdle() && !context.hasPendingMessages()),
    changed: (state) => {
      const item = state.pending;
      context?.ui.setStatus(
        "scheduled-wakeup",
        item
          ? `${item.id}: due ${new Date(item.dueAt).toLocaleTimeString()}`
          : undefined,
      );
    },
    notify: (message) => context?.ui.notify(message, "warning"),
    deliver: (item) => {
      pi.sendMessage(
        {
          customType: "scheduled-wakeup",
          display: true,
          details: item,
          content: `Scheduled check ${item.id}, continuing previously approved work—not new user input.\nReason: ${item.reason}\nDeadline: ${new Date(item.deadline).toISOString()}\n\n${item.prompt}\n\nVerify the operation's actual state. This continuation grants no additional authority. Another check must fit the original wait deadline.`,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    wakeups.reset();
  });
  pi.on("session_shutdown", () => {
    wakeups.reset();
    context = undefined;
  });
  pi.on("session_tree", () => wakeups.stop());
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc")
      wakeups.userInput();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    context = ctx;
    wakeups.runStarted();
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    wakeups.runStarted();
  });
  pi.on("agent_settled", (event, ctx) => {
    context = ctx;
    // Missing abort information must never turn a stopped run into an automatic continuation.
    wakeups.runSettled(!("aborted" in event) || event.aborted !== false);
  });

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule wakeup",
    description:
      "Schedule one session-local follow-up for approved work, then yield. Only one wakeup may be pending. Delays are 60–3600 seconds. All checks retain the initial wait deadline (one hour by default, at most 24 hours). Cancellation, abort, session/branch changes, reload, and exit stop future wakeups.",
    promptSnippet:
      "Schedule a bounded one-shot check and yield until it becomes due",
    promptGuidelines: [
      "Use a scheduled wakeup when an approved operation needs a later check and no background completion event already provides one. Do not sleep in a foreground tool to poll.",
      "Identify the exact operation in the prompt, finish the current turn after scheduling, and verify authoritative state when resumed.",
      "A wakeup is not proof of success or new authorization. Do not use automated turns to bypass cancellation or renew a wait deadline.",
    ],
    parameters: Type.Object({
      delaySeconds: Type.Integer({
        minimum: 60,
        maximum: 3600,
        description:
          "Delay before checking; the due time must precede the wait deadline.",
      }),
      prompt: Type.String({
        minLength: 1,
        maxLength: 8192,
        description: "The follow-up check for the exact approved operation.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: 512,
        description: "Why another check is needed.",
      }),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 61,
          maximum: 86400,
          description:
            "Initial wait budget, default 3600 seconds. Must exceed the first delay; cannot renew a previous budget.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted)
        throw new Error("Cannot schedule from an aborted tool call.");
      context = ctx;
      return result(wakeups.schedule(params));
    },
  });
  pi.registerTool({
    name: "list_wakeups",
    label: "List wakeups",
    description:
      "Inspect the session's pending wakeup and retained wait deadline. Times are Unix milliseconds. State is not persisted across reload or exit.",
    parameters: Type.Object({}),
    async execute() {
      return result(wakeups.inspect());
    },
  });
  pi.registerTool({
    name: "cancel_wakeup",
    label: "Cancel wakeup",
    description:
      "Cancel an exact pending wakeup ID. Automatic rearming remains blocked until fresh real user input. A turn already dispatched cannot be retracted.",
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: "Pending ID returned by schedule_wakeup or list_wakeups.",
      }),
    }),
    async execute(_id, params) {
      return result(wakeups.cancel(params.id));
    },
  });
}

function result(state: WakeupState) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
    details: state,
  };
}
