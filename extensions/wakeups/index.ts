import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WakeupController, type WakeupState } from "../../lib/wakeups.js";
import { createWakeupPresentation, wakeupTime } from "./presentation.js";

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
  const presentation = createWakeupPresentation(pi);
  const wakeups = new WakeupController({
    canDeliver: () =>
      Boolean(context?.isIdle() && !context.hasPendingMessages()),
    changed: (state) => {
      presentation.update(state, context);
      const item = state.pending;
      context?.ui.setStatus(
        "scheduled-wakeup",
        item ? `${item.id}: due ${wakeupTime(item.dueAt)}` : undefined,
      );
    },
    notify: (message) => context?.ui.notify(message, "warning"),
    deliver: (item) => {
      pi.sendMessage(
        {
          customType: "scheduled-wakeup",
          display: true,
          details: item,
          content: `Scheduled check ${item.id}, continuing previously approved work—not new user input.\nReason: ${item.reason}\nDue: ${new Date(item.dueAt).toISOString()}\nFollow-up cutoff (not delivery expiry): ${new Date(item.deadline).toISOString()}\n\n${item.prompt}\n\nVerify the operation's actual state. This continuation grants no additional authority. Another check must fit the original follow-up cutoff; if it has passed, do not automatically rearm.`,
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
    presentation.update(wakeups.inspect(), ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    wakeups.runStarted();
    presentation.update(wakeups.inspect(), ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    context = ctx;
    // Missing abort information must never turn a stopped run into an automatic continuation.
    wakeups.runSettled(!("aborted" in event) || event.aborted !== false);
    presentation.update(wakeups.inspect(), ctx);
  });

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule wakeup",
    description:
      "Schedule one session-local, one-shot check for approved work, then yield. Choose exactly one: delaySeconds (60–3600) or at (timezone-qualified timestamp, 60 seconds–7 days ahead). Only one alarm may be pending. Overdue alarms wait for an available session; the retained deadline limits additional checks, not pending delivery. Cancellation, abort, session/branch changes, reload, and exit cancel pending alarms.",
    promptSnippet:
      "Schedule a relative or absolute session-local alarm and yield",
    promptGuidelines: [
      "Use a scheduled wakeup when an approved operation needs a later check and no background completion event already provides one. Do not sleep in a foreground tool to poll.",
      "Identify the exact operation in the prompt, finish the current turn after scheduling, and verify authoritative state when resumed.",
      "A wakeup is not proof of success or new authorization. An overdue alarm may run after its follow-up cutoff, but must not automatically rearm after it. Do not use automated turns to bypass cancellation or renew the cutoff.",
    ],
    parameters: Type.Object({
      delaySeconds: Type.Optional(
        Type.Integer({
          minimum: 60,
          maximum: 3600,
          description:
            "Relative delay. Provide this or at, never both; due time must precede the follow-up cutoff.",
        }),
      ),
      at: Type.Optional(
        Type.String({
          minLength: 20,
          maxLength: 64,
          description:
            "Absolute target, 60 seconds–7 days ahead: YYYY-MM-DDTHH:mm:ss[.sss] with Z or an explicit offset such as +02:00. Provide this or delaySeconds, never both.",
        }),
      ),
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
            "Initial follow-up budget, default 3600 seconds. Relative: starts now and must exceed delaySeconds. Absolute: starts at the target time. Further checks retain the cutoff: omit this field or repeat its initial value. Does not expire a pending alarm.",
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
      "Inspect the session's pending alarm and follow-up cutoff (deadline). Times are Unix milliseconds. Scheduled includes overdue alarms; expired describes an exhausted cutoff without a pending alarm. Checking/completed describe the continuation, not the watched operation. No state persists across reload or exit.",
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
