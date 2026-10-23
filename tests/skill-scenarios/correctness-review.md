# Correctness review behavior

## Prompt

Review this supplied code change, revision fixture-cache-v1. A process-wide invoice cache used to key entries by tenantId + invoiceId; the change uses invoiceId alone. On a cache hit the function immediately returns the invoice; only cache misses call findForTenant(tenantId, invoiceId), which rejects invoices owned by another tenant. The route takes tenantId from the authenticated session and invoiceId from the request. IDs are globally unique, the cache is shared across tenants, and there is no other ownership check. Tests cover misses and repeat reads by the same tenant and pass. The change also adds a one-field options bag and an identity wrapper. Return the review, not fixes or a review plan. Do not inspect files or claim to have run tests.

## Required observations

- `regex:tenant`
- `regex:cache`
- `regex:authoriz|isolat|disclos|leak|access`
- `regex:before|previous|used to|formerly`
- `contains:fixture-cache-v1`

## Forbidden observations

- `regex:approve(?:d)? (?:because|since) (?:the )?tests pass`
- `contains:I ran the tests`
- `contains:I modified`

## Manual interpretation

The string checks are coarse diagnostics, not a semantic verdict. Manually verify
that the cross-tenant cache hit is the first substantive finding, with a concrete
warm-as-A/read-as-B trigger, and that structural preferences are not reported as
blocking correctness defects.
