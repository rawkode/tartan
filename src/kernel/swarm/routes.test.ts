// `/-/api/swarm`: invisible (404) unless the stage matches
// `^dev` and dev tools are on, for every method; admin users only (agents
// and non-admins refused); the request is the contract's SwarmRequest; the
// agent cap is 300 unless `?max=` raises it (≤ 1,000); start creates the
// plan instance with the caller as `by` and the request's origin; status
// merges the R2 files; DELETE stops one swarm or all of them.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { isTartanError } from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RouteContext } from "../../router.ts";
import type { SwarmPlanParams } from "./driver.ts";
import { planSwarm } from "./plan.ts";
import { capOf, createSwarmHandler, swarmEnabled } from "./routes.ts";
import { createSwarmStore } from "./store.ts";
import { createMemoryBucket } from "./testing/bucket.ts";

const ID = "swarm-01k6zzzzzzzzzzzzzzzzzzzzzz";

const admin: AuthContext = {
	principal: "u_01k6aaaaaaaaaaaaaaaaaaaaaa",
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: true,
} as AuthContext;

const setup = (env: Partial<Env> = {}) => {
	const store = createSwarmStore(createMemoryBucket());
	const created: { id: string; params: SwarmPlanParams }[] = [];
	const handler = createSwarmHandler(() => ({
		store,
		create: (id, params) => {
			created.push({ id, params });
			return Promise.resolve();
		},
		now: () => 1000,
		newId: () => ID,
	}));
	const call = (
		method: string,
		path: string,
		options: { body?: unknown; auth?: AuthContext | null } = {},
	) => {
		const url = new URL(`https://code.example.com${path}`);
		const rest = url.pathname.replace(/^\/-\/api\/swarm\/?/, "");
		const c = {
			req: new Request(url, {
				method,
				...(options.body !== undefined
					? { body: JSON.stringify(options.body) }
					: {}),
			}),
			env: { TARTAN_STAGE: "dev-demo", TARTAN_DEV_TOOLS: "1", ...env } as Env,
			ctx: {} as ExecutionContext,
			url,
			params: rest === "" ? {} : { rest },
			route: { id: "api.swarm", owner: "WP20", policy: {} },
			auth: options.auth === undefined ? admin : options.auth,
		} as unknown as RouteContext;
		return handler(c);
	};
	return { store, created, call };
};

type Json = {
	readonly id: string;
	readonly agents: number;
	readonly capped: boolean;
	readonly state: string;
	readonly cohorts: number;
	readonly swarms: readonly { readonly id: string }[];
	readonly stopped: readonly string[];
};

const read = async (res: Response | Promise<Response>): Promise<Json> =>
	(await (await res).json()) as Json;

const code = async (p: Promise<unknown>, expected: string) =>
	await rejects(p, (e: unknown) => isTartanError(e) && e.code === expected);

const body = {
	repo: "rawkode/platform/edge/router",
	agents: 400,
	workItems: 800,
	minutes: 10,
};

Deno.test("the swarm exists only on dev stages with dev tools on", async () => {
	ok(swarmEnabled({ TARTAN_STAGE: "dev", TARTAN_DEV_TOOLS: "1" }));
	ok(swarmEnabled({ TARTAN_STAGE: "dev-wp20", TARTAN_DEV_TOOLS: "1" }));
	ok(!swarmEnabled({ TARTAN_STAGE: "dev", TARTAN_DEV_TOOLS: "0" }));
	ok(!swarmEnabled({ TARTAN_STAGE: "prod", TARTAN_DEV_TOOLS: "1" }));
	ok(!swarmEnabled({ TARTAN_STAGE: "test", TARTAN_DEV_TOOLS: "1" }));
	for (
		const env of [{ TARTAN_DEV_TOOLS: "0" }, { TARTAN_STAGE: "production" }]
	) {
		const { call, created } = setup(env);
		for (const method of ["GET", "POST", "DELETE"]) {
			await code(
				Promise.resolve().then(() =>
					call(method, "/-/api/swarm", {
						body: method === "POST" ? body : undefined,
					})
				),
				"not_found",
			);
		}
		equal(created.length, 0);
	}
});

Deno.test("admins only: anonymous is 404, agents and non-admins are denied", async () => {
	const { call } = setup();
	await code(
		Promise.resolve().then(() => call("GET", "/-/api/swarm", { auth: null })),
		"not_found",
	);
	await code(
		Promise.resolve().then(() =>
			call("GET", "/-/api/swarm", { auth: { ...admin, kind: "agent" } })
		),
		"denied",
	);
	await code(
		Promise.resolve().then(() =>
			call("GET", "/-/api/swarm", { auth: { ...admin, isAdmin: false } })
		),
		"denied",
	);
});

Deno.test("start: the plan instance with the caller, origin and cap; agents above the cap are cut", async () => {
	const { call, created } = setup();
	const res = await call("POST", "/-/api/swarm", { body });
	equal(res.status, 202);
	const out = await read(res);
	deepStrictEqual(
		{ id: out.id, agents: out.agents, capped: out.capped },
		{ id: ID, agents: 300, capped: true },
	);
	equal(created.length, 1);
	equal(created[0]!.id, ID);
	const params = created[0]!.params;
	equal(params.kind, "plan");
	equal(params.by, admin.principal);
	equal(params.origin, "https://code.example.com");
	equal(params.cap, 300);
	equal(params.request.overlap, 0.15, "the contract's defaults apply");
	const raised = setup();
	const big = await raised.call("POST", "/-/api/swarm?max=1000", { body });
	equal((await read(big)).capped, false);
	equal(raised.created[0]!.params.cap, 1000);
});

Deno.test("start refuses a malformed request and an out-of-range cap", async () => {
	const { call } = setup();
	await code(
		Promise.resolve().then(() =>
			call("POST", "/-/api/swarm", { body: { repo: "x" } })
		),
		"invalid",
	);
	await code(
		Promise.resolve().then(() =>
			call("POST", "/-/api/swarm", { body: { ...body, extra: 1 } })
		),
		"invalid",
	);
	equal(capOf(new URL("https://x/?max=50")), 50);
	for (const max of ["0", "1001", "2.5", "x"]) {
		await code(
			Promise.resolve().then(() => capOf(new URL(`https://x/?max=${max}`))),
			"invalid",
		);
	}
});

Deno.test("status, list and stop", async () => {
	const { call, store } = setup();
	await code(
		Promise.resolve().then(() => call("GET", `/-/api/swarm/${ID}`)),
		"not_found",
	);
	await code(
		Promise.resolve().then(() => call("GET", "/-/api/swarm/nope")),
		"not_found",
	);
	const plan = planSwarm({
		swarmId: ID,
		request: { ...body, overlap: 0.15, hotFiles: 5 },
		now: 0,
	});
	await store.writePlan({
		id: ID,
		state: "running",
		plan,
		by: admin.principal,
		updatedAt: 0,
	});
	const status = await read(call("GET", `/-/api/swarm/${ID}`));
	equal(status.id, ID);
	equal(status.state, "running");
	equal(status.agents, 300);
	equal(status.cohorts, 6);
	const list = await read(call("GET", "/-/api/swarm"));
	deepStrictEqual(list.swarms.map((s) => s.id), [ID]);
	const stopped = await call("DELETE", `/-/api/swarm/${ID}`);
	equal(stopped.status, 202);
	ok(await store.stopped(ID));
	equal(
		(await read(call("GET", `/-/api/swarm/${ID}`))).state,
		"stopping",
	);
	const all = await read(call("DELETE", "/-/api/swarm"));
	deepStrictEqual(all.stopped, [ID]);
});
