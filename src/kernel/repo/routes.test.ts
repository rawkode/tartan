// The lanes HTTP API and the repo cron task (WP5a), against the core module
// on the storage fake: the routes build the K16 actor from the authenticated
// context only, and authorize at the repo node first; the cron sweeps every
// repo, isolating failures.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { denied, type EffectiveRole, type Lane, ROLE } from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { RouteContext } from "../../router.ts";
import type { Env } from "../../env.ts";
import { sweepRepos } from "./cron.ts";
import {
	createLaneSettingsHandler,
	createLanesHandler,
	laneAuthorize,
} from "./routes.ts";
import { createHarness, type Harness, principals } from "./testing/harness.ts";

const authOf = (
	principal: string,
	kind: "user" | "agent" = "agent",
): AuthContext =>
	({
		principal,
		kind,
		via: kind === "agent" ? "agent-token" : "session",
		scopes: ["lanes", "api"],
		nodeId: null,
		laneId: null,
		maxRole: 50,
		isAdmin: false,
	}) as AuthContext;

const envFor = (h: Harness): Env => {
	const node = {
		id: h.nodeId,
		parentId: null,
		kind: "repo",
		slug: "shop",
		path: "acme/shop",
		depth: 1,
		visibility: "private",
		archived: false,
		createdAt: 0,
	};
	return {
		FORGE: {
			getByName: () => ({
				tree: () => ({
					resolvePath: (path: string) =>
						Promise.resolve(path === "acme/shop" ? { node, rest: "" } : null),
					node: (id: string) => Promise.resolve(id === h.nodeId ? node : null),
					listRepos: () =>
						Promise.resolve({ repos: [{ id: h.repoId, path: "acme/shop" }] }),
				}),
			}),
		},
		REPO: { getByName: () => ({ core: () => h.facade }) },
	} as unknown as Env;
};

const allowAll = { createAuthorize: () => () => Promise.resolve(ROLE.owner) };
const denyAll = {
	createAuthorize: () => () => Promise.reject(denied("role", "no role here")),
};

const call = async (
	h: Harness,
	handler: ReturnType<typeof createLanesHandler>,
	method: string,
	path: string,
	auth: AuthContext | null,
	body?: unknown,
	params: Record<string, string> = {},
) => {
	const url = new URL(`https://git.example.test${path}`);
	const rest = url.pathname.replace(/^\/-\/api\/lanes\/?/, "");
	const req = new Request(url, {
		method,
		...(body !== undefined
			? {
				body: JSON.stringify(body),
				headers: { "content-type": "application/json" },
			}
			: {}),
	});
	const c = {
		req,
		env: envFor(h),
		ctx: {} as ExecutionContext,
		url,
		params: { ...(rest ? { rest } : {}), ...params },
		route: { id: "api.lanes", owner: "WP5a", policy: {} },
		auth,
	} as unknown as RouteContext;
	return await handler(c);
};

Deno.test("lanes API: open for the caller, get, list, delegate, close; the actor comes from auth", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const { agent: d } = principals(h);
	const lanes = createLanesHandler(allowAll);
	const opened = await call(h, lanes, "POST", "/-/api/lanes", authOf(a), {
		repo: "acme/shop",
		purpose: "rate limiting",
		footprint: { projects: ["api"], prefixes: [] },
	});
	equal(opened.status, 201);
	const lane = await opened.json() as Lane;
	equal(lane.owner, a);
	equal(lane.state, "open");
	deepStrictEqual(lane.footprint.projects, ["api"]);
	const got = await call(
		h,
		lanes,
		"GET",
		`/-/api/lanes/${lane.id}?repo=acme/shop`,
		authOf(a),
	);
	equal((await got.json() as Lane).id, lane.id);
	const listed = await call(
		h,
		lanes,
		"GET",
		"/-/api/lanes?repo=acme/shop&state=open",
		authOf(a),
	);
	equal((await listed.json() as { lanes: Lane[] }).lanes.length, 1);
	const delegated = await call(
		h,
		lanes,
		"POST",
		`/-/api/lanes/${lane.id}/delegates`,
		authOf(a),
		{ repo: "acme/shop", add: [d] },
	);
	deepStrictEqual((await delegated.json() as Lane).delegates, [d]);
	// Another agent cannot close it (K16 in RepoDO), the owner can.
	const { agent: other } = principals(h);
	const refused = await call(
		h,
		lanes,
		"DELETE",
		`/-/api/lanes/${lane.id}?repo=acme/shop`,
		authOf(other),
	);
	equal(refused.status, 403);
	equal((await refused.json() as { reason: string }).reason, "lane-op");
	const closed = await call(
		h,
		lanes,
		"DELETE",
		`/-/api/lanes/${lane.id}?repo=acme/shop`,
		authOf(a),
	);
	equal(closed.status, 204);
	equal((await h.facade.getLane(lane.id))?.state, "closed");
});

