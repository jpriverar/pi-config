# Verification

Choose the smallest proof that covers the changed behavior and the repository's
requirements. Deployment health and feature behavior are separate claims.

## Define the proof before an expensive run

Identify the expected behavior, supported execution path, and evidence that would
establish it. Check the relevant prerequisites together:

- Service, environment, organization/region, revision and feature targeting.
- Request routing, required data, and compatible downstream builds.
- Permissions for side effects and how temporary resources/settings are restored.

Use the existing repository-appropriate validation, deployment and telemetry
mechanisms. An isolated test environment can still have real external effects.
Deployment, activation, database writes and external messages each remain subject
to their actual authorization; approval to inspect does not authorize them.

For integration builds, verify inclusion of the intended change rather than
requiring exact SHA equality. Use authoritative deployment/targeting evidence,
not a merge date or a feature flag's global label alone.

## Run, classify, and keep the evidence honest

Record the relevant revision, target, observation window and result:

| Result            | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| Proven            | The specified behavior was exercised or observed with supporting evidence.       |
| Failed            | The observed behavior contradicted the assertion; identify the failing boundary. |
| Blocked           | A prerequisite prevents the proof; name what must change and the next actor.     |
| Not exercised     | This case has no adequate evidence, even if other checks passed.                 |
| Explicitly waived | The user accepted a specific gap/risk for a stated scope. Preserve the decision. |
| Not applicable    | This deliverable does not need this proof; explain why.                          |

A healthy service, completed agent session, or lack of traffic is not proof that
the feature ran. Local coverage of one case does not establish every live case.

Classify a failure before retrying. Inspect the failing stage and what changed;
respect existing retry limits. Do not switch to a different path that cannot
prove the original behavior and call it progress. Reassess repeated friction
instead of accumulating workarounds.

## When staging or rollout is unavailable

Report the exact missing proof. Continue independent approved work; otherwise
propose waiting, a valid alternative proof, or a specific user-approved exception.
Neither an environment problem nor a waiver grants merge/deployment authority.

Carry agreed missing runtime proof into the existing task or an approved,
independently meaningful verification task. There is no mandatory production task
for a local tool or a PR-only deliverable. See
[handoff and communication](handoff-and-communication.md).

On resume after a code change, redeployment, or long wait, reassess evidence
freshness. A replaced staging build or changed dependency can invalidate an older
success. Recheck affected assertions and revisit exceptions whose risk changed.
A timer becoming due means recheck the environment, not that deployment occurred.
