// Page-level checks shared by the suites (they need the e2e runtime):
//
// - `expectSlotsSettled`: the "settled slots" rule. It counts the slot
//   instances the page must render (from `/-/api/view`, fetched in the page
//   with the persona's own session) and waits for exactly that many
//   `section[data-slot]` hosts first, then for none to be busy or loading,
//   then for no host error chip. Counting a known positive first stops a
//   premature "zero chips" from passing before the slots mount. A failure
//   lists the chips' text, e.g. `tartan.weave: invalid ctx`.
// - `watchApi` / `expectApiClean`: every `/-/api/` request the page made,
//   from Chromium's `PerformanceResourceTiming.responseStatus`; none may end
//   in 404, 405 or 5xx unless the test declares it (admin routes 404/501).
// - `spaNavigate`: in-view navigation through the SPA's own router (what a
//   link inside the page does), for the in-view navigation checks.
// - `signInAtIdp`: the mock IdP's form, after checking the browser is on
//   the mock IdP's `/authorize` before any password is filled.

import type { Browser } from "@e2e-dev/web";
import { credentials, expect, type Screen } from "e2e";
import type { ViewResponse } from "@tartan/contract/api.ts";
import {
	type Expected,
	failedRequests,
	withFailedRequests,
} from "./api-status.ts";
import { ok, pageApi, query } from "./http.ts";
import type { Persona } from "./stage.ts";
import { instanceCount, type Rendered } from "./view.ts";

export const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A URL pattern for `origin` + `pathname`, with an optional query. */
export const urlOf = (origin: string, pathname: string): RegExp =>
	new RegExp(`^${escapeRegExp(origin)}${escapeRegExp(pathname)}(?:[?#].*)?$`);

/** `/-/api/view` for a node and view, with the page's own session. */
export const viewOf = async (
	browser: Browser,
	nodePath: string,
	view: string,
): Promise<ViewResponse> => {
	const at = `/-/api/view?${query({ path: nodePath, view })}`;
	return ok("GET", "/-/api/view", await pageApi(browser).get<ViewResponse>(at));
};

export const SLOT_HOST = "section[data-slot]";

/** The settled-slot rule for a page that mounts `rendered` (see the header). */
export const expectSlotsSettled = async (
	browser: Browser,
	view: ViewResponse,
	rendered: readonly Rendered[],
	options: { readonly timeout?: number } = {},
): Promise<number> => {
	const timeout = options.timeout ?? 20_000;
	const n = instanceCount(view.slots, rendered);
	await expect(browser.locator(SLOT_HOST)).toHaveCount(n, { timeout });
	await expect(browser.locator(`${SLOT_HOST}[aria-busy="true"]`))
		.toHaveCount(0, { timeout });
	await expect(browser.locator(`${SLOT_HOST} > .slot-host__loading`))
		.toHaveCount(0, { timeout });
	await expect(browser.locator(`${SLOT_HOST} > p.chip--danger`)).toHaveText(
		[],
		{ timeout: 1_000 },
	);
	return n;
};

/** Starts the resource-timing record of this document (call after `app.open`). */
export const watchApi = async (browser: Browser): Promise<void> => {
	await browser.evaluate(() => {
		performance.setResourceTimingBufferSize(1000);
		return null;
	});
};

/** Every `/-/api/` request of this document with its status. */
export const apiRequests = (
	browser: Browser,
): Promise<{ path: string; status: number }[]> =>
	browser.evaluate(() =>
		performance.getEntriesByType("resource")
			.map((e) => ({
				url: new URL(e.name),
				status: (e as unknown as { responseStatus?: number }).responseStatus ??
					0,
			}))
			.filter((e) =>
				e.url.origin === location.origin &&
				e.url.pathname.startsWith("/-/api/")
			)
			.map((e) => ({ path: e.url.pathname, status: e.status }))
	);

/** No `/-/api/` request of this document ended in 404, 405 or 5xx, except `allowed`. */
export const expectApiClean = async (
	browser: Browser,
	allowed: readonly Expected[] = [],
): Promise<void> => {
	const bad = failedRequests(await apiRequests(browser), allowed);
	expect(bad, "API requests that failed on this page").toEqual([]);
};

/**
 * Runs a page check; if it fails, the error names every `/-/api/` request
 * of the document that ended in 404, 405 or 5xx (from resource timing), so
 * an error page says which route failed even when the check that failed
 * runs before `expectApiClean` (for example a commit page's "internal
 * error").
 */
export const namingFailedRequests = <T>(
	browser: Browser,
	check: () => Promise<T>,
): Promise<T> => withFailedRequests(check, () => apiRequests(browser));