Deno.test("lanes API: anonymous → 401, no role → 403, unknown repo or lane → 404, bad input → 400", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const lanes = createLanesHandler(allowAll);
	equal(
		(await call(h, lanes, "GET", "/-/api/lanes?repo=acme/shop", null)).status,
		401,
	);
	equal(
		(await call(
			h,
			createLanesHandler(denyAll),
			"GET",
			"/-/api/lanes?repo=acme/shop",
			authOf(a),
		))
			.status,
		403,
	);
	equal(
		(await call(h, lanes, "GET", "/-/api/lanes?repo=acme/nope", authOf(a)))
			.status,
		404,
	);
	equal(
		(await call(
			h,
			lanes,
			"GET",
			"/-/api/lanes/ln_01k6c0ffee0000000000000000?repo=acme/shop",
			authOf(a),
		))
			.status,
		404,
	);
	equal((await call(h, lanes, "GET", "/-/api/lanes", authOf(a))).status, 400);
	equal(
		(await call(h, lanes, "POST", "/-/api/lanes", authOf(a), {
			repo: "acme/shop",
		})).status,
		400,
	);
	equal(
		(await call(
			h,
			lanes,
			"GET",
			"/-/api/lanes?repo=acme/shop&state=bogus",
			authOf(a),
		)).status,
		400,
	);
});

/** WP3's authorize in miniature: `claim` needs the `lanes` scope; the role is bounded by `maxRole`. */
const scopedAuthorize = {
	perms: [] as { perm: string; laneId?: string }[],
	createAuthorize: () =>
	(
		auth: AuthContext | null,
		target: { laneId?: string },
		perm: string,
	) => {
		scopedAuthorize.perms.push({
			perm,
			...(target.laneId ? { laneId: target.laneId } : {}),
		});
		if (
			auth !== null && auth.via !== "session" && perm === "claim" &&
			!auth.scopes.includes("lanes")
		) {
			return Promise.reject(denied("scopes", "this token lacks lanes"));
		}
		return Promise.resolve(ROLE.owner);
	},
};

Deno.test("token bounds reach K16 — a capped agent token, a PAT without lanes, an owner's read-only PAT cannot use the Maintainer+/owner paths", async () => {
	const h = await createHarness();
	const { agent: a } = principals(h);
	const { agent: b } = principals(h);
	const { user: owner } = principals(h);
	// Both agents fold in the forge owner's role (50) through the tree.
	h.tree.roles.set(a, ROLE.owner);
	h.tree.roles.set(b, ROLE.owner);
	h.tree.roles.set(owner, ROLE.owner);
	const lanes = createLanesHandler(scopedAuthorize);
	const opened = await call(h, lanes, "POST", "/-/api/lanes", authOf(b), {
		repo: "acme/shop",
		purpose: "b's work",
	});
	const laneB = await opened.json() as Lane;
	// Agent A's default token: maxRole 30. RepoDO bounds the role (30 < 40).
	const capped = { ...authOf(a), maxRole: 30 } as AuthContext;
	const refused = await call(
		h,
		lanes,
		"DELETE",
		`/-/api/lanes/${laneB.id}?repo=acme/shop`,
		capped,
	);
	equal(refused.status, 403);
	equal((await refused.json() as { reason: string }).reason, "lane-op");
	deepStrictEqual(scopedAuthorize.perms.at(-1), {
		perm: "claim",
		laneId: laneB.id,
	});
	// A Maintainer-or-better PAT without the lanes scope: refused at the route…
	const noLanes = {
		...authOf(owner, "user"),
		via: "pat",
		scopes: ["repo:read", "api"],
	} as AuthContext;
	equal(
		(await call(
			h,
			lanes,
			"DELETE",
			`/-/api/lanes/${laneB.id}?repo=acme/shop`,
			noLanes,
		)).status,
		403,
	);
	// …and in RepoDO, whoever calls it.
	await h.facade.closeLane(laneB.id, "x", {
		kind: "user",
		id: owner,
		bounds: {
			maxRole: 50,
			scopes: ["repo:read", "api"],
			nodeId: null,
			laneId: null,
		},
	}).then(
		() => ok(false, "a credential without lanes must not close another's lane"),
		(e: unknown) =>
			equal((e as { reason?: string }).reason ?? "lane-op", "lane-op"),
	);
	// A token pinned to another lane is Reporter at most on this one.
	await h.facade.closeLane(laneB.id, "x", {
		kind: "user",
		id: owner,
		bounds: {
			maxRole: 50,
			scopes: ["lanes"],
			nodeId: null,
			laneId: "ln_01k6c0ffee0000000000000009",
		},
	}).then(
		() => ok(false, "a lane-pinned token must not close another lane"),
		() => undefined,
	);
	// A token scoped to another subtree has no role here.
	await h.facade.closeLane(laneB.id, "x", {
		kind: "user",
		id: owner,
		bounds: {
			maxRole: 50,
			scopes: ["lanes"],
			nodeId: "01k6c0ffee0000000000000077",
			laneId: null,
		},
	}).then(
		() => ok(false, "a token outside the subtree must not close a lane"),
		() => undefined,
	);
	// The owner's read-only PAT cannot add delegates to the owner's own lane.
	const own = await call(
		h,
		lanes,
		"POST",
		"/-/api/lanes",
		authOf(owner, "user"),
		{
			repo: "acme/shop",
			purpose: "owner's work",
		},
	);
	const ownLane = await own.json() as Lane;
	const readOnly = {
		...authOf(owner, "user"),
		via: "pat",
		scopes: ["repo:read", "api"],
	} as AuthContext;
	const delegated = await call(
		h,
		lanes,
		"POST",
		`/-/api/lanes/${ownLane.id}/delegates`,
		readOnly,
		{ repo: "acme/shop", add: [a] },
	);
	equal(delegated.status, 403);
	deepStrictEqual((await h.facade.getLane(ownLane.id))?.delegates, []);
	// An unbounded session of a Maintainer+ still closes it (K16 unchanged).
	equal(
		(await call(
			h,
			lanes,
			"DELETE",
			`/-/api/lanes/${laneB.id}?repo=acme/shop`,
			authOf(owner, "user"),
		)).status,
		204,
	);
});

