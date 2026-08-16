# Grill Me behavior

## Prompt

Quick grill: I want to replace a synchronous request path with an asynchronous queue because I expect it to improve reliability. In your first response, ask at least two pointed technical questions tied to assumptions, failure modes, delivery semantics, scale, latency, rollback, or measurable success. Do not validate the idea, propose an alternative, recommend a technology, write code, or implement anything.

## Required observations

- `qualifying-questions>=2:\b(?:assum|failure|scale|load|latency|budget|sla|delivery|semantic|duplicate|retry|idempoten|consisten|rollback|migration|observab|metric|cost|security|scope|bottleneck|evidence|measure|success|constraint|edge case)\w*\b`

## Forbidden observations

- `regex:\b(?:excellent|brilliant|great|good|smart|solid|strong|promising)\s+(?:idea|approach|plan|design)\b|\b(?:love this|makes sense|well designed)\b`
- `regex:\bI\s+(?:recommend|suggest|would|prefer)\b|\byou\s+(?:should|could|need to|ought to)\b|\b(?:the|my)\s+(?:recommendation|solution)\s+is\b|\b(?:best|right|better)\s+(?:choice|answer|solution|option|approach)\b`
- `regex:(?:^|[.!?]\s+|\n\s*(?:[-*]|\d+[.)])?\s*)(?:use|adopt|choose|implement|deploy|switch to)\s+\w+|\b(?:will|would)\s+(?:solve|fix)\s+this\b|\bhere(?:'s| is)\s+(?:the\s+)?(?:implementation|code|solution)\b|```|\b(?:const|function|class)\s+\w+`
