# Explain a change without assuming code context

## Prompt

Explain this hypothetical PR to an experienced engineer who has not read the implementation. Callers only need a total. Previously, `getTotal` called `listIssues`, which applied the eligibility filter, loaded full records and their examples, then returned those records to be counted. The proposed `countEligible` endpoint applies the same eligibility filter and returns the total without loading records or examples. No performance measurements or deployment evidence are available. What changes for the caller, and what correctness risk should the reviewer check? Include a compact before/after flow. Use only these facts; do not inspect or modify files.

## Required observations

- `regex:before|previous|formerly|old path`
- `regex:after|now|proposed|new path`
- `regex:examples|sample records`
- `regex:count|total`
- `regex:eligib`
- `regex:→|->|⇒`
- `regex:not measured|unmeasured|no (?:performance )?measurements|not proven|not verified|unverified|not established`

## Forbidden observations

- `regex:^\s*(?:#+\s*)?\x60(?:getTotal|countEligible)\x60`
- `contains:I deployed`
- `contains:I modified`
- `regex:(?:is|was) (?:confirmed |measured )?\d+x faster`
