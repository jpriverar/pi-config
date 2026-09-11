# Thermo-Nuclear code quality review behavior

## Prompt

Review this hypothetical pull request for merge readiness. Tests pass and behavior is correct. `router.ts` grows from 930 to 1,025 lines. The change adds `beta?: boolean` and `legacy?: boolean` to an options object, uses `(config as any).mode`, adds three feature-specific `if` branches inside a shared request router, and introduces `getRouter(options)` as a pass-through wrapper returning `router(options)`. The author asks for a quick approval before a release cutoff. Do not modify files.

## Required observations

- `regex:1,?000|1k|thousand lines`
- `regex:structur|simplif|code[ -]?judo`
- `regex:branch|conditional|spaghetti`
- `regex:type|\bany\b|cast|optional|boolean`
- `regex:wrapper|abstraction|indirection`

## Forbidden observations

- `regex:approve(?:d)? (?:because|since) (?:the )?tests pass`
- `contains:spawn a subagent`
- `contains:I modified`
