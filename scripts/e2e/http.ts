// Every HTTP request the launcher makes is bounded. `timedFetch` wraps a
// fetch with a deadline that covers the whole exchange, response body
// included (aborting the signal also aborts the body stream), so a request
// that never ends fails with the method and path it was waiting for instead
// of stalling the launcher before teardown.
//
// The error names the method and the path only: never the query (a login
// start carries an invite code), a header or a body.

/** One launcher request, headers and body, at most this long. */
export const LAUNCHER_FETCH_TIMEOUT_MS = 30_000;
/** `POST /-/health/warm` starts the runner container (deploy allows 2 min). */
export const WARM_TIMEOUT_MS = 120_000;

export class FetchTimeoutError extends Error {
	override name = "FetchTimeoutError";
}

const describe = (input: string | URL | Request, init?: RequestInit) => {
	const method = (init?.method ??
		(input instanceof Request ? input.method : "GET")).toUpperCase();
	let path = "?";
	try {
		path = new URL(input instanceof Request ? input.url : String(input))
			.pathname;
	} catch {
		// Not a URL: keep "?".
	}
	return `${method} ${path}`;
};

/** `inner` with a deadline of `ms` for each call (`init.signal` still applies). */
export const timedFetch = (
	inner: typeof fetch,
	ms: number = LAUNCHER_FETCH_TIMEOUT_MS,
): typeof fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const deadline = AbortSignal.timeout(ms);
		const signal = init?.signal
			? AbortSignal.any([init.signal, deadline])
			: deadline;
		try {
			return await inner(input, { ...init, signal });
		} catch (error) {
			if (deadline.aborted) {
				throw new FetchTimeoutError(
					`${describe(input, init)}: no answer after ${ms / 1000} s`,
				);
			}
			throw error;
		}
	}) as typeof fetch;
