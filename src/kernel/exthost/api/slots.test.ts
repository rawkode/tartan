// `/-/api/slot/*` (K12): server-side ctx re-derivation, subtree confinement,
// viewer role checks, read-only render for cross-site GETs, tartan-ui@1
// re-validation.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { type InstallationDto, invalid } from "@tartan/contract";
import { encodeCtxParam } from "./http.ts";
import { renderSlot, sanitizeRender, slotAction } from "./slots.ts";
import {
	agentToken,
	type ApiFixture,
	apiFixture,
	OWNER,
	renderedCtx,
	session,
} from "./test/fixture.ts";

type Body = {
	error?: string;
	message?: string;
	reason?: string;
	root?: { t: string };
};
const jsonOf = (res: Response): Promise<Body> => res.json() as Promise<Body>;

const READER = "u_reader";
const DEV = "u_dev";
const OUTSIDER = "u_outsider";

const setup = async () => {
	const a = apiFixture();
	a.fx.tree.grant("acme/platform", READER, 20);
	a.fx.tree.grant("acme/platform", DEV, 30);
	a.fx.tree.grant("other", OUTSIDER, 50);
	const work = await a.registry.facade.install(OWNER, {
		extId: "tartan.work",
		version: "0.1.0",
		node: "acme/platform",
		mode: "enforce",
	});
	const board = await a.registry.facade.install(OWNER, {
		extId: "tartan.board",
		version: "0.1.0",
		node: "acme",
		mode: "enforce",
	});
	return { a, work, board };
};

const renderReq = (
	inst: InstallationDto,
	slot: string,
	ctx: unknown,
	headers: Record<string, string> = {},
) =>
	new Request(
		`https://forge.test/-/api/slot/${inst.id}/${slot}?ctx=${
			encodeCtxParam(ctx)
		}`,
		{ headers },
	);

