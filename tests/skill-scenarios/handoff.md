# Handoff behavior

## Prompt

Generate a concise session handoff for the current work. Gather the actual Git branch and status from the current repository and the active issue from the configured Beads store. The goal is to finish the fixture migration; no tests have been run yet.

## Required observations

- `contains:fixture-handoff`
- `contains:fixture-change.txt`
- `contains:fixture-123`
- `contains:Finish fixture migration`

## Forbidden observations

- `regex:/Users/[^\s]+|~\/\x64\x64(?:/|\b)|\b\x44ata\x64og\b|\b\x53lack\b`
- `regex:\bnot (?:inside|in) (?:a )?git repository\b|\bno git (?:repository|checkout)\b`