/** One `/-/api/` request the page made, as `trackFetches` saw it. */
export type TrackedFetch = {
	readonly method: string;
	readonly path: string;
	/** The query of a slot request (`?ctx=…`); empty for every other path. */
	readonly search: string;
	readonly status: number;
};

/**
 * Records every same-origin `/-/api/` request this document makes from now
 * on, with its method and status (the SPA's client calls `globalThis.fetch`
 * late-bound). Only the method, path, a slot request's query and the status
 * are kept: never a header or a body, so a response carrying a token
 * leaves nothing behind. Resource timing has no method, and
 * `browser.waitForResponse` matches URLs only, so this is how a test tells a
 * POST from the page's own GET of the same path.
 */
export const trackFetches = async (browser: Browser): Promise<void> => {
	await browser.evaluate(() => {
		const w = globalThis as unknown as {
			__tartanE2eFetches?: TrackedFetchRow[];
		};
		type TrackedFetchRow = {
			method: string;
			path: string;
			search: string;
			status: number;
		};
		if (w.__tartanE2eFetches !== undefined) return null;
		const rows: TrackedFetchRow[] = [];
		w.__tartanE2eFetches = rows;
		const inner = globalThis.fetch.bind(globalThis);
		globalThis.fetch = async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const method = (init?.method ??
				(input instanceof Request ? input.method : "GET")).toUpperCase();
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				location.href,
			);
			const response = await inner(input, init);
			if (
				url.origin === location.origin && url.pathname.startsWith("/-/api/")
			) {
				rows.push({
					method,
					path: url.pathname,
					search: url.pathname.startsWith("/-/api/slot/") ? url.search : "",
					status: response.status,
				});
			}
			return response;
		};
		return null;
	}, null);
};

/** What `trackFetches` recorded so far, oldest first. */
export const fetchesOf = (browser: Browser): Promise<TrackedFetch[]> =>
	browser.evaluate(() =>
		((globalThis as unknown as { __tartanE2eFetches?: TrackedFetch[] })
			.__tartanE2eFetches ?? []).map((r) => ({ ...r }))
	);

/**
 * Waits (bounded) until the page made a request matching `match`, then
 * returns it: a method-aware `waitForResponse` over `trackFetches`.
 */
export const fetchMatching = async (
	browser: Browser,
	match: (f: TrackedFetch) => boolean,
	options: { readonly timeout?: number; readonly message?: string } = {},
): Promise<TrackedFetch> => {
	let found: TrackedFetch | undefined;
	await expect.poll(async () => {
		found = (await fetchesOf(browser)).find(match);
		return found !== undefined;
	}, {
		timeout: options.timeout ?? 15_000,
		interval: 250,
		message: options.message ?? "the page never made the expected request",
	}).toBe(true);
	return found!;
};

/** In-view navigation with the SPA's router (the same path as a link click). */
export const spaNavigate = async (
	browser: Browser,
	to: string,
): Promise<void> => {
	const reached = await browser.evaluate(async (target: string) => {
		type Router = { push(to: string): Promise<unknown> };
		const host = document.querySelector("#app") as
			| (Element & {
				__vue_app__?: {
					config: { globalProperties: { $router?: Router } };
				};
			})
			| null;
		const router = host?.__vue_app__?.config.globalProperties.$router;
		if (router === undefined) return "no router";
		await router.push(target);
		return location.pathname;
	}, to);
	expect(reached, "the SPA router navigated in place").toBe(to.split("?")[0]);
};

/**
 * Signs `persona` in on the mock IdP's form. The browser must already be on
 * `<issuer>/authorize`; that is asserted before the password is filled, so a
 * redirect anywhere else never receives it.
 */
export const signInAtIdp = async (
	browser: Browser,
	screen: Screen,
	issuer: string,
	persona: Persona,
): Promise<void> => {
	await expect(browser).toHaveURL(urlOf(issuer, "/authorize"), {
		timeout: 20_000,
	});
	await expect(screen.getByRole("heading", { name: "Tartan e2e IdP" }))
		.toBeVisible();
	const user = credentials.user(persona);
	await screen.getByLabel("Username").fill(user.username);
	await screen.getByLabel("Password").fill(user.password);
	await screen.getByRole("button", "Sign in").tap();
};

/** Whoever the page's session belongs to (`/-/api/me`). */
export const meOf = async (browser: Browser) => {
	const reply = await pageApi(browser).get<
		{
			principal: { handle: string } | null;
			auth?: { isAdmin: boolean };
			forge?: { devTools: boolean };
		}
	>("/-/api/me");
	return ok("GET", "/-/api/me", reply);
};
