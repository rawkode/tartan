// Every run: the claimed forge keeps its setup closed. Anonymous
// visitors see "already set up"; a setup token can no longer unlock it (a
// fresh random token, so the consumed one never needs to be kept); the
// owner's forge runs with dev tools (the dev-e2e stage's guard).

import { Buffer } from "node:buffer";
import { expect } from "e2e";
import { test } from "../support/fixtures.ts";
import { boundedFetch, pageApi } from "../support/http.ts";
import { expectApiClean, meOf, watchApi } from "../support/page.ts";

test.describe(
	"setup on a claimed forge",
	{ tags: ["setup", "regression"] },
	() => {
		test("anonymous visitors see that the forge is set up", {
			tags: ["anonymous", "smoke"],
		}, async ({ app, screen, browser }) => {
			await app.open("/-/setup");
			await watchApi(browser);
			await expect(screen.getByText("This forge is already set up."))
				.toBeVisible();
			// The page's own link (the header has a Sign in link too).
			await expect(screen.getByRole("main").getByRole("link", "Sign in"))
				.toBeVisible();
			await expect(browser.locator('ol[aria-label="Setup steps"]')).toHaveCount(
				0,
			);
			await expectApiClean(browser);
		});

		test(
			"a setup token cannot unlock a claimed forge",
			{ tags: ["anonymous", "rate-limited"] },
			async ({ stage }) => {
				// Spends one of the 5 unlock attempts per 10 minutes for this address:
				// excluded from `--repeat-each` runs by the launcher.
				const { status, body } = await boundedFetch(
					`${stage.origin}/-/setup/unlock`,
					{
						method: "POST",
						redirect: "manual",
						headers: {
							origin: stage.origin,
							accept: "application/json",
							"content-type": "application/json",
						},
						body: JSON.stringify({
							token: Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
								.toString("base64url"),
						}),
					},
					"POST /-/setup/unlock",
					async (response) => ({
						status: response.status,
						body: await response.json() as { error?: string; reason?: string },
					}),
				);
				expect(status).toBe(403);
				expect(body).toMatchObject({ error: "denied", reason: "setup" });
			},
		);

		test("the owner's forge runs with dev tools", {
			session: "owner",
			tags: ["owner", "smoke"],
		}, async ({ app, browser }) => {
			await app.open("/");
			const me = await meOf(browser);
			expect(me.principal?.handle).toBe("e2e-owner");
			expect(me.forge?.devTools, "the dev-e2e forge has dev tools on").toBe(
				true,
			);
			const health = await pageApi(browser).get<{ stage: string }>("/-/health");
			expect(health.body?.stage).toBe("dev-e2e");
		});

		test("the owner's post-claim wizard steps call served routes only", {
			session: "owner",
			tags: ["owner", "pending", "admin-routes"],
			skip:
				"pending: the lane self-test and root-key steps still call unserved admin routes",
		}, async ({ app, browser, screen }) => {
			await app.open("/-/setup");
			await watchApi(browser);
			await expect(browser.locator('ol[aria-label="Setup steps"]'))
				.toContainText("Lane self-test");
			await expect(screen.getByRole("alert")).toHaveCount(0);
			await expectApiClean(browser);
		});
	},
);
