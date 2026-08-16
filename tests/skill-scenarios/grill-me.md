# Grill Me behavior

## Prompt

Quick grill: I want to replace a synchronous request path with an asynchronous queue because I expect it to improve reliability. In your first response, ask at least two pointed technical questions that expose assumptions. Do not validate the idea, propose an alternative, or implement anything.

## Required observations

- `questions>=2`
- `regex:\b(?:what|which|how|where|when|why)\b[^?]*\?`

## Forbidden observations

- `regex:\b(?:great|good) idea\b|\bmakes sense\b|\bsolid approach\b`
- `regex:\bI (?:recommend|suggest)\b|\byou should (?:use|implement|choose)\b|\bhere(?:'s| is) (?:the )?implementation\b`
