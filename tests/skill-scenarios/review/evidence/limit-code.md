# LIMIT source change — limit-123

Previously parseLimit used parseInt(raw, 10), accepting trailing junk. Current src/limit.ts:

	export function parseLimit(raw: string): number {
	  if (raw.length === 0 || [...raw].some(c => c < '0' || c > '9')) {
	    throw new Error('invalid limit');
	  }
	  const value = Number(raw);
	  if (!Number.isInteger(value) || value < 1 || value > 100) {
	    throw new Error('limit out of range');
	  }
	  return value;
	}
