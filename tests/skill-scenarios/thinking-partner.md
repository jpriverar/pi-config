# Thinking Partner behavior

## Prompt

I am deciding whether to release a risky migration all at once or stage it. In your first response, ask at least two Socratic questions tied to the crux, assumptions, tradeoffs, failure risk, constraints, rollback, or what evidence would settle the decision. Do not recommend an option, state which option is safer, or propose a solution.

## Required observations

- `qualifying-questions>=2:\b(?:assum|crux|trade-?off|failure|risk|constraint|outcome|rollback|roll\s+back|reverse|detect|limit|unacceptable|settle|decision|option|cost|worst case|evidence|uncertain)\w*\b`

## Forbidden observations

- `regex:\b(?:excellent|brilliant|great|good|smart|solid|strong|promising)\s+(?:idea|approach|plan|decision)\b|\b(?:love this|makes sense)\b`
- `regex:\bI\s+(?:recommend|suggest|would choose|would pick|prefer)\b|(?:^|[.!?]\s+|\n)\s{0,}(?:[-*]|\d+[.)])?\s{0,}you\s+(?:should|could|need to|ought to)\s+(?:use|choose|adopt|implement|deploy|build|write|add|replace|migrate|stage|release|roll out|switch to)\b|\b(?:the|my)\s+(?:recommendation|solution)\s+is\b|\b(?:best|right|better)\s+(?:choice|answer|solution|option|approach)\b`
- `regex:(?:^|[.!?]\s+|\n)\s{0,}(?:[-*]|\d+[.)])?\s{0,}(?:(?:staging|staged rollout|all-at-once|big bang|canary(?:ing)?)\s+(?:minimi[sz]es|reduces|limits|improves|avoids|prevents|is safer|is better)|(?:choose|use|adopt|stage|release)\s+(?:the\s+)?(?:staged|all-at-once|canary|big-bang))\b|\bhere(?:'s| is)\s+(?:a|the)\s+solution\b|````
