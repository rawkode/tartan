// Forge administration. The extension pages, an installation's
// page, the forge settings and a repo's lane settings render and call only
// routes the kernel serves (the admin 404/501 regressions). The installation
// console and dead letters are for Maintainers only. The Agents page creates
// an agent, shows its token once (in a password field, so its value never
// reaches the test or the report) and disables it again.

import { expect } from "e2e";
import type { InstallationsResponse } from "@tartan/contract/api.ts";
import { test } from "../support/fixtures.ts";
import { type Api, ok, pageApi, query, tokenApi } from "../support/http.ts";
import { agentNameOf, PACK_GROUP } from "../support/names.ts";
import {
	escapeRegExp,
	expectApiClean,
	expectSlotsSettled,
	fetchMatching,
	trackFetches,
	viewOf,
	watchApi,
} from "../support/page.ts";
import { fixtureRepo } from "../support/repos.ts";
import {
	AGENT_TOKEN_RE,
	type Stage,
	tokensOf,
	usernameOf,
} from "../support/stage.ts";
import { RENDERED } from "../support/view.ts";

/** The owner's PAT from Node (installation ids are looked up with it). */
const ownerApi = (stage: Stage): Api =>
	tokenApi(stage.origin, tokensOf(stage).ownerPat);

/** A node-scoped installation in force at `e2e/classic` (the pack itself). */
const classicInstallation = async (
	api: Api,
): Promise<{ id: string; name: string; extId: string }> => {
	const reply = await api.get<InstallationsResponse>(
		`/-/api/installations?${query({ node: PACK_GROUP.classic })}`,
	);
	const found = ok("GET", "/-/api/installations", reply).installations.find(
		(i) => i.installation.storageScope === "node",
	);
	if (found === undefined) {
		throw new Error("no node-scoped installation in force at e2e/classic");
	}
	return {
		id: found.installation.id,
		name: found.manifest.name,
		extId: found.installation.extId,
	};
};

test.describe("administration as the owner", {
	session: "owner",
	tags: ["admin", "regression", "owner"],
}, () => {
	test("the Extensions page lists what is installed and what is available", {
		tags: ["smoke", "admin-routes"],
	}, async ({ app, screen, browser }) => {
		await app.open("/-/extensions");
		await watchApi(browser);
		await expect(screen.getByRole("heading", { name: "Extensions", level: 1 }))
			.toBeVisible();
		await expect(screen.getByRole("heading", { name: "Installed" }))
			.toBeVisible();
		await expect(screen.getByRole("heading", { name: "Available packages" }))
			.toBeVisible();
		await screen.getByLabel("In force at").fill(PACK_GROUP.classic);
		await screen.getByRole("button", "Show").tap();
		await expect(screen.getByRole("link", "tartan.pack.classic")).toBeVisible();
		await expect(screen.getByRole("link", "tartan.work")).toBeVisible();
		await expect(screen.getByRole("alert")).toHaveCount(0);
		await expectApiClean(browser);
	});

	test("an installation's page and its compare page render", {
		tags: ["admin-routes"],
	}, async ({ app, screen, browser, stage }) => {
		await app.open("/-/extensions");
		const installation = await classicInstallation(ownerApi(stage));
		await app.open(`/-/extensions/${encodeURIComponent(installation.id)}`);
		await watchApi(browser);
		await expect(
			screen.getByRole("heading", {
				// The package name, or the extension id when it is not a listed package.
				name: new RegExp(
					`^(?:${escapeRegExp(installation.name)}|${
						escapeRegExp(installation.extId)
					})$`,
				),
				level: 1,
			}),
		).toBeVisible();
		await expect(screen.getByRole("radiogroup", "Mode")).toBeVisible();
		await expect(screen.getByRole("heading", { name: "Approved permissions" }))
			.toBeVisible();
		await expectApiClean(browser);

		await app.open(
			`/-/extensions/${encodeURIComponent(installation.id)}/compare`,
		);
		await expect(
			screen.getByRole("heading", { name: "Policy compare", level: 1 }),
		).toBeVisible();
	});

	test("the installation console and dead letters answer the owner", {
		tags: ["extension-logs"],
	}, async ({ app, browser, stage }) => {
		await app.open("/-/extensions");
		const api = pageApi(browser);
		const installation = await classicInstallation(ownerApi(stage));
		for (const part of ["console", "dead-letters"]) {
			const reply = await api.get(
				`/-/api/installations/${encodeURIComponent(installation.id)}/${part}`,
			);
			expect(reply.status, part).toBe(200);
		}
	});

	test("the forge settings page renders without errors", {
		tags: ["admin-routes"],
	}, async ({ app, screen, browser }) => {
		await app.open("/-/settings");
		await watchApi(browser);
		await expect(screen.getByRole("heading", { name: "Settings", level: 1 }))
			.toBeVisible();
		await expect(screen.getByRole("heading", { name: "Forge" })).toBeVisible();
		await expect(screen.getByRole("heading", { name: "Health" })).toBeVisible();
		await expect(browser.locator(".bindings li").first()).toBeVisible();
		await expect(screen.getByRole("alert")).toHaveCount(0);
		await expectApiClean(browser);
	});

	test("a repo's lane settings form offers branch lanes only", {
		tags: ["lane-settings"],
	}, async ({ app, screen, browser, stage }) => {
		const repo = await fixtureRepo(stage, "classic", "settings");
		await app.open(`/${repo.path}/-/settings`);
		await watchApi(browser);
		await expect(screen.getByRole("heading", { name: "Lanes" })).toBeVisible();
		const mode = screen.getByLabel("Lane mode");
		await expect(mode).toBeVisible();
		await expect(
			browser.locator('select[name="laneMode"] option:not([disabled])'),
		).toHaveText(["Forge default", "Branch lanes in this repo"]);
		await expect(screen.getByRole("button", "Save lane settings"))
			.toBeVisible();
		const view = await viewOf(browser, repo.path, "settings");
		await expectSlotsSettled(browser, view, RENDERED.none);
		await expectApiClean(browser);
	});

	test("an agent is created, its token shown once, then disabled", {
		tags: ["agents"],
		// The token is on the page while the panel is open: record nothing.
		trace: "off",
	}, async ({ app, screen, browser, stage }) => {
		const name = agentNameOf(stage.runId, "ui");
		try {
			await app.open("/-/agents");
			await watchApi(browser);
			await expect(screen.getByRole("heading", { name: "Agents", level: 1 }))
				.toBeVisible();
			await screen.getByLabel("Name").fill(name);
			await screen.getByLabel("Scope (group or repo)").fill("e2e");
			await screen.getByLabel("Highest role").selectOption({ value: "30" });
			await screen.getByLabel("Expires after (days)").fill("1");
			// The create is the page's POST, told from its own GET of the same
			// path by method (`trackFetches` records method, path and status only).
			await trackFetches(browser);
			await screen.getByRole("button", "Create agent and token").tap();
			const created = await fetchMatching(
				browser,
				(f) => f.method === "POST" && f.path === "/-/api/agents",
				{ message: "the page never sent POST /-/api/agents" },
			);
			expect([200, 201]).toContain(created.status);

			await expect(
				screen.getByRole("heading", { name: `${name} is ready` }),
			).toBeVisible();
			await expect(screen.getByText(/The token is shown only once\./))
				.toBeVisible();
			await expect(screen.getByLabel("Token")).toBeVisible();
			// The token's shape, checked in the page: only a boolean leaves it.
			const shaped = await browser.evaluate((source: string) => {
				const label = [...document.querySelectorAll("label")].find((l) =>
					l.textContent?.trim() === "Token"
				);
				const input = label === undefined
					? null
					: document.getElementById(label.htmlFor) as HTMLInputElement | null;
				return input !== null && new RegExp(source).test(input.value);
			}, AGENT_TOKEN_RE.source);
			expect(shaped, "the panel shows one agent token").toBe(true);
			await screen.getByRole("button", "I have copied them").tap();
			await expect(screen.getByLabel("Token")).toHaveCount(0);

			const card = browser.locator("li.agent").filter({ hasText: name });
			const off = await browser.onDialog("accept");
			await card.getByRole("button", "Disable").tap();
			await expect(card.getByText("disabled", { exact: true })).toBeVisible();
			await off();
			await expectApiClean(browser);
		} finally {
			// Disabled even when the test failed half-way (the launcher's
			// teardown catches `e2e-<runId>-*` agents too).
			const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
			const list = await owner.get<
				{ agents: { id: string; handle: string; disabled: boolean }[] }
			>("/-/api/agents");
			for (const agent of list.body?.agents ?? []) {
				if (agent.handle === name && !agent.disabled) {
					await owner.send(
						"DELETE",
						`/-/api/agents/${encodeURIComponent(agent.id)}`,
					);
				}
			}
		}
	});
});