Deno.test("lane settings route: Owner authorization, then the core's settings (GET, PUT round-trip)", async () => {
	const h = await createHarness();
	const { user: u } = principals(h);
	const settings = createLaneSettingsHandler(denyAll);
	const refused = await call(
		h,
		settings,
		"GET",
		`/-/api/repos/${h.repoId}/lanes/settings`,
		authOf(u, "user"),
		undefined,
		{ repoId: h.repoId },
	);
	equal(refused.status, 403);
	const allowed = await call(
		h,
		createLaneSettingsHandler(allowAll),
		"GET",
		`/-/api/repos/${h.repoId}/lanes/settings`,
		authOf(u, "user"),
		undefined,
		{ repoId: h.repoId },
	);
	// Served by the core on the branch backend.
	equal(allowed.status, 200);
	const defaults = await allowed.json() as Record<string, unknown>;
	equal(defaults.laneMode, "branch");
	equal(defaults.atticRetentionDays, 7);
	h.tree.roles.set(u, ROLE.owner);
	const put = (body: unknown) =>
		call(
			h,
			createLaneSettingsHandler(allowAll),
			"PUT",
			`/-/api/repos/${h.repoId}/lanes/settings`,
			authOf(u, "user"),
			body,
			{ repoId: h.repoId },
		);
	const saved = await put({ maxActiveLanes: 50, atticRetentionDays: 3 });
	equal(saved.status, 200);
	equal(
		((await saved.json()) as { maxActiveLanes: number }).maxActiveLanes,
		50,
	);
	const again = await call(
		h,
		createLaneSettingsHandler(allowAll),
		"GET",
		`/-/api/repos/${h.repoId}/lanes/settings`,
		authOf(u, "user"),
		undefined,
		{ repoId: h.repoId },
	);
	deepStrictEqual(await again.json(), {
		...defaults,
		maxActiveLanes: 50,
		atticRetentionDays: 3,
	});
	// Lanes in their own repositories are an Owner's choice (M2); an
	// impossible value is a 400, not a 501.
	equal((await put({ laneMode: "import" })).status, 200);
	equal((await put({ laneMode: "bogus" as never })).status, 400);
	equal((await put({ maxActiveLanes: 0 })).status, 400);
});

Deno.test("the repo cron sweeps every repo (reconcile + lane GC) and isolates failures", async () => {
	const h = await createHarness();
	const env = envFor(h);
	const outcome = await sweepRepos(env, h.clock.now());
	deepStrictEqual(outcome, { repos: 1, failed: [] });
	ok(h.upstream.lsRefsCalls.length > 0, "reconciled");
	const failing = await sweepRepos(
		env,
		h.clock.now(),
		() => Promise.reject(new Error("boom")),
	);
	deepStrictEqual(failing.failed, [{ repoId: h.repoId, error: "boom" }]);
});

Deno.test("lane reads need a member's Reporter; the public view of a public repo is refused", async () => {
	const node = { id: "n_x", kind: "repo" } as unknown as Parameters<
		ReturnType<typeof laneAuthorize>
	>[1]["node"];
	const authorize = (member: EffectiveRole) =>
		laneAuthorize(() => Promise.resolve({ role: ROLE.reporter, member }));
	const auth = authOf("u_reader", "user");
	// A roleless caller on a public repo: `read` answers Reporter, but no member.
	const refused = await authorize(ROLE.none)(auth, { node }, "read").then(
		() => null,
		(e: { code?: string }) => e.code,
	);
	equal(refused, "denied");
	equal(await authorize(ROLE.reporter)(auth, { node }, "read"), ROLE.reporter);
	// Other permissions keep WP3's answer (claim needs Developer there anyway).
	equal(await authorize(ROLE.none)(auth, { node }, "claim"), ROLE.reporter);
});