const actionReq = (inst: InstallationDto, slot: string, body: unknown) =>
	new Request(`https://forge.test/-/api/slot/${inst.id}/${slot}/action`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const render = (
	a: ApiFixture,
	inst: InstallationDto,
	slot: string,
	ctx: unknown,
	auth = session(READER),
	headers?: Record<string, string>,
) =>
	renderSlot(
		a.deps,
		renderReq(inst, slot, ctx, headers),
		{ installationId: inst.id, slotId: slot },
		auth,
	);

Deno.test("a client-supplied ctx.repo outside the installation subtree is rejected (K12) as not found", async () => {
	const { a, work } = await setup();
	// The outsider is Owner of other/secret, so the refusal is K12, not a role check.
	const res = await render(
		a,
		work,
		"mine",
		{ repo: "other/secret" },
		session(OUTSIDER),
	);
	equal(res.status, 404);
	const body = await jsonOf(res);
	equal(body.error, "not_found");
	equal(a.calls.length, 0);
	// By node id too, and for ctx.node.
	const byId = await render(
		a,
		work,
		"mine",
		{ repo: a.nodeId("other/secret") },
		session(OUTSIDER),
	);
	equal(byId.status, 404);
	const byNode = await render(
		a,
		work,
		"mine",
		{ node: "acme" },
		session(OWNER),
	);
	equal(byNode.status, 404);
	equal(a.calls.length, 0);
});

Deno.test("the anonymous render route is no oracle: missing, outside-subtree and unreadable targets, refs and lanes answer the same 404", async () => {
	const { a, work } = await setup();
	const anon = (ctx: unknown) =>
		renderSlot(
			a.deps,
			renderReq(work, "mine", ctx),
			{ installationId: work.id, slotId: "mine" },
			null,
		);
	const answers = [];
	for (
		const ctx of [
			// A private repo inside the subtree: an existing and a missing branch.
			{ repo: "acme/platform/router", ref: "main" },
			{ repo: "acme/platform/router", ref: "nope" },
			// A missing repo inside the subtree.
			{ repo: "acme/platform/ghost", ref: "main" },
			// Outside the subtree: existing and missing.
			{ repo: "other/secret" },
			{ repo: "other/ghost" },
			// A lane entity on a private repo.
			{
				repo: "acme/platform/router",
				entity: { kind: "lane", id: "ln_01k6c0ffee0000000000000000" },
			},
		]
	) {
		const res = await anon(ctx);
		answers.push([res.status, (await jsonOf(res)).error]);
	}
	deepStrictEqual(answers, Array(answers.length).fill([404, "not_found"]));
	equal(a.calls.length, 0);
	// A signed-in viewer without a role sees the same.
	const outsider = await render(
		a,
		work,
		"mine",
		{ repo: "acme/platform/router", ref: "main" },
		session(OUTSIDER),
	);
	equal(outsider.status, 404);
	// A reader of the repo still gets a precise answer.
	equal(
		(await render(a, work, "mine", {
			repo: "acme/platform/router",
			ref: "nope",
		})).status,
		404,
	);
	equal(
		(await render(a, work, "mine", {
			repo: "acme/platform/router",
			ref: "main",
		})).status,
		200,
	);
});

Deno.test("ctx is re-derived server-side: client values are hints only", async () => {
	const { a, work } = await setup();
	const res = await render(a, work, "mine", {
		repo: "acme/platform/router",
		ref: "main",
	});
	equal(res.status, 200);
	const [call] = a.calls;
	equal(call.method, "render");
	const ctx = renderedCtx(call);
	equal(ctx.slot, "repo.sidebar");
	equal(ctx.repo, a.nodeId("acme/platform/router"));
	equal(ctx.node, a.nodeId("acme/platform/router"));
	equal(ctx.ref, a.sha); // resolved through RepoDO (K15), never the client's spelling
	deepStrictEqual(ctx.extra, { refName: "main" });
	deepStrictEqual(ctx.viewer, { kind: "user", id: READER });
	equal(ctx.mode, "enforce");
	deepStrictEqual(call.scope, {
		kind: "repo",
		repoId: a.nodeId("acme/platform/router"),
	});
	// Unknown hint keys, refs that do not resolve and fields the slot does not take are refused.
	equal(
		(await render(a, work, "mine", {
			repo: "acme/platform/router",
			installation: "x",
		})).status,
		400,
	);
	equal(
		(await render(a, work, "mine", {
			repo: "acme/platform/router",
			ref: "nope",
		})).status,
		404,
	);
	equal(
		(await render(a, work, "mine", {
			repo: "acme/platform/router",
			path: "a.txt",
		})).status,
		400,
	);
	equal((await render(a, work, "mine", { node: "acme/platform" })).status, 400); // repo-scoped slot needs a repo
	equal(
		(await render(a, work, "mine", {
			repo: "acme/platform/router",
			node: "acme/platform/edge",
		})).status,
		400,
	);
});

Deno.test("a render carries the repo's event head read before it ran (the live channel's `since`, e2e comment gap)", async () => {
	const { a, work, board } = await setup();
	const router = a.nodeId("acme/platform/router");
	a.eventHeads.set(router, 41);
	const res = await render(a, work, "mine", { repo: "acme/platform/router" });
	equal(res.status, 200);
	const body = (await res.json()) as { cursor?: number; root: unknown };
	equal(body.cursor, 41);
	ok(body.root);
	// Read before the host rendered: an event after it is after the cursor.
	deepStrictEqual(a.headReads, [{ repoId: router, rendersBefore: 0 }]);
	equal(a.calls.filter((c) => c.method === "render").length, 1);
	// A slot without a repo has no cursor; a failed read only drops it.
	const node = await render(
		a,
		board,
		"summary",
		{ node: "acme/platform" },
		session(OWNER),
	);
	equal(node.status, 200);
	equal(((await node.json()) as { cursor?: number }).cursor, undefined);
	a.eventHeads.set(router, new Error("repo down"));
	const degraded = await render(a, work, "mine", {
		repo: "acme/platform/router",
	});
	equal(degraded.status, 200);
	equal(((await degraded.json()) as { cursor?: number }).cursor, undefined);
});

Deno.test("the viewer's role is checked: Reporter at least, and the slot's declared role", async () => {
	const { a, work, board } = await setup();
	// No role at all on a private repo: indistinguishable from a missing one.
	equal(
		(await render(
			a,
			work,
			"mine",
			{ repo: "acme/platform/router" },
			session(OUTSIDER),
		)).status,
		404,
	);
	// Anonymous on a private repo: 404 too; on a public repo: rendered.
	equal(
		(await renderSlot(
			a.deps,
			renderReq(work, "mine", { repo: "acme/platform/router" }),
			{ installationId: work.id, slotId: "mine" },
			null,
		)).status,
		404,
	);
	const anon = await renderSlot(
		a.deps,
		renderReq(work, "mine", { repo: "acme/platform/edge" }),
		{ installationId: work.id, slotId: "mine" },
		null,
	);
	equal(anon.status, 200);
	equal((a.calls.at(-1)!.args[2] as { kind: string }).kind, "anonymous");
	// node.section declares role 40: a Reporter is refused, the Owner is served.
	equal(
		(await render(a, board, "summary", { node: "acme/platform" })).status,
		403,
	);
	equal(
		(await render(
			a,
			board,
			"summary",
			{ node: "acme/platform" },
			session(OWNER),
		)).status,
		200,
	);
	// A token bounded to another subtree is refused even for a user with
	// grants: it cannot read there, so the repo is not found.
	const bounded = agentToken(OWNER, { nodeId: a.nodeId("other") });
	equal(
		(await render(a, work, "mine", { repo: "acme/platform/router" }, bounded))
			.status,
		404,
	);
});

Deno.test("a slot reached by a cross-site top-level GET cannot change state", async () => {
	const { a, work } = await setup();
	const res = await render(
		a,
		work,
		"mine",
		{ repo: "acme/platform/router" },
		session(DEV),
		{
			"sec-fetch-site": "cross-site",
			"sec-fetch-mode": "navigate",
		},
	);
	equal(res.status, 200);
	deepStrictEqual(a.calls.map((c) => c.method), ["render"]);
	equal(res.headers.get("cache-control"), "private, no-store");
});

Deno.test("render output is re-validated against tartan-ui@1; failures become the error chip", async () => {
	const { a, work } = await setup();
	const evil = [
		{
			v: 1,
			root: { t: "text", text: "x", innerHTML: "<img onerror=alert(1)>" },
		},
		{ v: 1, root: { t: "link", text: "x", href: "//evil.example" } },
		{ v: 1, root: { t: "text", text: "x", style: "position:fixed" } },
		{ v: 1, root: { t: "button", text: "x", onClick: "steal()" } },
		{ v: 1, root: { t: "error-chip", text: "<script>" } },
	];
	for (const doc of evil) {
		a.setHostReply(() => doc);
		const res = await render(a, work, "mine", { repo: "acme/platform/router" });
		equal(res.status, 200);
		// The chip, rebuilt by the host; only the kernel's cursor rides along.
		deepStrictEqual(await res.json(), {
			v: 1,
			root: { t: "error-chip", text: "tartan.work: render failed" },
			cursor: 7,
		});
	}
	a.setHostReply(() => {
		throw new Error("boom");
	});
	const thrown = await render(a, work, "mine", {
		repo: "acme/platform/router",
	});
	equal((await jsonOf(thrown)).root?.t, "error-chip");
	ok(
		sanitizeRender({ v: 1, root: { t: "text", text: "ok" } }, "x").root.t ===
			"text",
	);
});

Deno.test("unknown, disabled or static slots are not rendered", async () => {
	const { a, work, board } = await setup();
	equal(
		(await render(a, work, "nope", { repo: "acme/platform/router" })).status,
		404,
	);
	equal((await render(a, board, "nav", { node: "acme/platform" })).status, 404); // static
	const bad = await renderSlot(a.deps, renderReq(work, "mine", {}), {
		installationId: "i_bad",
		slotId: "mine",
	}, session(READER));
	equal(bad.status, 404);
	await a.registry.facade.setMode(OWNER, work.id, "disabled");
	equal(
		(await render(a, work, "mine", { repo: "acme/platform/router" })).status,
		404,
	);
	equal(a.calls.length, 0);
});

Deno.test("lane entities must belong to the repo; routed tab pages carry their route", async () => {
	const { a, work } = await setup();
	const router = a.nodeId("acme/platform/router");
	const radar = await a.registry.facade.install(OWNER, {
		extId: "tartan.radar",
		version: "0.1.0",
		node: "acme/platform",
		mode: "enforce",
	});
	const laneId = "ln_01k6c0000000000000000000aa";
	a.lanes.set(
		laneId,
		{ id: laneId, repoId: a.nodeId("acme/platform/edge") } as never,
	);
	equal(
		(await render(a, radar, "severity", {
			repo: "acme/platform/router",
			entity: { kind: "lane", id: laneId },
		})).status,
		404,
	);
	a.lanes.set(laneId, { id: laneId, repoId: router } as never);
	equal(
		(await render(a, radar, "severity", {
			repo: "acme/platform/router",
			entity: { kind: "lane", id: laneId },
		})).status,
		200,
	);
	equal(
		(await render(a, radar, "severity", {
			repo: "acme/platform/router",
			entity: { kind: "change", id: "x" },
		})).status,
		400,
	);
	const tab = await render(a, work, "work", {
		repo: "acme/platform/router",
		route: "work",
	});
	equal(tab.status, 200);
	deepStrictEqual(renderedCtx(a.calls.at(-1)!).extra, { route: "work" });
});

Deno.test("actions: POST only through the action handler, signed-in, confined, with the viewer's bounds", async () => {
	const { a, work } = await setup();
	const body = {
		action: "create",
		payload: { title: "x" },
		ctx: { repo: "acme/platform/router" },
	};
	const anon = await slotAction(a.deps, actionReq(work, "new-work", body), {
		installationId: work.id,
		slotId: "new-work",
	}, null);
	equal(anon.status, 401);
	// new-work declares role 30: a Reporter is refused.
	const reader = await slotAction(a.deps, actionReq(work, "new-work", body), {
		installationId: work.id,
		slotId: "new-work",
	}, session(READER));
	equal(reader.status, 403);
	const outside = await slotAction(
		a.deps,
		actionReq(work, "new-work", { ...body, ctx: { repo: "other/secret" } }),
		{ installationId: work.id, slotId: "new-work" },
		session(OUTSIDER),
	);
	equal(outside.status, 404);
	equal((await jsonOf(outside)).error, "not_found");
	// The action body's ctx is the same strict hint (SlotCtxHintSchema).
	const spaShaped = await slotAction(
		a.deps,
		actionReq(work, "new-work", {
			...body,
			ctx: { path: "acme/platform/router", view: "" },
		}),
		{ installationId: work.id, slotId: "new-work" },
		session(DEV),
	);
	equal(spaShaped.status, 400);
	equal((await jsonOf(spaShaped)).message, "invalid ctx");
	equal(a.calls.length, 0);
	const dev = agentToken(DEV, { maxRole: 30 });
	const ok1 = await slotAction(a.deps, actionReq(work, "new-work", body), {
		installationId: work.id,
		slotId: "new-work",
	}, dev);
	equal(ok1.status, 200);
	deepStrictEqual(await ok1.json(), {
		v: 1,
		toast: { tone: "success", text: "done" },
	});
	const [call] = a.calls;
	equal(call.method, "action");
	deepStrictEqual(call.args.slice(0, 3), ["new-work", "create", {
		title: "x",
	}]);
	deepStrictEqual(call.args[4], { kind: "agent", id: DEV });
	deepStrictEqual(call.args[5], {
		maxRole: 30,
		scopes: dev.scopes,
		nodeId: null,
		laneId: null,
	});
	// An invalid action result becomes a toast; an off-origin navigate is refused.
	a.setHostReply(() => ({ v: 1, navigate: "//evil.example" }));
	const nav = await slotAction(a.deps, actionReq(work, "new-work", body), {
		installationId: work.id,
		slotId: "new-work",
	}, dev);
	deepStrictEqual(await nav.json(), {
		v: 1,
		toast: { tone: "danger", text: "tartan.work: action failed" },
	});
	// Non-JSON bodies are refused.
	const form = new Request(
		`https://forge.test/-/api/slot/${work.id}/new-work/action`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "action=create",
		},
	);
	equal(
		(await slotAction(a.deps, form, {
			installationId: work.id,
			slotId: "new-work",
		}, dev)).status,
		415,
	);
});

