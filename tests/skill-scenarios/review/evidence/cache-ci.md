# Primary CI artifact — CACHE

run: fixture-cache-72
head: cache-456
command: node --test tests/invoices.test.mjs
PASS repeat reads by the same tenant
PASS cache miss rejects an invoice belonging to another tenant
2 tests, 2 passed, 0 skipped; exit 0.

No test warms the cache as tenant A and then reads the same invoice as tenant B.
