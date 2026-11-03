# Accepted scope and criteria

Review three independent fictional changes at their stated heads. Input schemas and routing are unchanged. Review stage: pre-merge. No merge, deployment, data mutation, environment changes or external posts are authorized. Only file-reading tools are available in this fixture; do not claim to execute commands.

## LIMIT — head limit-123
parseLimit receives a string of at most 12 characters from an already-validated route. Accept only nonempty ASCII digits whose numeric value is 1..100, and reject everything else. Leading zeroes are allowed. This pure function needs local regression proof; no live-service or production check is required.

## CACHE — head cache-456
Preserve invoice authorization on both cache misses and hits. The cache is process-wide and shared across tenants. Invoice IDs are globally unique, but knowing an ID does not authorize access. findForTenant checks ownership only when called. A concrete cross-tenant disclosure is a blocker. The new wrapper/options bag is not itself an agreed correctness defect.

## RETRY — head retry-789
Cap this layer's downstream-call attempts at three, including timeout errors. The input maxAttempts is validated as an integer 1..10 by unchanged code. Accepted pre-merge proof includes a candidate-specific live timeout scenario and an isolated scheduler-restart scenario (restart handling is unchanged outside this diff). Production observation is explicitly deferred until after authorized deployment; its current absence is not a pre-merge blocker. No runtime-proof gap has been waived.