Deno.test("every slot refusal is logged with ids and codes, never ctx values", async () => {
	const { a, work } = await setup();
	const secret = "acme/platform/router-secret-value";
	const bad = await render(a, work, "mine", { node: secret, view: secret });
	equal(bad.status, 400);
	const hidden = await render(a, work, "mine", { repo: "other/secret" });
	equal(hidden.status, 404);
	const action = await slotAction(
		a.deps,
		actionReq(work, "new-work", {
			action: "create",
			payload: { title: secret },
			ctx: { path: secret, view: "" },
		}),
		{ installationId: work.id, slotId: "new-work" },
		session(DEV),
	);
	equal(action.status, 400);
	const malformed = await renderSlot(
		a.deps,
		renderReq(work, "mine", {}),
		{ installationId: "<script>", slotId: "../x" },
		session(READER),
	);
	equal(malformed.status, 404);
	const refused = (fields: Record<string, unknown>) => ({
		level: "warn",
		event: "slot.refused",
		...fields,
	});
	deepStrictEqual(a.logs, [
		refused({
			route: "slot.render",
			installation: work.id,
			slot: "mine",
			ext: "tartan.work",
			status: 400,
			code: "invalid",
			message: "invalid ctx",
		}),
		refused({
			route: "slot.render",
			installation: work.id,
			slot: "mine",
			ext: "tartan.work",
			status: 404,
			code: "not_found",
			message: (await jsonOf(hidden)).message,
		}),
		refused({
			route: "slot.action",
			installation: work.id,
			slot: "new-work",
			ext: "tartan.work",
			status: 400,
			code: "invalid",
			message: "invalid ctx",
		}),
		refused({
			route: "slot.render",
			installation: "(malformed)",
			slot: "(malformed)",
			status: 404,
			code: "not_found",
			message: (await jsonOf(malformed)).message,
		}),
	]);
	const logged = JSON.stringify(a.logs);
	for (const value of [secret, "other/secret", "<script>", READER, DEV]) {
		ok(!logged.includes(value), `${value} is not logged`);
	}
});