test.describe("administration as a Reporter", {
	session: "reporter",
	tags: ["admin", "regression", "reporter"],
}, () => {
	test("the installation console and dead letters are refused", {
		tags: ["extension-logs"],
	}, async ({ app, browser, stage }) => {
		await app.open("/-/extensions");
		const api = pageApi(browser);
		const installation = await classicInstallation(ownerApi(stage));
		for (const part of ["console", "dead-letters"]) {
			const reply = await api.get(
				`/-/api/installations/${encodeURIComponent(installation.id)}/${part}`,
			);
			expect(reply.status, part).toBe(403);
		}
	});

	test("the Extensions page opens for a Reporter with no not-found error", {
		// Fails while invited users have no namespace node: the page starts
		// "In force at" the viewer's handle, which then answers 404.
		tags: ["known-bug"],
	}, async ({ app, screen, browser }) => {
		await app.open("/-/extensions");
		await watchApi(browser);
		await expect(screen.getByRole("heading", { name: "Extensions", level: 1 }))
			.toBeVisible();
		// The session has loaded (the header names the Reporter) and the page's
		// first "in force at" answer has settled, before anything is typed: that
		// answer is what a person sees first. It may be the list, an empty
		// state or a denied state ("You do not have access"), never a "was not
		// found" for the viewer's own namespace, and never a failed request.
		await expect(
			screen.getByRole("banner").getByText(usernameOf("reporter")),
		).toBeVisible();
		const installed = screen.getByRole("region", "Installed");
		await expect(installed.getByText("Loading installations…")).toHaveCount(0);
		await expect(installed.getByRole("alert").filter({ hasText: /not found/ }))
			.toHaveCount(0);
		await expectApiClean(browser);
	});

	test("a Reporter reads what is in force at a group they belong to", async ({ app, screen, browser }) => {
		await app.open("/-/extensions");
		await watchApi(browser);
		await screen.getByLabel("In force at").fill(PACK_GROUP.classic);
		await screen.getByRole("button", "Show").tap();
		const installed = screen.getByRole("region", "Installed");
		await expect(installed.getByRole("link", "tartan.pack.classic"))
			.toBeVisible();
		await expect(installed.getByRole("alert")).toHaveCount(0);
		await expectApiClean(browser, [
			// The first answer for the Reporter's own handle (see the test above).
			{ path: /^\/-\/api\/installations$/, status: 404 },
		]);
	});
});
