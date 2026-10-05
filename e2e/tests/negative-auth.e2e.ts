// Sign-in that must fail. A user the IdP knows but the forge never
// invited comes back to "no account here" with no session. A wrong password
// stays on the IdP's form with its alert (a fixed wrong literal, not a
// secret). A callback with a forged state and no login transaction is
// refused. Every password is filled only after the browser is on the mock
// IdP's `/authorize`.

import { expect } from "e2e";
import { test } from "../support/fixtures.ts";
import { meOf, signInAtIdp, urlOf } from "../support/page.ts";

/** Not a credential: the IdP must refuse it. */
const WRONG_PASSWORD = "not-the-password-0000";

test.describe("sign-in that must fail", {
	tags: ["auth", "regression", "anonymous"],
}, () => {
	test("a user the forge never invited gets no account and no session", {
		tags: ["outsider"],
	}, async ({ app, screen, browser, stage }) => {
		await app.open("/-/login");
		await screen.getByRole("link", "Continue to sign in").tap();
		await signInAtIdp(browser, screen, stage.issuer, "outsider");
		// The callback URL carries the (spent) code: assert the page, not the URL.
		await expect(
			screen.getByRole("heading", { name: "No account here yet", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		await expect(screen.getByText(/this forge has no account for you/))
			.toBeVisible();
		await app.open("/");
		expect((await meOf(browser)).principal).toBeNull();
	});

	test("a wrong password stays on the IdP with an alert", {
		tags: ["rate-limited"],
	}, async ({ app, screen, browser, stage }) => {
		await app.open("/-/login");
		await screen.getByRole("link", "Continue to sign in").tap();
		await expect(browser).toHaveURL(urlOf(stage.issuer, "/authorize"), {
			timeout: 20_000,
		});
		await screen.getByLabel("Username").fill("e2e-owner");
		await screen.getByLabel("Password").fill(WRONG_PASSWORD);
		await screen.getByRole("button", "Sign in").tap();
		await expect(screen.getByRole("alert")).toHaveText(
			"Wrong username or password",
		);
		await expect(browser).toHaveURL(urlOf(stage.issuer, "/authorize"));
		await app.open("/");
		expect((await meOf(browser)).principal).toBeNull();
	});

	test("a callback with a forged state is refused", async ({ app, screen, browser }) => {
		await app.open("/-/auth/callback?state=e2e-forged-state&code=e2e-forged");
		await expect(
			screen.getByRole("heading", { name: "Sign-in expired", level: 1 }),
		).toBeVisible();
		await app.open("/");
		expect((await meOf(browser)).principal).toBeNull();
	});
});
