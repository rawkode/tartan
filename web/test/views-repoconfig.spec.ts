// Repository config (WP23, ADR repo config): the settings page
// (`/<repo>/-/settings/extensions`) and the change page's "Repo config" card,
// mounted with the real router and API client over the mock kernel, plus the
// pure model the two share.

import { describe, expect, it } from "vitest";
import type {
	RepoConfigPreviewDto,
	RepoConfigStateDto,
} from "@tartan/contract/repoconfig.ts";
import type { FetchLike } from "../src/api/http.ts";
import { CHANGE_ID_2, LANE_IDS, LANES } from "../src/api/mock/coord.ts";
import { CHANGE_ID, REPO_ID, SHAS } from "../src/api/mock/fixtures.ts";
import { CONFIG_KEYS } from "../src/api/mock/repoconfig.ts";
import { createMockFetch } from "../src/api/mock/server.ts";
import {
	canSignOff,
	laneOfChange,
	planLines,
	positionLink,
	settingsActions,
} from "../src/views/repoconfig/model.ts";
import { mountApp } from "./support/app.ts";
import { fakeSockets } from "./support/fakes.ts";
import {
	byAttr,
	byText,
	click,
	findAll,
	flush,
	html,
	type TestElement,
	text,
} from "./support/renderer.ts";

const REPO = "/acme/platform/router";
const SETTINGS = `${REPO}/-/settings/extensions`;
const CHANGE = `${REPO}/-/changes/${CHANGE_ID}`;
const API = `/-/api/repos/${REPO_ID}`;
const LANE = LANE_IDS.limits;
const HEAD = LANES.find((l) => l.id === LANE)!.head!;

const button = (root: TestElement, label: string | RegExp): TestElement => {
	const found = byText(root, "button", label);
	if (!found) throw new Error(`no button ${label}`);
	return found;
};

const card = (root: TestElement): TestElement | undefined =>
	byAttr(root, "data-kernel", "repo-config")[0];

/** The mock, with the viewer's role and some answers replaced. */
const withMock = (options: {
	readonly role?: number;
	readonly config?: (state: RepoConfigStateDto) => RepoConfigStateDto;
	readonly preview?: (p: RepoConfigPreviewDto) => RepoConfigPreviewDto;
} = {}): FetchLike => {
	const inner = createMockFetch();
	return async (input, init) => {
		const res = await inner(input, init);
		const path = new URL(input, "https://forge.test").pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		if (path === "/-/api/view" && options.role !== undefined) {
			const body = await res.json() as { viewer: { role: number } };
			return Response.json({
				...body,
				viewer: { ...body.viewer, role: options.role },
			});
		}
		if (path === `${API}/config` && method === "GET" && options.config) {
			return Response.json(
				options.config(await res.json() as RepoConfigStateDto),
			);
		}
		if (
			path === `${API}/lanes/${LANE}/config` && method === "GET" &&
			options.preview
		) {
			return Response.json(
				options.preview(await res.json() as RepoConfigPreviewDto),
			);
		}
		return res;
	};
};

