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

import { expect } from "e2e";
import { test } from "../support/fixtures.ts";
import { meOf, signInAtIdp, urlOf } from "../support/page.ts";
import { SIGNED_IN, usernameOf } from "../support/stage.ts";

test.setup(
	"each persona signs in through the mock IdP",
	{ sessions: [...SIGNED_IN], tags: ["auth", "smoke"] },
	async ({ app, screen, browser, session, stage }) => {
		for (const persona of SIGNED_IN) {
			await app.open("/-/login");
			await expect(screen.getByRole("heading", { name: "Sign in", level: 1 }))
				.toBeVisible();
			await screen.getByRole("link", "Continue to sign in").tap();
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
