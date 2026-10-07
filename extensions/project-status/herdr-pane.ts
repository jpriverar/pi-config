import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { MetadataSender } from "./herdr-transport.js";
import {
  runtimeTokens,
  taskTokens,
  type PaneTokens,
  type TaskAssignment,
} from "./herdr-values.js";

export interface PaneReporter {
  updateRuntime(ctx: ExtensionContext): void;
  updateTask(assignment: TaskAssignment): void;
  stop(): Promise<void>;
}

// A stable source must stay ordered across session replacement and reload.
let sequence = Date.now() * 1000;
const nextSequence = () =>
  (sequence = Math.max(sequence + 1, Date.now() * 1000));

export function createPaneReporter(options: {
  context: ExtensionContext;
  send: MetadataSender;
}): PaneReporter | undefined {
  if (options.context.mode !== "tui") return undefined;
  let desired: PaneTokens = {
    ...runtimeTokens(options.context.model, options.context.getContextUsage()),
    ...taskTokens({ state: "unavailable", label: "Task unavailable" }),
  };
  let delivered: string | undefined;
  let dirty = false;
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let activeSend: AbortController | undefined;
  let stopping: Promise<void> | undefined;

  function queue(): void {
    if (stopped) return;
    dirty = true;
    if (inFlight) return;
    inFlight = drain().finally(() => {
      inFlight = undefined;
      if (dirty && !stopped) queue();
    });
  }

  async function drain(): Promise<void> {
    while (dirty && !stopped) {
      dirty = false;
      const snapshot = { ...desired };
      const signature = JSON.stringify(snapshot);
      if (signature === delivered) continue;
      activeSend = new AbortController();
      const sent = await options
        .send(snapshot, nextSequence(), activeSend.signal)
        .catch(() => false);
      if (sent) delivered = signature;
      activeSend = undefined;
    }
  }

  const reporter: PaneReporter = {
    updateRuntime(ctx) {
      if (stopped) return;
      desired = {
        ...desired,
        ...runtimeTokens(ctx.model, ctx.getContextUsage()),
      };
      queue();
    },
    updateTask(assignment) {
      if (stopped) return;
      desired = { ...desired, ...taskTokens(assignment) };
      queue();
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      dirty = false;
      activeSend?.abort();
      stopping = (async () => {
        await inFlight;
        await options
          .send(
            {
              pi_model: null,
              pi_task: null,
              pi_task_state: null,
              pi_task_id: null,
              pi_task_expires_at: null,
              pi_context_warning: null,
              pi_context_critical: null,
            },
            nextSequence(),
            new AbortController().signal,
          )
          .catch(() => false);
      })();
      return stopping;
    },
  };
  queue();
  return reporter;
}