describe("repository settings → extensions", () => {
	it("shows the state, the root files sent, effective extensions, repo policy and approvals", async () => {
		const app = await mountApp(SETTINGS);
		await flush();
		const page = text(app.root);
		expect(app.calls.some((c) => c.path === `${API}/config`)).toBe(true);
		expect(byAttr(app.root, "data-status")[0]?.children.length).toBeGreaterThan(
			0,
		);
		expect(text(byAttr(app.root, "data-status")[0]!)).toBe("current");
		expect(page).toContain("The applied config is trunk's.");
		expect(page).toContain("cue v0.17.1");
		// The root file links to its blob at trunk.
		const file = byText(app.root, "a", "tartan.cue")!;
		expect(file.attrs["href"]).toBe(`${REPO}/-/blob/${SHAS.c3}/tartan.cue`);
		// Effective rows and where they come from.
		expect(page).toContain("tartan.weave");
		expect(page).toContain("inherited from /acme");
		expect(page).toContain("overridable: batch, debounceMs");
		expect(page).toContain("policy: pipeline");
		// Repo policy in force (text only) and the approvals.
		expect(page).toContain('"run": "pnpm test"');
		expect(page).toContain("acme.no-secrets 0.2.0");
		// The Config tab is current and the copyable export command is there.
		expect(byText(app.root, "a", "Config")?.attrs["aria-current"]).toBe("page");
		expect(
			findAll(app.root, (el) => el.attrs["readonly"] !== undefined)
				.map((el) => String(el.value)),
		).toContain("CUE_REGISTRY=none cue export -E --out json .:tartan");
	});

	it("loads the schema files on request", async () => {
		const app = await mountApp(SETTINGS);
		await flush();
		click(button(app.root, "Show schema"));
		await flush();
		expect(app.calls.some((c) => c.path === `${API}/config/schema`)).toBe(true);
		expect(text(app.root)).toContain("~tartan.cue");
		expect(text(app.root)).toContain("cue.mod/pkg/tartan.dev/ext/ext.cue");
	});

	it("links positions to sent root files only; forge positions go to the schema; messages stay text", async () => {
		const fetch = withMock({
			config: (s) => ({
				...s,
				status: "failed",
				failure: {
					code: "BUILD_VALUE",
					message: "<img src=x onerror=alert(1)>",
					issues: [{
						path: 'extensions."tartan.weave".settings.batch',
						msg: "invalid value 12 (out of bound <=4)",
						pos: [
							"./tartan.cue:3:40",
							"cue.mod/pkg/tartan.dev/ext/x/tartan_weave/settings.cue:4:9",
							"other.cue:1:1",
						],
					}],
					denials: [{
						code: "locked_gate",
						path: 'extensions."tartan.review".mode',
						message: "inherited from /acme; change it there",
					}],
				},
			}),
		});
		const app = await mountApp(SETTINGS, { fetch });
		await flush();
		const page = text(app.root);
		expect(page).toContain("failed");
		expect(page).toContain("invalid value 12 (out of bound <=4)");
		expect(page).toContain("K8: locked gate");
		const blob = byText(app.root, "a", "tartan.cue:3:40")!;
		expect(blob.attrs["href"]).toBe(
			`${REPO}/-/blob/${SHAS.c3}/tartan.cue#L3`,
		);
		const schema = byText(app.root, "a", "settings.cue:4:9")!;
		expect(schema.attrs["href"]).toBe(`${SETTINGS}#schema`);
		// A root file that was not sent is shown, never linked.
		expect(byText(app.root, "a", "other.cue:1:1")).toBeNull();
		expect(page).toContain("other.cue:1:1");
		// Repository text is never HTML.
		expect(findAll(app.root, (el) => el.tag === "img")).toEqual([]);
		expect(html(app.root)).toContain("&lt;img src=x");
	});

	it("offers apply to a Maintainer when trunk needs it, and posts the sha the page showed", async () => {
		const fetch = withMock({
			config: (s) => ({ ...s, status: "needs-apply" }),
		});
		const app = await mountApp(SETTINGS, { fetch });
		await flush();
		click(button(app.root, "Apply trunk config"));
		await flush();
		const call = app.calls.find((c) => c.path === `${API}/config/apply`);
		expect(call?.method).toBe("POST");
		expect(call?.body).toEqual({ sha: SHAS.c3 });

		const reporter = await mountApp(SETTINGS, {
			fetch: withMock({
				role: 20,
				config: (s) => ({ ...s, status: "needs-apply" }),
			}),
		});
		await flush();
		expect(byText(reporter.root, "button", "Apply trunk config")).toBeNull();
		expect(byText(reporter.root, "button", "Re-evaluate")).toBeNull();
		expect(text(reporter.root)).toContain("needs apply");
	});

	it("follows the evaluator on the live feed: an apply's outcome shows without a reload", async () => {
		const live = fakeSockets();
		let status: RepoConfigStateDto["status"] = "needs-apply";
		const app = await mountApp(SETTINGS, {
			fetch: withMock({ config: (s) => ({ ...s, status }) }),
			connect: live.connect,
		});
		await flush(12);
		expect(text(app.root)).toContain("needs apply");
		click(button(app.root, "Apply trunk config"));
		await flush(12);
		expect(text(app.root)).toContain("needs apply");
		status = "current";
		const socket = live.sockets.find((s) => s.path.includes(REPO_ID))!;
		socket.open();
		socket.send({
			t: "events",
			head: 999,
			events: [{
				id: "01k6g000000000000000009998",
				seq: 999,
				stream: { kind: "repo", id: REPO_ID },
				type: "repo.config.applied",
				v: 1,
				source: { kind: "kernel" },
				actor: { kind: "system", id: "sys_kernel" },
				at: 0,
				data: {},
			}],
		});
		await flush(12);
		expect(text(byAttr(app.root, "data-status")[0]!)).toBe("current");
	});

	it("follows its own apply by asking again until the state moves, with no live feed", async () => {
		let status: RepoConfigStateDto["status"] = "needs-apply";
		const app = await mountApp(SETTINGS, {
			fetch: withMock({ config: (s) => ({ ...s, status }) }),
		});
		await flush(12);
		click(button(app.root, "Apply trunk config"));
		await flush(12);
		expect(text(byAttr(app.root, "data-status")[0]!)).toBe("needs apply");
		const gets = () =>
			app.calls.filter((c) => c.path === `${API}/config` && c.method === "GET")
				.length;
		const afterApply = gets();
		await app.clock.advance(2_000);
		await flush(12);
		expect(gets()).toBe(afterApply + 1);
		expect(text(byAttr(app.root, "data-status")[0]!)).toBe("needs apply");
		status = "current";
		await app.clock.advance(2_000);
		await flush(12);
		expect(text(byAttr(app.root, "data-status")[0]!)).toBe("current");
		const settled = gets();
		await app.clock.advance(20_000);
		await flush(12);
		expect(gets(), "no more polling once the state moved").toBe(settled);
	});

	it("keeps following while the apply's evaluation is pending", async () => {
		let answer: (s: RepoConfigStateDto) => RepoConfigStateDto = (s) => ({
			...s,
			status: "needs-apply",
			pendingSha: undefined,
		});
		const app = await mountApp(SETTINGS, {
			fetch: withMock({ config: (s) => answer(s) }),
		});
		await flush(12);
		// Right after the POST the state names the pending evaluation: the
		// fingerprint moved, but the outcome has not shown yet.
		answer = (s) => ({ ...s, status: "needs-apply", pendingSha: SHAS.c3 });
		click(button(app.root, "Apply trunk config"));
		await flush(12);
		await app.clock.advance(2_000);
		await flush(12);
		expect(text(byAttr(app.root, "data-status")[0]!)).toBe("needs apply");
		answer = (s) => ({ ...s, status: "current", pendingSha: undefined });
		await app.clock.advance(2_000);
		await flush(12);
		expect(text(byAttr(app.root, "data-status")[0]!)).toBe("current");
	});

	it("lets an Owner keep the last good config while lands are held", async () => {
		const fetch = withMock({
			config: (s) => ({
				...s,
				status: "pending",
				held: true,
				holdReason: "pending",
			}),
		});
		const app = await mountApp(SETTINGS, { fetch });
		await flush();
		expect(text(app.root)).toContain("lands held");
		click(button(app.root, "Keep last good"));
		await flush();
		expect(
			app.calls.find((c) => c.path === `${API}/config/override`)?.body,
		).toEqual({ action: "keep-last-good" });
	});

	it("says when repository config is off and shows the .tartan/ migration hint", async () => {
		const fetch = withMock({
			config: (s) => ({ ...s, enabled: false, legacyDir: true }),
		});
		const app = await mountApp(SETTINGS, { fetch });
		await flush();
		const page = text(app.root);
		expect(page).toContain("Repository config is off on this forge");
		expect(page).toContain(".tartan/ is no longer read");
		expect(byText(app.root, "button", "Re-evaluate")).toBeNull();
	});

	it("is reachable from the repo frame (members) and the repo settings page", async () => {
		const app = await mountApp(REPO);
		await flush();
		expect(byText(app.root, "a", "Config")?.attrs["href"]).toBe(SETTINGS);
		const settings = await mountApp(`${REPO}/-/settings`);
		await flush();
		expect(
			byText(settings.root, "a", "Open the extensions config")?.attrs["href"],
		).toBe(SETTINGS);
	});
});

