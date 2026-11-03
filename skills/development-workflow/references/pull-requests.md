# PR evidence and review environments

A PR connects intent to observed results and gives another reviewer enough context
to repeat the checks. The parent owns the review environment's lifetime across
validation, review, release and handoff—not the specialist that ran one check.

## Required PR content

Use this shape when creating or updating a PR, including drafts. Preserve required
repository fields, automation markers and human-authored context; integrate these
contents into equivalent repository headings instead of duplicating them. Keep
small changes small: no mandatory criterion IDs or resource inventory table.

```markdown
## Intent and success criteria

Why this matters; previous → intended behavior and observable success criteria.

## Changes

How the change achieves the intent; scope/non-goals and related PRs when useful.

## Validation

Tested: <commit/build> · <environment>. Include relevant configuration and a UTC
observation window when using live telemetry.

| Behavior / check                        | Result                          | Evidence                                            |
| --------------------------------------- | ------------------------------- | --------------------------------------------------- |
| <Intended behavior or meaningful check> | <Actual observation and status> | <Exact command, CI run, trace/log or linked report> |

## Try it yourself

Short prose or bullets: how to reproduce; any available test-drive/build and its
revision, last-checked availability, actual expiry and cleanup condition. Include
extra prerequisites or a different owner only when needed.

## Gaps and risks

Missing proof, failures, limitations and explicit waivers; next action if needed.

## Rollout and cleanup

Applicable remaining production checks, release dependencies, recovery and
resource disposition.
```

One validation row per meaningful behavior/check, not every test case. Account
for every success criterion with evidence or an explicit gap. State shared scope
once and identify row-specific differences. Put long commands and queries in a
code block below the table or a linked artifact; escape literal pipes in cells.
State “none” or “not applicable” with a reason where appropriate. A change needing
no live environment should provide a reproduction command or explain why further
verification is inapplicable, not invent a test-drive.

## Keep evidence independently inspectable

- Name the intended behavior in the check and the actual observation in the
  result. Use the [verification classifications](verification.md) for gaps and
  exceptions. Drafts can have pending checks; waivers are not passes.
- Bind results to the tested revision/build and relevant environment,
  configuration/cohort and time window. A trace/log link needs the observation
  supporting the claim and enough query/identity/time context to retrieve it.
  Green CI or deployment health alone does not prove the changed behavior.
- Preserve useful sanitized results in durable, reviewer-accessible PR-linked
  evidence before deleting transient run directories. Author-local paths or
  expiring telemetry links alone are not sufficient for remote review. Preserve
  access controls; never publish credentials or unnecessary sensitive payloads.
- Refresh affected evidence after code/configuration changes and recheck resource
  availability before offering reuse. Label historical results by revision; do
  not imply that they validate a newer candidate. After publishing or updating
  the body, read it back to verify the contents and links were retained.

## Retain and reuse the review environment

Before provisioning or delegating validation, inspect existing resources and
establish their retention/cleanup disposition. Pass that disposition to any
already-authorized specialist; use the platform's supported keep/skip-cleanup
option when retaining an environment. A completed test, child assignment or
session is not teardown permission.

- **While the PR is open:** retain useful review environments. Before reuse or
  update, check actual availability, deployed revision, configuration/routing and
  concurrent use. Coordinate with users before replacing their build; matching
  names alone do not establish compatibility. Reuse a suitable environment rather
  than automatically provisioning another.
- **At merge or explicit closure/abandonment:** confirm that no agreed verification
  or reviewer use still depends on the resource, then clean up within existing
  authority. Merge alone is not a delete signal. A verified replacement can
  justify earlier retirement once existing users and dependencies are accounted
  for; record what replaces it.
- **At expiry or a safety/cost constraint:** report the actual limit and resolve
  the needed decision. Do not silently extend TTLs, leave unsafe traffic running,
  or promise indefinite availability. Mark expired/deleted/replaced resources
  accurately and preserve the evidence and recreation instructions.

Keep the relevant resource facts in “Try it yourself” and task-linked evidence:
revision/target, how to use it, last-checked state, actual expiry (or unknown), and
cleanup condition. The author owns cleanup unless a different owner is explicitly
identified. These facts need a short note, not a separate resource schema.

Release independent idle worktrees, finished pollers and disposable scaffolding
when safe and no consumer depends on them; retaining a deployed review environment
does not require retaining its checkout. Preserve evidence before discarding run
artifacts. A handoff retains responsibility or explicitly transfers it to a named
owner. Task closure accounts for cleanup or an explicitly accepted transfer or
other disposition; it does not leave an ownerless environment behind.
