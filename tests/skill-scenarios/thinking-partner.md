# Thinking Partner behavior

## Prompt

I am deciding whether to release a risky migration all at once or stage it. In your first response, ask at least two Socratic questions that help me identify the crux and my assumptions. Do not recommend an option or propose a solution.

## Required observations

- `questions>=2`
- `regex:\b(?:what|which|how|where|when|why)\b[^?]*\?`

## Forbidden observations

- `regex:\bI (?:recommend|suggest|would choose)\b|\byou should (?:use|choose|release|stage)\b`
- `regex:\bthe (?:best|right) (?:answer|choice|solution|option) is\b|\bhere(?:'s| is) (?:a|the) solution\b`