describe("change card: repo config (K13.3)", () => {
	it("shows the route, the plan and the sign-off; a Maintainer approves the head and its digest", async () => {
		const app = await mountApp(CHANGE);
		await flush(12);
		const c = card(app.root)!;
		expect(c).toBeDefined();
		const body = text(c);
		expect(body).toContain("human (K13)");
		expect(body).toContain("sign-off pending");
		expect(body).toContain(
			"overlay tartan.weave (inherited from /acme): batch 4 → 2",
		);
		expect(body).toContain("install acme.no-secrets 0.2.0 (enforce)");
		expect(body).toContain(`evaluated at head ${HEAD.slice(0, 7)}`);
		// The lane came from the change's events; its preview and evaluation were read.
		expect(app.calls.some((c) => c.path.startsWith("/-/api/events"))).toBe(
			true,
		);
		expect(app.calls.some((x) => x.path === `${API}/lanes/${LANE}/config`))
			.toBe(true);
		click(button(c, "Approve policy change"));
		await flush(12);
		const post = app.calls.find((x) =>
			x.path === `${API}/lanes/${LANE}/policy-signoff` && x.method === "POST"
		);
		expect(post?.body).toEqual({
			head: HEAD,
			policyDigest: CONFIG_KEYS.digest,
		});
		const after = text(card(app.root)!);
		expect(after).toContain("approved");
		expect(byText(card(app.root)!, "button", "Approve policy change"))
			.toBeNull();
		click(button(card(app.root)!, "Revoke sign-off"));
		await flush(12);
		const del = app.calls.find((x) => x.method === "DELETE");
		expect(del?.path).toBe(
			`${API}/lanes/${LANE}/policy-signoff?head=${HEAD}`,
		);
		expect(text(card(app.root)!)).toContain("sign-off pending");
	});

	it("hides the approve button from a Developer and on a head still evaluating", async () => {
		const dev = await mountApp(CHANGE, { fetch: withMock({ role: 30 }) });
		await flush(12);
		expect(card(dev.root)).toBeDefined();
		expect(byText(card(dev.root)!, "button", "Approve policy change"))
			.toBeNull();
		const evaluating = await mountApp(CHANGE, {
			fetch: withMock({
				preview: (p) => ({ ...p, status: "evaluating", plan: [] }),
			}),
		});
		await flush(12);
		expect(text(card(evaluating.root)!)).toContain("evaluating…");
		expect(byText(card(evaluating.root)!, "button", "Approve policy change"))
			.toBeNull();
	});

	it("is absent when the lane touches no root .cue file, and for non-members", async () => {
		const other = await mountApp(`${REPO}/-/changes/${CHANGE_ID_2}`);
		await flush(12);
		expect(card(other.root)).toBeUndefined();
		const guest = await mountApp(CHANGE, { fetch: withMock({ role: 10 }) });
		await flush(12);
		expect(card(guest.root)).toBeUndefined();
		expect(guest.calls.some((c) => c.path.includes("/config"))).toBe(false);
	});

	it("refreshes on repo.config.previewed for its lane", async () => {
		const live = fakeSockets();
		let status: RepoConfigPreviewDto["status"] = "evaluating";
		const app = await mountApp(CHANGE, {
			fetch: withMock({ preview: (p) => ({ ...p, status }) }),
			connect: live.connect,
		});
		await flush(12);
		expect(text(card(app.root)!)).toContain("evaluating…");
		status = "ok";
		const socket = live.sockets.find((s) => s.path.includes(REPO_ID))!;
		socket.open();
		socket.send({
			t: "events",
			head: 999,
			events: [{
				id: "01k6g000000000000000009999",
				seq: 999,
				stream: { kind: "repo", id: REPO_ID },
				type: "repo.config.previewed",
				v: 1,
				source: { kind: "kernel" },
				actor: { kind: "system", id: "sys_kernel" },
				at: 0,
				data: { laneId: LANE, head: HEAD, status: "ok" },
			}],
		});
		await flush(12);
		expect(text(card(app.root)!)).toContain("evaluates");
	});
});

