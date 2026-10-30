import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  ALLOCATION_HOOK_EVENT,
  ALLOCATION_CAPABILITY_EVENT,
  allocateWithHooks,
  requireAllocationCapability,
  registerAllocationCapability,
  type AllocationHook,
} from "./allocation-hook.js";
import type { AcquireResult } from "./pool.js";

const request = { repository: "repo", branch: "jpriverar/branch" };
const owner = { sessionId: "session", pid: 123, host: "host", started: 1 };
const receipt: AcquireResult = {
  claimId: "claim",
  path: "/pool/worktree-path",
  branch: request.branch,
  reused: false,
  head: "a".repeat(40),
  startPoint: "main",
  startPointHead: "a".repeat(40),
  startPointFetched: false,
  relationship: "equal",
};
function register(
  events: ReturnType<typeof createEventBus>,
  hook: AllocationHook,
) {
  events.on(ALLOCATION_HOOK_EVENT, (value: any) =>
    value.register({ version: 1, run: hook }),
  );
}

test("allocation remains independent when no extension participates", async () => {
  let calls = 0;
  assert.deepEqual(
    await allocateWithHooks(
      createEventBus(),
      "op",
      request,
      owner,
      async (identity) => {
        calls++;
        assert.equal(identity, undefined);
        return receipt;
      },
    ),
    receipt,
  );
  assert.equal(calls, 1);
});

test("native bus discovers a hook synchronously but awaits its policy and finalization", async () => {
  const events = createEventBus(),
    order: string[] = [];
  register(events, async (context) => {
    await Promise.resolve();
    order.push("prepared");
    const result = await context.allocate({ claimId: "claim", pathId: "path" });
    order.push("finalized");
    return result;
  });
  await allocateWithHooks(events, "op", request, owner, async (identity) => {
    assert.deepEqual(identity, { claimId: "claim", pathId: "path" });
    order.push("allocated");
    return receipt;
  });
  assert.deepEqual(order, ["prepared", "allocated", "finalized"]);
});

test("policy errors propagate outside the bus without unmanaged fallback", async () => {
  const events = createEventBus();
  let calls = 0;
  register(events, async () => {
    throw new Error("policy refused");
  });
  await assert.rejects(
    allocateWithHooks(events, "op", request, owner, async () => {
      calls++;
      return receipt;
    }),
    /policy refused/,
  );
  assert.equal(calls, 0);
});

for (const candidate of [
  { version: 2, run() {} },
  { version: 1, run: null },
]) {
  test(`incompatible allocation provider fails closed (${JSON.stringify(candidate)})`, async () => {
    const events = createEventBus();
    let calls = 0;
    events.on(ALLOCATION_HOOK_EVENT, (value: any) => value.register(candidate));
    await assert.rejects(
      allocateWithHooks(events, "op", request, owner, async () => {
        calls++;
        return receipt;
      }),
      /incompatible/,
    );
    assert.equal(calls, 0);
  });
}

test("multiple providers are rejected before either can allocate", async () => {
  const events = createEventBus();
  let calls = 0;
  register(events, (context) => context.allocate());
  register(events, (context) => context.allocate());
  await assert.rejects(
    allocateWithHooks(events, "op", request, owner, async () => {
      calls++;
      return receipt;
    }),
    /multiple/,
  );
  assert.equal(calls, 0);
});

test("one invocation cannot allocate twice", async () => {
  const events = createEventBus();
  let calls = 0;
  register(events, async (context) => {
    await context.allocate();
    return context.allocate();
  });
  await assert.rejects(
    allocateWithHooks(events, "op", request, owner, async () => {
      calls++;
      return receipt;
    }),
    /already/,
  );
  assert.equal(calls, 1);
});

test("capability discovery rejects absent, duplicate and incompatible peers", () => {
  const events = createEventBus();
  assert.throws(
    () => requireAllocationCapability(events),
    /unavailable|incompatible/,
  );
  registerAllocationCapability(events);
  assert.doesNotThrow(() => requireAllocationCapability(events));
  const remove = events.on(ALLOCATION_CAPABILITY_EVENT, (value: any) =>
    value.accept(2),
  );
  assert.throws(() => requireAllocationCapability(events), /incompatible/);
  remove();
  assert.doesNotThrow(() => requireAllocationCapability(events));
});
