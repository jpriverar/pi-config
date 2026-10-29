import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskLifecycleService } from "../lib/task-lifecycle/service.js";
import {
  fixture,
  session,
} from "../lib/task-lifecycle/v2-service-test-fixtures.js";
import {
  state,
  withCheck,
  OWNER,
  NOW,
} from "../lib/task-lifecycle/v2-test-fixtures.js";
import {
  blockLifecycleV2,
  fingerprintConditionV2,
} from "../lib/task-lifecycle/v2-model.js";
import { registerGitArtifactHooks } from "../extensions/task-lifecycle/git-artifact-hooks.js";

const current = withCheck();
const paused = blockLifecycleV2(current, {
  operationId: "pause",
  sessionId: OWNER.sessionId,
  now: NOW,
  reason: "Await response",
  conditionFingerprint: fingerprintConditionV2(current, [])!,
});
const phases = [
  paused,
  state({ phase: "actionable", owner: OWNER }),
  state({ phase: "deferred", owner: OWNER }),
  state({
    phase: "done",
    owner: OWNER,
    disposition: {
      kind: "completed",
      reason: "Delivered",
      at: NOW,
      evidenceArtifactIds: [],
    },
  }),
];

for (const original of phases) {
  test(`fresh runtime preserves ${original.phase} ownership, rejects a second claim and gives forks no execution authority`, async (t) => {
    const f = await fixture(t, [
      { id: "jp-held", lifecycle: original },
      { id: "jp-next", lifecycle: state() },
    ]);
    const restarted = new TaskLifecycleService({
      store: f.store,
      lifecycleWriteVersion: 2,
      now: () => Date.parse(NOW) + 30 * 86400_000,
      uuid: () => "restart",
      executionTimeoutMs: 1000,
    });
    await restarted.refreshSessionActivity(session());
    assert.equal(
      (await f.store.show("jp-held")).lifecycle?.phase,
      original.phase,
    );
    assert.deepEqual(
      (await restarted.ownedTasksForSession(OWNER.sessionId)).map((i) => i.id),
      ["jp-held"],
    );
    await assert.rejects(
      restarted.claim("jp-next", session(), "claim-next"),
      /already owns/,
    );
    assert.deepEqual(await restarted.activeTasksForSession("fork-session"), []);
    await assert.rejects(
      restarted.claim("jp-held", session("fork-session"), "claim-fork"),
      /owned|owner/,
    );
    assert.equal(
      (await restarted.claim("jp-held", session(), "claim-held")).lifecycle
        ?.phase,
      original.phase,
    );
  });

  test(`automatic artifact observation does not correlate an unrelated command to owned ${original.phase} work`, async (t) => {
    const f = await fixture(t, [{ id: "jp-held", lifecycle: original }]);
    const handlers = new Map<string, any>();
    let observations = 0;
    registerGitArtifactHooks(
      {
        on(event, handler) {
          handlers.set(event, handler);
        },
      },
      {
        service: f.sut,
        classifier: {
          classify: () => [
            {
              kind: "git-head",
              operation: "commit",
              cwd: "/repo",
              ref: "HEAD",
            },
          ],
        },
        observer: {
          observe: async () => {
            observations++;
            return [];
          },
        },
      },
    );
    const context = {
      cwd: "/repo",
      sessionManager: { getSessionId: () => OWNER.sessionId },
    };
    const call = {
      toolName: "bash",
      toolCallId: "commit",
      input: { command: "git commit -m unrelated" },
    };
    await handlers.get("tool_call")(call, context);
    await handlers.get("tool_result")({ ...call, isError: false }, context);
    assert.equal(observations, 0);
    assert.deepEqual(f.writes, []);
  });
}
