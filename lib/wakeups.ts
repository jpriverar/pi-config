import { randomUUID } from "node:crypto";
import { resolveWakeupTiming, type WakeupTiming } from "./wakeup-time.js";

export interface WakeupRequest extends WakeupTiming {
  prompt: string;
  reason: string;
}

export interface PendingWakeup {
  id: string;
  dueAt: number;
  deadline: number;
  prompt: string;
  reason: string;
}

export interface WakeupState {
  status:
    | "ready"
    | "scheduled"
    | "checking"
    | "completed"
    | "cancelled"
    | "expired";
  deadline?: number;
  pending?: PendingWakeup;
}

export interface WakeupHost {
  canDeliver(): boolean;
  deliver(wakeup: PendingWakeup): void;
  changed(state: WakeupState): void;
  notify(message: string): void;
}

export class WakeupController {
  private status: WakeupState["status"] = "ready";
  private pending?: PendingWakeup;
  private budget?: { deadline: number; seconds: number; exhausted: boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private settled = true;

  constructor(private readonly host: WakeupHost) {}

  schedule(request: WakeupRequest): WakeupState {
    this.expireBudget();
    if (this.status === "cancelled" || this.status === "expired") {
      throw new Error(
        `Wait is ${this.status}; fresh user input is required to schedule again.`,
      );
    }
    if (this.pending)
      throw new Error(`Wakeup ${this.pending.id} is already pending.`);
    const now = Date.now();
    if (this.budget?.exhausted) {
      throw new Error(
        `Follow-up cutoff ${new Date(this.budget.deadline).toISOString()} has passed; fresh user input is required to schedule again.`,
      );
    }
    boundedText(request.prompt, 8192, "prompt");
    boundedText(request.reason, 512, "reason");
    const timing = resolveWakeupTiming(request, now);
    if (
      this.budget &&
      request.timeoutSeconds !== undefined &&
      timing.seconds !== this.budget.seconds
    ) {
      throw new Error(
        `timeoutSeconds cannot renew follow-up cutoff ${new Date(this.budget.deadline).toISOString()}.`,
      );
    }
    const budget = this.budget ?? {
      seconds: timing.seconds,
      deadline: timing.deadline,
      exhausted: false,
    };
    const { dueAt } = timing;
    if (dueAt >= budget.deadline) {
      throw new Error(
        `Due time ${new Date(dueAt).toISOString()} must fit before follow-up cutoff ${new Date(budget.deadline).toISOString()}; initial relative timeout must exceed delay.`,
      );
    }
    this.budget = budget;
    this.pending = {
      id: `wake-${randomUUID()}`,
      dueAt,
      deadline: budget.deadline,
      prompt: request.prompt,
      reason: request.reason,
    };
    this.status = "scheduled";
    this.arm();
    this.changed();
    return this.snapshot();
  }

  inspect(): WakeupState {
    this.expireBudget();
    return this.snapshot();
  }

  cancel(id: string): WakeupState {
    if (!this.pending || this.pending.id !== id) {
      throw new Error(`No pending wakeup with ID ${JSON.stringify(id)}.`);
    }
    this.stop();
    return this.snapshot();
  }

  userInput(): void {
    this.expireBudget();
    if (this.status === "scheduled" || this.status === "checking") return;
    this.budget = undefined;
    this.status = "ready";
    this.changed();
  }

  runStarted(): void {
    this.settled = false;
  }

  runSettled(aborted: boolean): void {
    this.settled = true;
    if (aborted) {
      this.stop();
      return;
    }
    if (this.status === "checking") {
      this.status = "completed";
      this.changed();
    }
    if (this.pending) this.arm();
  }

  stop(): void {
    this.clearTimer();
    this.pending = undefined;
    this.status = "cancelled";
    this.changed();
  }

  reset(): void {
    this.clearTimer();
    this.pending = undefined;
    this.budget = undefined;
    this.status = "ready";
    this.settled = true;
    this.changed();
  }

  private snapshot(): WakeupState {
    return {
      status: this.status,
      ...(this.budget ? { deadline: this.budget.deadline } : {}),
      ...(this.pending ? { pending: { ...this.pending } } : {}),
    };
  }

  private changed(): void {
    this.host.changed(this.snapshot());
  }

  private clearTimer(): void {
    this.epoch++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delay?: number): void {
    this.clearTimer();
    const pending = this.pending;
    if (!pending) return;
    const epoch = this.epoch;
    const now = Date.now();
    const remaining = Math.max(
      0,
      // Check wall time periodically so an elapsed-time timer cannot hide a clock jump.
      Math.min(delay ?? pending.dueAt - now, 60_000),
    );
    this.timer = setTimeout(() => {
      if (this.epoch !== epoch || this.pending !== pending) return;
      this.timer = undefined;
      this.tick();
    }, remaining);
  }

  private tick(): void {
    this.expireBudget();
    const pending = this.pending;
    if (!pending) return;
    if (Date.now() < pending.dueAt) {
      this.arm();
      return;
    }
    if (!this.settled || !this.host.canDeliver()) {
      this.arm(5000);
      return;
    }
    // Removing the pending entry before delivery prevents duplicate turn requests.
    this.clearTimer();
    this.pending = undefined;
    this.status = "checking";
    this.changed();
    try {
      this.host.deliver({ ...pending });
    } catch (error) {
      this.stop();
      const message = error instanceof Error ? error.message : String(error);
      this.host.notify(
        `Wakeup ${pending.id} delivery failed: ${message}. It will not be retried.`,
      );
    }
  }

  private expireBudget(): void {
    if (!this.budget) return;
    // A clock rollback must not reopen authority already observed as exhausted.
    this.budget.exhausted ||= Date.now() >= this.budget.deadline;
    if (
      !this.budget.exhausted ||
      this.pending ||
      this.status === "checking" ||
      this.status === "expired" ||
      this.status === "cancelled"
    )
      return;
    this.status = "expired";
    this.changed();
  }
}

function boundedText(value: string, max: number, name: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(
      `${name} must contain nonempty text of at most ${max} characters; received ${typeof value === "string" ? value.length : "non-string"}.`,
    );
  }
}
