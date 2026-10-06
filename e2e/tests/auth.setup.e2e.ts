// The browser sessions every signed-in suite restores. Each persona
// signs in through the real flow: the forge's sign-in page, the forge's
// `/-/auth/login` redirect, the mock IdP's form (after checking the browser
// is on the mock IdP's `/authorize`), the forge's callback, then the forge
// home. The session is saved only after `/-/api/me` names the persona.
//
// e2e keeps the sessions encrypted for this run only. The forge session
// cookies in them stay valid after the run (Tartan has no "end all sessions"
// API yet); they never leave the run's encrypted store, and any copy in a
// retained trace is ended by the launcher after the run.

import { type App, expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";
import type { ErrorCode } from "@tartan/contract/errors.ts";
import { test } from "../support/fixtures.ts";
import { meOf, signInAtIdp, urlOf } from "../support/page.ts";
import { SIGNED_IN, usernameOf } from "../support/stage.ts";

/**
 * `/-/auth/login` answers within 15 s (LOGIN_DEADLINE_MS) or with 503
 * `unavailable` "try again" when ForgeDO is busy; the tap waits past that
 * deadline so it sees the answer instead of timing out on the navigation.
 */
const LOGIN_TAP_MS = 45_000;
const LOGIN_ATTEMPTS = 3;
const UNAVAILABLE: ErrorCode = "unavailable";

/** The forge's sign-in answered "unavailable, try again" (a busy ForgeDO). */
const askedToRetry = async (
	browser: Browser,
	origin: string,
): Promise<boolean> => {
	if (!urlOf(origin, "/-/auth/login").test(await browser.url())) return false;
	const text = await browser.evaluate(() => document.body?.innerText ?? "");
	try {
		return (JSON.parse(text) as { error?: unknown }).error === UNAVAILABLE;
	} catch {
		return false;
	}
};

/**
 * From the sign-in page to the IdP: a person whose sign-in answers "try
 * again" tries again, so a ForgeDO kept busy by the janitor and the
 * provisioning just before does not fail every signed-in suite of the run.
 */
const startSignIn = async (
	app: App,
	screen: Screen,
	browser: Browser,
	origin: string,
): Promise<void> => {
	for (let attempt = 1;; attempt++) {
		await app.open("/-/login");
		await expect(screen.getByRole("heading", { name: "Sign in", level: 1 }))
			.toBeVisible();
		await screen.getByRole("link", "Continue to sign in").tap({
			timeout: LOGIN_TAP_MS,
		});
		if (!(await askedToRetry(browser, origin))) return;
		// A product fault worth counting (a person sees a JSON 503 page):
		// every retry is reported in the run's log, never hidden.
		console.warn(
			`e2e-retry: sign-in answered "${UNAVAILABLE}, try again" (attempt ${attempt} of ${LOGIN_ATTEMPTS})`,
		);
		if (attempt >= LOGIN_ATTEMPTS) {
			throw new Error(
				`the forge's sign-in answered "${UNAVAILABLE}, try again" ${LOGIN_ATTEMPTS} times`,
			);
		}
	}
};

test.setup(
	"each persona signs in through the mock IdP",
	{ sessions: [...SIGNED_IN], tags: ["auth", "smoke"] },
	async ({ app, screen, browser, session, stage }) => {
		for (const persona of SIGNED_IN) {
			await startSignIn(app, screen, browser, stage.origin);
			await signInAtIdp(browser, screen, stage.issuer, persona);

			// Back on the forge, signed in, on the page sign-in started from.
			await expect(browser).toHaveURL(urlOf(stage.origin, "/"), {
				timeout: 20_000,
			});
			const me = await meOf(browser);
			expect(me.principal?.handle, `${persona} is signed in`).toBe(
				usernameOf(persona),
			);
			expect(me.auth?.isAdmin, `only the owner is a forge admin`).toBe(
				persona === "owner",
			);
			await session.save(persona);
			await app.clearState();
		}
	},
);