describe("repo config model", () => {
	const sent = new Set(["tartan.cue", "ci.cue"]);

	it("links a sent root position to its blob line, forge positions to the schema, and nothing else", () => {
		expect(positionLink("./ci.cue:12:5", "acme/r", "abc", sent)).toEqual({
			kind: "blob",
			href: "/acme/r/-/blob/abc/ci.cue#L12",
			text: "ci.cue:12:5",
		});
		expect(positionLink("~tartan.cue:5:14", "acme/r", "abc", sent).kind)
			.toBe("schema");
		expect(
			positionLink(
				"cue.mod/pkg/tartan.dev/ext/ext.cue:1:1",
				"acme/r",
				"abc",
				sent,
			)
				.kind,
		).toBe("schema");
		expect(positionLink("env.cue:1:1", "acme/r", "abc", sent).kind).toBe(
			"text",
		);
		expect(positionLink("../x.cue:1:1", "acme/r", "abc", sent).kind).toBe(
			"text",
		);
		expect(positionLink("a .cue:1:1", "acme/r", "abc", sent).kind).toBe(
			"text",
		);
	});

	it("reads an empty plan as no change", () => {
		expect(planLines([])).toEqual(["no change"]);
	});

	it("offers actions by state and role", () => {
		const s = {
			enabled: true,
			status: "needs-apply" as const,
			held: false,
			trunkSha: SHAS.c3,
		};
		expect(settingsActions(s, 40).apply).toBe(true);
		expect(settingsActions(s, 30).apply).toBe(false);
		expect(settingsActions({ ...s, enabled: false }, 50).apply).toBe(false);
		expect(
			settingsActions({ ...s, status: "pending", held: true }, 50).keepLastGood,
		).toBe(true);
		expect(
			settingsActions({ ...s, status: "pending", held: true }, 40).keepLastGood,
		).toBe(false);
		// A lost gate holds a failed head too: the Owner's escape is offered.
		expect(
			settingsActions({ ...s, status: "failed", held: true }, 50).keepLastGood,
		).toBe(true);
		expect(
			settingsActions({ ...s, status: "failed", held: false }, 50).keepLastGood,
		).toBe(false);
	});

	it("allows a sign-off only for a touched head with a known digest and none in force", () => {
		const p: RepoConfigPreviewDto = {
			laneId: LANE,
			head: HEAD,
			status: "ok",
			policyTouched: true,
			policyDigest: null,
			issues: [],
			denials: [],
			plan: [],
		};
		expect(canSignOff(p, 40)).toBe(true);
		expect(canSignOff(p, 30)).toBe(false);
		expect(canSignOff({ ...p, policyDigest: undefined }, 50)).toBe(false);
		expect(canSignOff({ ...p, status: "rate_limited" }, 50)).toBe(false);
		const signoff = {
			laneId: LANE,
			head: HEAD,
			policyDigest: null,
			signedBy: "u_x",
			eventId: "ev",
			at: 0,
		};
		expect(canSignOff({ ...p, signoff }, 50)).toBe(false);
		expect(
			canSignOff({ ...p, signoff: { ...signoff, head: "0".repeat(40) } }, 50),
		)
			.toBe(true);
		expect(canSignOff({ ...p, signoff: { ...signoff, revokedAt: 1 } }, 50))
			.toBe(
				true,
			);
	});

	it("finds a change's lane from its events, newest wins", () => {
		expect(
			laneOfChange([
				{ type: "changes.opened", data: { changeId: "c1", laneId: "ln_a" } },
				{ type: "push.diffed", data: { changeId: "c1", laneId: "ln_x" } },
				{ type: "changes.submitted", data: { changeId: "c1", laneId: "ln_b" } },
				{ type: "changes.opened", data: { changeId: "c2", laneId: "ln_c" } },
			], "c1"),
		).toBe("ln_b");
		expect(laneOfChange([], "c1")).toBeNull();
	});
});
