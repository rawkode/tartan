// Phase A: claiming a fresh dev-e2e forge through the setup wizard
// (the deploy's setup token is single use). Only
// `deno task e2e -- stage up` runs it, once, right after deploying a fresh
// forge, with the token as the `setup-token` secret; every other run
// excludes the `claim` tag. The token is pasted into the wizard's field
// (the manual path), never put in a URL. Unlock is rate limited (5 per
// 10 minutes per address), so a failure here is never retried.

import { expect, secrets } from "e2e";
import { test } from "../../support/fixtures.ts";
import { ok, pageApi } from "../../support/http.ts";
import { meOf, signInAtIdp, urlOf } from "../../support/page.ts";

const PRE_CLAIM = [
	"Unlock",
	"Environment",
	"Name and address",
	"Identity provider",
	"Claim ownership",
];

test(
	"the owner claims a fresh forge with the deploy's setup token",
	{ tags: ["claim", "rate-limited"], timeout: 600_000 },
	async ({ app, screen, browser, stage }) => {
		await app.open("/-/setup");
		await expect(
			screen.getByRole("heading", { name: "Set up your forge", level: 1 }),
		).toBeVisible();
		const steps = browser.locator('ol[aria-label="Setup steps"] > li');
		await expect(steps).toHaveText(
			PRE_CLAIM.map((label, i) => new RegExp(`^${i + 1}\\s*${label}$`)),
		);

		// Unlock with the token from the deploy (a secret: it is redacted
		// everywhere and screenshots stay off for the rest of this attempt).
		await screen.getByLabel("Setup token or claim code").fill(
			secrets.get("setup-token"),
		);
		await screen.getByRole("button", "Unlock setup").tap();

		// Environment checks (the runner container may need a while to start).
		await expect(screen.getByRole("heading", { name: "Environment" }))
			.toBeVisible({ timeout: 30_000 });
		const proceed = screen.getByRole("button", "Continue");
		await expect(proceed).toBeEnabled({ timeout: 240_000 });
		await proceed.tap();

		// Name and the canonical origin (this workers.dev address).
		await expect(screen.getByRole("heading", { name: "Name and address" }))
			.toBeVisible();
		await screen.getByLabel("Forge name").fill("Tartan e2e");
		await screen.getByLabel("Address (canonical origin)").fill(stage.origin);
		await screen.getByRole("button", "Save and continue").tap();

		// The mock IdP through dynamic registration.
		await expect(screen.getByRole("heading", { name: "Identity provider" }))
			.toBeVisible();
		await screen.getByLabel("Issuer URL").fill(stage.issuer);
		await screen.getByRole("button", "Register Tartan").tap();
		await expect(screen.getByText(/^Registered\. Client id /)).toBeVisible({
			timeout: 30_000,
		});
		await screen.getByRole("button", "Continue").tap();

		// Claim: the first account to sign in becomes the owner.
		await expect(screen.getByRole("heading", { name: "Claim ownership" }))
			.toBeVisible();
		await screen.getByRole("link", "Sign in to become owner").tap();
		await signInAtIdp(browser, screen, stage.issuer, "owner");
		await expect(browser).toHaveURL(urlOf(stage.origin, "/-/setup"), {
			timeout: 30_000,
		});
		await expect(browser.locator('ol[aria-label="Setup steps"]'))
			.toContainText("Lane self-test");

		const me = await meOf(browser);
		expect(me.principal?.handle).toBe("e2e-owner");
		expect(me.auth?.isAdmin).toBe(true);
		const health = ok(
			"GET",
			"/-/health",
			await pageApi(browser).get<{ setupState: string; stage: string }>(
				"/-/health",
			),
		);
		expect(health).toMatchObject({ setupState: "done", stage: "dev-e2e" });
	},
);
