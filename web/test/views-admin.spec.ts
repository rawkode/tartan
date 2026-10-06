// Agents, Extensions and Settings admin, and per-repo lane settings, against
// the mock kernel.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/api/http.ts";
import { createMockFetch } from "../src/api/mock/server.ts";
import { mountApp } from "./support/app.ts";
import {
	byAttr,
	byTag,
	byText,
	choose,
	click,
	findAll,
	flush,
	html,
	submit,
	type TestElement,
	text,
	type,
} from "./support/renderer.ts";

const field = (root: TestElement, name: string): TestElement => {
	const found = findAll(
		root,
		(el) =>
			["input", "select", "textarea"].includes(el.tag) &&
			el.attrs["name"] === name,
	)[0];
	if (!found) throw new Error(`no field ${name}`);
	return found;
};

const button = (root: TestElement, label: string | RegExp): TestElement => {
	const found = byText(root, "button", label);
	if (!found) throw new Error(`no button ${label}`);
	return found;
};

let confirms: string[] = [];
beforeEach(() => {
	confirms = [];
	vi.stubGlobal("confirm", (message: string) => {
		confirms.push(message);
		return true;
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("agents admin", () => {
	it("creates an agent and shows its token and snippets exactly once", async () => {
		const app = await mountApp("/-/agents");
		expect(text(app.root)).toContain("claude-1");
		expect(text(app.root)).toContain("codex-1");
		type(field(app.root, "name"), "claude-laptop");
		choose(field(app.root, "tool"), "claude-code");
		type(field(app.root, "node"), "acme/platform");
		await flush();
		submit(findAll(app.root, (el) => el.tag === "form")[0]!);
		await flush();
		expect(
			app.calls.find((c) => c.path === "/-/api/agents" && c.method === "POST")
				?.body,
		)
			.toEqual({
				name: "claude-laptop",
				tool: "claude-code",
				node: "acme/platform",
				maxRole: 30,
				ttlDays: 7,
			});
		expect(text(app.root)).toContain("claude-laptop is ready");
		expect(text(app.root)).toContain("shown only once");
		const values = findAll(app.root, (el) => el.attrs["readonly"] !== undefined)
			.map((el) => String(el.value));
		expect(values.some((v) => v.startsWith("tagt_"))).toBe(true);
		expect(values.some((v) => v.includes("claude mcp add"))).toBe(true);
		expect(values.some((v) => v.includes("[mcp_servers.tartan]"))).toBe(true);
		expect(values.some((v) => v.includes("credential"))).toBe(true);
		const token = findAll(
			app.root,
			(el) => String(el.value).startsWith("tagt_"),
		)[0]!;
		expect(token.attrs["type"]).toBe("password");
		click(button(app.root, "I have copied them"));
		await flush();
		expect(html(app.root)).not.toContain("tagt_");
	});

	it("refuses invalid agent names before calling the API", async () => {
		const app = await mountApp("/-/agents");
		type(field(app.root, "name"), "Bad Name");
		type(field(app.root, "node"), "acme");
		await flush();
		expect("disabled" in button(app.root, "Create agent and token").attrs).toBe(
			true,
		);
	});

	it("revokes a token after confirmation", async () => {
		const app = await mountApp("/-/agents");
		click(button(app.root, "Revoke"));
		await flush();
		expect(confirms).toEqual(["Revoke this token?"]);
		const del = app.calls.find((c) => c.method === "DELETE");
		expect(del?.path).toMatch(/^\/-\/api\/tokens\/t_/);
		expect(text(app.root)).toContain("revoked");
	});

	it("asks anonymous visitors to sign in", async () => {
		const app = await mountApp("/-/agents", { mock: { signedIn: false } });
		expect(text(app.root)).toContain("Sign in to manage agents");
		expect(app.calls.some((c) => c.path === "/-/api/agents")).toBe(false);
	});
});

/** The form that holds the field `name`. */
const formOf = (root: TestElement, name: string): TestElement => {
	let el: TestElement | null = field(root, name);
	while (el && el.tag !== "form") el = el.parent;
	if (!el) throw new Error(`no form around ${name}`);
	return el;
};

/** Shows what is in force at `node` (WP7a requires a node). */
const showInForce = async (root: TestElement, node: string): Promise<void> => {
	type(field(root, "installed-at"), node);
	submit(formOf(root, "installed-at"));
	await flush();
};

describe("extensions admin", () => {
	it("lists what is in force at a node (WP7a `{node, installations: InstallationInForce[]}`)", async () => {
		const app = await mountApp("/-/extensions");
		// Starts where the kernel says (no `node`: never a guessed node that
		// may not exist, e2e), here the viewer's own namespace.
		expect(app.calls.map((c) => c.path)).toContain("/-/api/installations");
		expect(
			app.calls.some((c) => c.path.startsWith("/-/api/installations?node=")),
		).toBe(false);
		expect(field(app.root, "installed-at").value).toBe("rawkode");
		expect(byText(app.root, "a", "tartan.weave")).toBeNull();
		// A repo under acme inherits acme's installations.
		await showInForce(app.root, "acme/platform/router");
		expect(app.calls.map((c) => c.path)).toContain(
			"/-/api/installations?node=acme%2Fplatform%2Frouter",
		);
		const rows = findAll(app.root, (el) => el.tag === "tr").map(text);
		expect(rows.some((r) => r.includes("tartan.weave") && r.includes("acme")))
			.toBe(true);
		expect(rows.some((r) => r.includes("tartan.radar"))).toBe(true);
	});

	it("an invited user starts at the node the kernel picks, with no alert (e2e)", async () => {
		const inner = createMockFetch();
		const startAt = (status: 200 | 404): FetchLike => (input, init) => {
			if (input !== "/-/api/installations") return inner(input, init);
			if (status === 404) {
				return Promise.resolve(Response.json({
					error: "not_found",
					message: "no namespace you can read yet: name a node",
				}, { status: 404 }));
			}
			return inner("/-/api/installations?node=acme%2Fplatform", init);
		};
		const app = await mountApp("/-/extensions", { fetch: startAt(200) });
		await flush();
		expect(field(app.root, "installed-at").value).toBe("acme/platform");
		expect(findAll(app.root, (el) => el.attrs["role"] === "alert"))
			.toHaveLength(0);
		const rows = findAll(app.root, (el) => el.tag === "tr").map(text);
		expect(rows.some((r) => r.includes("tartan.weave"))).toBe(true);
		// Nothing readable yet: a prompt, not "installations was not found".
		const none = await mountApp("/-/extensions", { fetch: startAt(404) });
		await flush();
		expect(text(none.root)).toContain(
			"Enter a namespace to see the extensions in force there.",
		);
		expect(text(none.root)).not.toContain("was not found");
	});

	it("installs a package after showing the permission sheet", async () => {
		const app = await mountApp("/-/extensions");
		expect(text(app.root)).toContain("tartan.radar");
		const weave = findAll(
			app.root,
			(el) => el.tag === "li" && text(el).includes("tartan.weave@0.1.0"),
		)[0]!;
		click(byText(weave, "button", "Install…")!);
		await flush();
		type(field(app.root, "node"), "acme/platform");
		await flush();
		submit(formOf(app.root, "node"));
		await flush();
		expect(app.calls.find((c) => c.path === "/-/api/installations/sheet")?.body)
			.toEqual({
				extId: "tartan.weave",
				version: "0.1.0",
				node: "acme/platform",
				mode: "shadow",
			});
		const sheet = findAll(
			app.root,
			(el) => el.attrs["aria-label"] === "Permission sheet",
		)[0]!;
		expect(text(sheet)).toContain("Land to refs/heads/main");
		expect(text(sheet)).toContain(
			"Replaces tartan.weave as the queue@1 provider",
		);
		expect(
			app.calls.some((c) =>
				c.path === "/-/api/installations" && c.method === "POST"
			),
		)
			.toBe(false);
		submit(formOf(app.root, "node"));
		await flush();
		expect(
			app.calls.find((c) =>
				c.path === "/-/api/installations" && c.method === "POST"
			)?.body,
		)
			.toMatchObject({
				extId: "tartan.weave",
				node: "acme/platform",
				mode: "shadow",
			});
		expect(app.toasts.items.map((t) => t.text)).toContain(
			"tartan.weave installed at acme/platform (shadow).",
		);
	});

	it("swaps the queue@1 provider at a repo: the dry run is the sheet, then the swap", async () => {
		const app = await mountApp("/-/extensions");
		await showInForce(app.root, "acme/platform/router");
		click(button(app.root, "Swap queue@1…"));
		await flush();
		const form = findAll(
			app.root,
			(el) => el.tag === "form" && el.attrs["aria-label"] === "Swap provider",
		)[0]!;
		expect(text(form)).toContain("tartan.weave now");
		// The only other queue@1 package is preselected (the dry run names it).
		expect(text(field(app.root, "swap-to"))).toContain("tartan.fifo@0.1.0");
		expect(field(app.root, "swap-at").value).toBe("acme/platform/router");
		submit(form);
		await flush();
		const dry = app.calls.find((c) =>
			c.path === "/-/api/installations/replace"
		);
		expect(dry?.body).toEqual({
			node: "acme/platform/router",
			iface: "queue@1",
			extId: "tartan.fifo",
			version: "0.1.0",
			dryRun: true,
		});
		const sheet = findAll(
			app.root,
			(el) => el.attrs["aria-label"] === "Swap sheet",
		)[0]!;
		expect(text(sheet)).toContain("Install tartan.fifo@0.1.0 here");
		expect(text(sheet)).toContain("Land to refs/heads/main");
		expect(text(sheet)).toContain("needs an Owner");
		submit(form);
		await flush();
		const swaps = app.calls.filter((c) =>
			c.path === "/-/api/installations/replace"
		);
		expect(swaps).toHaveLength(2);
		expect(swaps[1]!.body).toEqual({
			node: "acme/platform/router",
			iface: "queue@1",
			extId: "tartan.fifo",
			version: "0.1.0",
		});
		const rows = findAll(app.root, (el) => el.tag === "tr").map(text);
		expect(rows.some((r) => r.includes("tartan.fifo"))).toBe(true);
		expect(
			findAll(
				app.root,
				(el) => el.tag === "form" && el.attrs["aria-label"] === "Swap provider",
			),
		).toEqual([]);
	});

	it("replays a shadow gate over history and promotes it", async () => {
		const app = await mountApp("/-/extensions");
		await showInForce(app.root, "acme");
		await app.router.push(
			byText(app.root, "a", "acme.no-secrets")!.attrs["href"]!,
		);
		await flush();
		// A wasm gate: the breaker panel and the replay link are offered.
		expect(text(app.root)).toContain("Circuit breaker");
		// Repo-scoped: the breaker is per repository (blank = the kernel asks).
		type(field(app.root, "breaker-repo"), "acme/platform/router");
		submit(formOf(app.root, "breaker-repo"));
		await flush();
		expect(text(byAttr(app.root, "data-breaker")[0]!)).toContain(
			"1 strike(s) in the last 10 minutes",
		);
		click(button(app.root, "Reset breaker"));
		await flush();
		expect(confirms).toEqual(["Reset the circuit breaker of acme.no-secrets?"]);
		expect(
			app.calls.filter((c) => c.path.includes("/breaker")).map((c) => c.method),
		).toEqual(["GET", "POST"]);
		expect(text(byAttr(app.root, "data-breaker")[0]!)).toContain("0 strike(s)");
		await app.router.push(
			byText(app.root, "a", /Replay its gate over history/)!.attrs["href"]!,
		);
		await flush();
		expect(text(byAttr(app.root, "data-mode")[0]!)).toBe("shadow");
		type(field(app.root, "replay-repo"), "acme/platform/router");
		await flush();
		submit(formOf(app.root, "replay-repo"));
		await flush();
		const replay = app.calls.find((c) => c.path.endsWith("/replay"));
		expect(replay?.body).toEqual({ repo: "acme/platform/router", n: 50 });
		const result = text(byAttr(app.root, "data-replay")[0]!);
		expect(result).toContain("would have vetoed 2 of the last 41 advances");
		expect(result).toContain("AKIA…MPLE");
		click(button(app.root, "Promote to enforce"));
		await flush();
		expect(confirms.at(-1)).toContain("Promote acme.no-secrets to enforce");
		expect(app.calls.some((c) => c.path.endsWith("/promote"))).toBe(true);
		expect(text(byAttr(app.root, "data-mode")[0]!)).toBe("enforce");
		expect(text(app.root)).toContain(
			"Only an installation in shadow mode can be promoted",
		);
	});

	it("changes an installation's mode and shows its settings read-only until M2", async () => {
		const app = await mountApp("/-/extensions");
		await showInForce(app.root, "acme");
		const link = byText(app.root, "a", "tartan.weave")!;
		await app.router.push(link.attrs["href"]!);
		await flush();
		expect(text(app.root)).toContain("Approved permissions");
		click(
			findAll(
				app.root,
				(el) => el.attrs["role"] === "radio" && text(el).startsWith("Shadow"),
			)[0]!,
		);
		await flush();
		expect(confirms).toEqual(["Switch tartan.weave to shadow?"]);
		expect(app.calls.find((c) => c.path.endsWith("/mode"))?.body).toEqual({
			mode: "shadow",
		});
		// The values come from contributes.settings and the config; titles stay
		// text. The kernel has no config route yet: nothing to submit.
		const terms = findAll(app.root, (el) => el.tag === "dt").map(text);
		const details = findAll(app.root, (el) => el.tag === "dd").map(text);
		expect(details[terms.indexOf("Train size")]).toBe("1");
		expect(details[terms.indexOf("Queue label <script>")]).toBe("main");
		expect(findAll(app.root, (el) => el.tag === "script")).toEqual([]);
		expect(byTag(app.root, "form")).toEqual([]);
		expect(text(app.root)).toContain(
			"Changing an extension's settings arrives with milestone M2.",
		);
		expect(app.calls.some((c) => c.path.endsWith("/config"))).toBe(false);
	});

	it("lets an Owner allow repo overrides, and marks an installation that repository config made (WP23)", async () => {
		const app = await mountApp("/-/extensions");
		await showInForce(app.root, "acme");
		await app.router.push(
			byText(app.root, "a", "tartan.weave")!.attrs["href"]!,
		);
		await flush();
		const state = () => text(byAttr(app.root, "data-repo-overrides")[0]!);
		expect(state()).toBe("off");
		click(byText(app.root, "button", "Allow repo overrides")!);
		await flush();
		const put = app.calls.find((c) => c.path.endsWith("/repo-overrides"));
		expect(put?.method).toBe("PUT");
		expect(put?.body).toEqual({ on: true });
		expect(state()).toBe("on");
		expect(byText(app.root, "button", "Stop repo overrides")).not.toBeNull();

		// An installation made from a repo's package tartan: managed there.
		const inner = createMockFetch();
		const managed: FetchLike = async (input, init) => {
			const res = await inner(input, init);
			if (!/^\/-\/api\/installations\/i_[^/]+$/.test(input)) return res;
			const body = await res.json() as Record<string, unknown>;
			return Response.json({
				...body,
				source: "repo-config",
				sourceSha: "a".repeat(40),
				ownerDisabled: true,
			});
		};
		const page0 = put!.path
			.replace(/^\/-\/api\/installations/, "/-/extensions")
			.replace(/\/repo-overrides$/, "");
		const other = await mountApp(page0, { fetch: managed });
		await flush();
		const page = text(other.root);
		expect(page).toContain(
			"managed by package tartan in the repo root at aaaaaaa",
		);
		expect(page).toContain("Disabled by an Owner");
		expect(byText(other.root, "button", "Allow repo overrides")).toBeNull();
	});
});

describe("forge settings and health", () => {
	it("shows the forge name, build, bindings and root-key notice, and only calls routes the kernel serves", async () => {
		const app = await mountApp("/-/settings");
		const page = text(app.root);
		expect(page).toContain("Rawkode Academy");
		expect(page).toContain("Root key held in Durable Object storage");
		expect(page).toContain("ARTIFACTS: ok");
		// No kernel route yet, so the page says when they arrive.
		expect(page).toContain(
			"Moving it into TARTAN_SECRET from here arrives with milestone M2.",
		);
		for (
			const unserved of [
				"/-/api/settings",
				"/-/api/admin/root-key/export",
			]
		) {
			expect(app.calls.some((c) => c.path === unserved), unserved).toBe(false);
		}
	});

	it("shows the last lane-repo self-test and runs one only on request", async () => {
		const app = await mountApp("/-/settings");
		const page = text(app.root);
		expect(page).not.toContain("Arrives with per-agent lane repos");
		expect(page).toContain(
			"Lanes are per-agent Artifacts repositories created with import(), with branch lanes as the fallback.",
		);
		// The mock forge has a stored result: it is shown, nothing is run.
		expect(page).toContain("Per-agent lane repos work");
		const selftest = (method: string) =>
			app.calls.filter((c) =>
				c.path === "/-/api/admin/selftest/lanes" && c.method === method
			).length;
		expect(selftest("GET")).toBe(1);
		expect(selftest("POST")).toBe(0);
		click(button(app.root, "Run the self-test"));
		await flush();
		expect(selftest("POST")).toBe(1);
		expect(text(app.root)).toContain("Per-agent lane repos work");
	});

	it("creates single-use invite links", async () => {
		const app = await mountApp("/-/settings");
		type(field(app.root, "node"), "acme/platform");
		choose(field(app.root, "role"), "Maintainer");
		await flush();
		const form = findAll(
			app.root,
			(el) => el.tag === "form" && text(el).includes("Create invite link"),
		)[0]!;
		submit(form);
		await flush();
		expect(app.calls.find((c) => c.path === "/-/api/invites")?.body).toEqual({
			node: "acme/platform",
			role: 40,
		});
		expect(
			findAll(app.root, (el) => String(el.value).includes("/-/invite/")).length,
		).toBe(1);
	});
});

describe("repo lane settings (Owner)", () => {
	it("shows the effective mode and saves mode, max lanes and attic retention", async () => {
		const app = await mountApp("/acme/platform/router/-/settings");
		const terms = findAll(app.root, (el) => el.tag === "dt").map(text);
		const details = findAll(app.root, (el) => el.tag === "dd").map(text);
		const value = (term: string) => details[terms.indexOf(term)];
		expect(value("Effective mode")).toBe("branch");
		expect(value("Trunk pack estimate")).toBe("4.6 MB");
		expect(value("Retained lane repos")).toContain(
			"0 here · forge ceiling 5000",
		);
		// Every mode the kernel lets an Owner pick is offered: the forge
		// default, the two lane-repo modes and branch lanes; none disabled.
		const options = findAll(
			field(app.root, "laneMode"),
			(el) => el.tag === "option",
		);
		expect(options.map((el) => el.attrs["value"])).toEqual([
			"default",
			"import",
			"branch",
		]);
		expect(options.filter((el) => "disabled" in el.attrs)).toEqual([]);
		choose(field(app.root, "laneMode"), "import");
		await flush();
		const save = button(app.root, "Save lane settings");
		expect("disabled" in save.attrs).toBe(false);
		choose(field(app.root, "laneMode"), "branch");
		type(field(app.root, "atticRetentionDays"), "31");
		await flush();
		expect("disabled" in button(app.root, "Save lane settings").attrs).toBe(
			true,
		);
		type(field(app.root, "atticRetentionDays"), "14");
		await flush();
		submit(findAll(app.root, (el) => el.tag === "form")[0]!);
		await flush();
		expect(app.calls.find((c) => c.method === "PUT")).toMatchObject({
			path: "/-/api/repos/01k6g000000000000000000040/lanes/settings",
			body: {
				laneMode: "branch",
				maxActiveLanes: 2000,
				atticRetentionDays: 14,
			},
		});
	});

	it("clears the override with the forge default", async () => {
		const app = await mountApp("/acme/platform/router/-/settings");
		choose(field(app.root, "laneMode"), "default");
		await flush();
		submit(findAll(app.root, (el) => el.tag === "form")[0]!);
		await flush();
		expect(
			(app.calls.find((c) => c.method === "PUT")?.body as { laneMode: unknown })
				.laneMode,
		)
			.toBeNull();
	});
});

describe("node settings without a repo", () => {
	it("shows group details only", async () => {
		const app = await mountApp("/acme/-/settings");
		expect(text(app.root)).toContain("group");
		expect(byTag(app.root, "form")).toEqual([]);
	});
});
