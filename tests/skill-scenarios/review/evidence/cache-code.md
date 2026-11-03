# CACHE source change — cache-456

Before: key = tenantId + ':' + invoiceId.
After, src/invoices.ts:

	export async function getInvoice(tenantId: string, invoiceId: string) {
	  const hit = cache.get(invoiceId);
	  if (hit) return hit;
	  const invoice = await findForTenant(tenantId, invoiceId);
	  if (invoice) cache.set(invoiceId, invoice);
	  return invoice;
	}

The route obtains tenantId from the authenticated session. Cache misses use findForTenant, which rejects another tenant's invoice. The hit path has no additional ownership check. This change also adds an identity wrapper and a one-field options bag; no additional behavior is introduced by those.
