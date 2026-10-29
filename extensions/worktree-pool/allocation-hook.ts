import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { AcquireRequest, AcquireResult } from "./pool.js";
import type { OwnerIdentity } from "./operation-lock.js";

export type AllocationEventBus = Pick<EventBus, "emit"> &
  Partial<Pick<EventBus, "on">>;
export const ALLOCATION_HOOK_EVENT = "pi:worktree-allocation:v1";
export const ALLOCATION_CAPABILITY_EVENT =
  "pi:worktree-allocation-capability:v1";
export type AllocationIdentity = { claimId: string; pathId: string };
export type Allocate = (
  identity?: AllocationIdentity,
) => Promise<AcquireResult>;
export interface AllocationContext {
  operationId: string;
  request: Readonly<AcquireRequest>;
  owner: Readonly<OwnerIdentity>;
  allocate: Allocate;
}
export type AllocationHook = (
  context: AllocationContext,
) => Promise<AcquireResult>;

export function registerAllocationCapability(
  events?: AllocationEventBus,
): void {
  events?.on?.(ALLOCATION_CAPABILITY_EVENT, (value) => {
    if (isRecord(value) && typeof value.accept === "function") value.accept(1);
  });
}

export function requireAllocationCapability(events?: AllocationEventBus): void {
  const versions: unknown[] = [];
  events?.emit(ALLOCATION_CAPABILITY_EVENT, {
    accept: (version: unknown) => versions.push(version),
  });
  if (versions.length !== 1 || versions[0] !== 1)
    throw new Error(
      "worktree allocation boundary is unavailable or incompatible; reload compatible extensions before acquiring",
    );
}

export async function allocateWithHooks(
  events: AllocationEventBus | undefined,
  operationId: string,
  request: AcquireRequest,
  owner: OwnerIdentity,
  allocate: Allocate,
): Promise<AcquireResult> {
  const providers: unknown[] = [];
  // Bus listeners discover synchronously; policy errors must propagate outside its error-swallowing handlers.
  events?.emit(ALLOCATION_HOOK_EVENT, {
    register: (provider: unknown) => providers.push(provider),
  });
  if (providers.length > 1)
    throw new Error(
      "multiple worktree allocation providers; refusing allocation",
    );
  const provider = providers[0];
  if (
    providers.length === 1 &&
    (!isRecord(provider) ||
      provider.version !== 1 ||
      typeof provider.run !== "function")
  )
    throw new Error(
      "incompatible worktree allocation provider; refusing allocation",
    );
  let called = false;
  const once: Allocate = (identity) => {
    if (called)
      throw new Error(`worktree allocation ${operationId} was already invoked`);
    called = true;
    return allocate(identity);
  };
  if (!isRecord(provider)) return once();
  const run = provider.run as AllocationHook;
  return run({
    operationId,
    request: Object.freeze({ ...request }),
    owner: Object.freeze({ ...owner }),
    allocate: once,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
