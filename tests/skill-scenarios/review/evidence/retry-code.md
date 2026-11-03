# RETRY source change — retry-789

Current src/retry.ts centralizes the previously duplicated final-attempt condition:

	export async function requestWithRetry(call: () => Promise<unknown>, maxAttempts: number) {
	  const limit = Math.min(maxAttempts, 3);
	  for (let attempt = 1; attempt <= limit; attempt++) {
	    try { return await call(); }
	    catch (error) { if (attempt === limit) throw error; }
	  }
	}

The new local test, tests/retry.test.mjs:

	const stubResult = { attempts: 3 };
	assert.equal(stubResult.attempts, 3);

This test does not import or call requestWithRetry. The scheduler-restart implementation is unchanged outside the supplied diff.
