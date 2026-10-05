// Which `/-/api/` statuses a page check counts as failures (pure, so the
// launcher's Deno tests cover it; support/page.ts applies it in the page).

/** A status a test expects on a path (`allowed` in `expectApiClean`). */
export type Expected = { readonly path: RegExp; readonly status: number };

export const BAD_STATUS: readonly number[] = [404, 405, 500, 501, 502, 503];

/**
 * Not-found answers the API documents as "nothing yet", which the SPA asks
 * for on purpose: a lane's repository-config preview is 404 until the lane
 * touches a root `.cue` file (web/src/api/client.ts `repoConfig.lane`,
 * src/kernel/repoconfig/http.ts), and every change page asks for it; a
 * repo's projects are 404 while projects are off on the forge
 * (src/kernel/projects/api.ts), and every repo home's projects card asks.
 */
export const DESIGNED_NOT_FOUND: readonly Expected[] = [
	{ path: /^\/-\/api\/repos\/[^/]+\/lanes\/[^/]+\/config$/, status: 404 },
	{ path: /^\/-\/api\/repos\/[^/]+\/projects$/, status: 404 },
];

/** `<status> <path>` of every request that failed, unless `allowed` or `DESIGNED_NOT_FOUND` expects it. */
export const failedRequests = (
	requests: readonly { readonly path: string; readonly status: number }[],
	allowed: readonly Expected[] = [],
): string[] =>
	requests
		.filter((r) =>
			BAD_STATUS.includes(r.status) &&
			![...DESIGNED_NOT_FOUND, ...allowed].some((a) =>
				a.status === r.status && a.path.test(r.path)
			)
		)
		.map((r) => `${r.status} ${r.path}`);

/**
 * `check`, or its error with the page's failed requests appended (when it
 * has any; reading them never hides the original error).
 */
export const withFailedRequests = async <T>(
	check: () => Promise<T>,
	requests: () => Promise<
		readonly { readonly path: string; readonly status: number }[]
	>,
): Promise<T> => {
	try {
		return await check();
	} catch (error) {
		const bad = failedRequests(await requests().catch(() => []));
		if (bad.length === 0) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}\nAPI requests that failed on this page: ${bad.join(", ")}`,
			{ cause: error },
		);
	}
};
