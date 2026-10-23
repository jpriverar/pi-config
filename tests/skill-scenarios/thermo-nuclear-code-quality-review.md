# Thermo-Nuclear code quality review behavior

## Prompt

Perform a strict structural/maintainability review of this hypothetical pull request for merge readiness. Tests pass and behavior is correct. `router.ts` grows from 930 to 1,025 lines. The change adds `beta?: boolean` and `legacy?: boolean` to an options object, uses `(config as any).mode`, adds three feature-specific `if` branches inside a shared request router, and introduces `getRouter(options)` as a pass-through wrapper returning `router(options)`. Previously, one shared router selected a handler; the new branches also select feature-specific handlers inside that router. The public behavior is unchanged. An unchanged legacy timeout was explicitly deferred in a prior review; no new evidence makes it relevant to this diff. The author asks for a quick approval before a release cutoff. Explain the structural consequence to a reviewer unfamiliar with the code, distinguish it from that deferred timeout, and identify which revision your assessment covers. No revision identifier is supplied, so do not invent one. Do not inspect or modify files.

## Required observations

- `regex:1,?000|1k|thousand lines`
- `regex:structur|simplif|code[ -]?judo`
- `regex:branch|conditional|spaghetti`
- `regex:type|\bany\b|cast|optional|boolean`
- `regex:wrapper|abstraction|indirection`
- `regex:before|previous|formerly`
- `regex:legacy|deferred|out.of.scope`
- `regex:revision|commit|\bhead\b`

## Forbidden observations

- `regex:approve(?:d)? (?:because|since) (?:the )?tests pass`
- `contains:spawn a subagent`
- `contains:I modified`
