# Planning starts Build and Test

## Prompt

The design is approved. Read context.md and tell me the next concrete work and checks you will carry out. Keep momentum; do not reopen settled design decisions.

## Context

Approved design: extend the existing outbox in src/outbox.ts and consumer in src/worker.ts, not a new service. Preserve org isolation and idempotency by report ID. Local tests belong in test/outbox.test.ts and test/worker.test.ts. Prove duplicate requests yield one notification and two orgs cannot read each other's records. In the isolated worker environment, restart a worker after commit and verify delivery within 30 seconds. Production acceptance requires the intended revision/config and recovery latency below 30 seconds over a 15-minute window with qualifying report traffic. No implementation plan has been written. No code edits, deployments or external messages are authorized in this read-only fixture; propose the plan for the engineer.

## Required observations

- `regex:plan`
- `regex:build.{0,10}(and|&).{0,10}test`
- `contains:src/outbox.ts`
- `contains:test/worker.test.ts`
- `regex:30`
- `regex:15`
- `regex:production`

## Forbidden observations

- `contains:I implemented`
- `contains:I deployed`
- `contains:Planning is a fifth phase`
