# Primary CI artifact — LIMIT

run: fixture-limit-71
head: limit-123
command: node --test tests/limit.test.mjs
The tests import parseLimit from src/limit.ts (not a stub).

PASS accepts 1 and 100
PASS accepts 007 as 7
PASS rejects empty input
PASS rejects 0 and 101
PASS rejects 7abc
PASS rejects +7 and -7
PASS rejects spaces and trailing newline
PASS rejects non-ASCII digits
8 tests, 8 passed, 0 skipped; exit 0.