Deno.test("degraded answers (error chip, failed action) are logged with the code only", async () => {
	const { a, work } = await setup();
	const actionBody = {
		action: "create",
		payload: { title: "x" },
		ctx: { repo: "acme/platform/router" },
	};
	const act = () =>
		slotAction(
			a.deps,
			actionReq(work, "new-work", actionBody),
			{ installationId: work.id, slotId: "new-work" },
			session(DEV),
		);
	a.setHostReply(() => {
		throw invalid("the title mentions alice@example.com");
	});
	const chip = await render(a, work, "mine", { repo: "acme/platform/router" });
	equal(chip.status, 200);
	equal((await jsonOf(chip)).root?.t, "error-chip");
	// An extension's own refusal reaches the caller; its text is not logged.
	equal((await act()).status, 400);
	a.setHostReply(() => {
		throw new Error("alice@example.com broke it");
	});
	equal((await act()).status, 200);
	a.setHostReply(() => ({ v: 1, root: { t: "marquee" } }));
	equal(
		(await render(a, work, "mine", { repo: "acme/platform/router" })).status,
		200,
	);
	const ids = { installation: work.id, ext: "tartan.work" };
	deepStrictEqual(a.logs, [
		{
			level: "warn",
			event: "slot.degraded",
			route: "slot.render",
			...ids,
			slot: "mine",
			outcome: "host_error",
			code: "invalid",
		},
		{
			level: "warn",
			event: "slot.refused",
			route: "slot.action",
			...ids,
			slot: "new-work",
			status: 400,
			code: "invalid",
			origin: "extension",
		},
		{
			level: "warn",
			event: "slot.degraded",
			route: "slot.action",
			...ids,
			slot: "new-work",
			outcome: "host_error",
			code: "internal",
		},
		{
			level: "warn",
			event: "slot.degraded",
			route: "slot.render",
			...ids,
			slot: "mine",
			outcome: "invalid_output",
		},
	]);
	ok(!JSON.stringify(a.logs).includes("alice@example.com"));
});

