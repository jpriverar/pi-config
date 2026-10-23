import { randomUUID } from "node:crypto";

export interface WakeupRequest {
  delaySeconds: number;
  prompt: string;
  reason: string;
  timeoutSeconds?: number;
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
  private budget?: { deadline: number; seconds: number };
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private settled = true;

  constructor(private readonly host: WakeupHost) {}

  schedule(request: WakeupRequest): WakeupState {
    this.expire();
    if (this.status === "cancelled" || this.status === "expired") {
      throw new Error(
        `Wait is ${this.status}; fresh user input is required to schedule again.`,
      );
    }
    if (this.pending)
      throw new Error(`Wakeup ${this.pending.id} is already pending.`);
    integer(request.delaySeconds, 60, 3600, "delaySeconds");
    boundedText(request.prompt, 8192, "prompt");
    boundedText(request.reason, 512, "reason");
    if (request.timeoutSeconds !== undefined) {
      integer(request.timeoutSeconds, 61, 86400, "timeoutSeconds");
      if (this.budget && request.timeoutSeconds !== this.budget.seconds) {
        throw new Error(
          `timeoutSeconds cannot renew deadline ${new Date(this.budget.deadline).toISOString()}.`,
        );
      }
    }
    const now = Date.now();
    const budget = this.budget ?? {
      seconds: request.timeoutSeconds ?? 3600,
      deadline: now + (request.timeoutSeconds ?? 3600) * 1000,
    };
    const dueAt = now + request.delaySeconds * 1000;
    if (dueAt >= budget.deadline) {
      throw new Error(
        `delaySeconds=${request.delaySeconds} must fit before deadline ${new Date(budget.deadline).toISOString()}; initial timeout must exceed delay.`,
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
    this.expire();
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
    this.expire();
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
      Math.min(delay ?? pending.dueAt - now, pending.deadline - now),
    );
    this.timer = setTimeout(() => {
      if (this.epoch !== epoch || this.pending !== pending) return;
      this.timer = undefined;
      this.tick();
    }, remaining);
  }

  private tick(): void {
    this.expire();
    const pending = this.pending;
    if (!pending) return;
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

  private expire(): void {
    if (
      !this.budget ||
      Date.now() < this.budget.deadline ||
      this.status === "expired" ||
      this.status === "cancelled"
    )
      return;
    const pending = this.pending;
    this.clearTimer();
    this.pending = undefined;
    this.status = "expired";
    this.changed();
    if (pending)
      this.host.notify(
        `Wakeup ${pending.id} expired at its wait deadline; no further check will run.`,
      );
  }
}

function integer(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name}=${String(value)} must be an integer between ${min} and ${max}.`,
    );
  }
}

function boundedText(value: string, max: number, name: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(
      `${name} must contain nonempty text of at most ${max} characters; received ${typeof value === "string" ? value.length : "non-string"}.`,
    );
  }
}
