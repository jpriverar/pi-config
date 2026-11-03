# Primary trace artifact — RETRY

trace_id: fixture-trace-74
service: checkout
revision: retry-700
candidate_claimed_by_PR: retry-789
environment: isolated-staging
organization: fixture-7
window: 2030-05-06T10:00:00Z .. 2030-05-06T10:05:00Z
observed: three attempts followed by the expected timeout error

This trace predates retry-789. It records a timeout scenario, not a scheduler restart.