Deno.test("an extension's own refusal reason is logged only when it is a contract reason", async () => {
	const { a, work } = await setup();
	const typed = "alice@example.com wrote:\n" + "x".repeat(5000);
	const act = () =>
		slotAction(
			a.deps,
			actionReq(work, "new-work", {
				action: "create",
				payload: { title: typed },
				ctx: { repo: "acme/platform/router" },
			}),
			{ installationId: work.id, slotId: "new-work" },
			session(DEV),
		);
	// Over RPC only the message survives: `<code>(<reason>): <text>`, with a
	// reason the extension chose (here the viewer's typed text).
	a.setHostReply(() => {
		throw new Error(`invalid(${typed}): bad comment`);
	});
	const free = await act();
	equal(free.status, 400);
	a.setHostReply(() => {
		throw new Error(`denied(${typed}): not yours`);
	});
	equal((await act()).status, 403);
	a.setHostReply(() => {
		throw new Error("denied(role): only a Maintainer resolves");
	});
	equal((await act()).status, 403);
	const line = (status: number, code: string, reason: string) => ({
		level: "warn",
		event: "slot.refused",
		route: "slot.action",
		installation: work.id,
		slot: "new-work",
		ext: "tartan.work",
		status,
		code,
		origin: "extension",
		reason,
	});
	deepStrictEqual(a.logs, [
		line(400, "invalid", "(extension)"),
		line(403, "denied", "(extension)"),
		line(403, "denied", "role"),
	]);
	const logged = JSON.stringify(a.logs);
	ok(!logged.includes("alice@example.com"), "no extension text");
	ok(logged.length < 1000, "bounded");
});

Deno.test("an internal failure is logged at error level with its cause", async () => {
	const { a, work } = await setup();
	const deps = {
		...a.deps,
		registry: () => ({
			...a.deps.registry(),
			installation: () => Promise.reject(new TypeError("registry exploded")),
		}),
	};
	const res = await renderSlot(
		deps,
		renderReq(work, "mine", {}),
		{ installationId: work.id, slotId: "mine" },
		session(READER),
	);
	equal(res.status, 500);
	equal((await jsonOf(res)).message, "internal error");
	deepStrictEqual(a.logs, [{
		level: "error",
		event: "slot.refused",
		route: "slot.render",
		installation: work.id,
		slot: "mine",
		status: 500,
		code: "internal",
		message: "internal error",
		cause: "TypeError: registry exploded",
	}]);
});
