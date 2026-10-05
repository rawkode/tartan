// `/-/api/swarm[/<id>]` (WP20): start, inspect and
// stop a simulated swarm. Present only on dev stages with dev tools
// (`TARTAN_STAGE` matches `^dev` and `TARTAN_DEV_TOOLS=1`); everywhere else
// every method answers 404, as if the route did not exist. Admin only
// (a session of an admin, or a token with the `admin` scope); agent tokens
// never start a swarm.
//
//   POST   /-/api/swarm[?max=<cap>]  SwarmRequest → 202 {id, …status}
//          (agents above the cap, 300 by default and at most 1,000, are cut
//          to the cap and the status says `capped`)
//   GET    /-/api/swarm             → {swarms: status[]} (newest first)
//   GET    /-/api/swarm/<id>        → status: the plan merged with every
//                                      cohort's counters
//   DELETE /-/api/swarm/<id>        → 202: cohorts stop at their next round
//   DELETE /-/api/swarm             → 202: every swarm stops (reset)

import {
	denied,
	invalid,
	notFound,
	SwarmRequestSchema,
	ulid,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import type { SwarmPlanParams } from "./driver.ts";
import { SWARM_ID_RE, SWARM_LIMITS, swarmInstanceId } from "./plan.ts";
import {
	type Bucket,
	createSwarmStore,
	summarize,
	type SwarmDetail,
	type SwarmStore,
} from "./store.ts";

/** The swarm exists only on dev stages with dev tools on. */
export const swarmEnabled = (
	env: Pick<Env, "TARTAN_STAGE" | "TARTAN_DEV_TOOLS">,
): boolean =>
	/^dev/.test(env.TARTAN_STAGE ?? "") && env.TARTAN_DEV_TOOLS === "1";

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

const requireAdmin = (auth: AuthContext | null): AuthContext => {
	if (auth === null) throw notFound("not found");
	if (auth.kind !== "user") {
		throw denied("actor", "agents cannot run a swarm");
	}
	if (!auth.isAdmin) throw denied("role", "a swarm needs an admin");
	return auth;
};

const readBody = async (req: Request): Promise<unknown> => {
	try {
		return await req.json();
	} catch {
		throw invalid("the body must be JSON");
	}
};

/** `?max=` (the agent cap): 1–1,000, default 300. */
export const capOf = (url: URL): number => {
	const raw = url.searchParams.get("max");
	if (raw === null || raw === "") return SWARM_LIMITS.defaultCap;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > SWARM_LIMITS.maxAgents) {
		throw invalid(`max is an integer from 1 to ${SWARM_LIMITS.maxAgents}`);
	}
	return n;
};

export const statusOf = async (
	store: SwarmStore,
	id: string,
	now: number,
): Promise<SwarmDetail | null> => {
	const plan = await store.readPlan(id);
	if (plan === null) return null;
	const cohorts = await Promise.all(
		plan.plan.cohorts.map((c) => store.readCohort(id, c.index)),
	);
	return summarize(plan, cohorts, await store.stopped(id), now);
};

export type SwarmRouteDeps = {
	readonly store: SwarmStore;
	create(id: string, params: SwarmPlanParams): Promise<void>;
	readonly now: () => number;
	readonly newId: () => string;
};

export const createSwarmHandler = (
	depsOf: (env: Env) => SwarmRouteDeps,
): RouteHandler =>
async (c: RouteContext) => {
	if (!swarmEnabled(c.env)) throw notFound("not found");
	const auth = requireAdmin(c.auth);
	const deps = depsOf(c.env);
	const rest = c.params["rest"] ?? "";
	const method = c.req.method;
	if (rest === "") {
		if (method === "POST") {
			const parsed = SwarmRequestSchema.safeParse(await readBody(c.req));
			if (!parsed.success) {
				throw invalid("not a swarm request", {
					issues: parsed.error.issues.map((i) =>
						`${i.path.join(".") || "(root)"}: ${i.message}`
					),
				});
			}
			const cap = capOf(c.url);
			const id = deps.newId();
			const now = deps.now();
			await deps.create(swarmInstanceId(id), {
				kind: "plan",
				swarmId: id,
				request: parsed.data,
				cap,
				by: auth.principal,
				origin: c.url.origin,
				now,
			});
			return json({
				id,
				state: "planning",
				agents: Math.min(parsed.data.agents, cap),
				capped: parsed.data.agents > cap,
				startedAt: now,
				endsAt: now + parsed.data.minutes * 60_000,
			}, 202);
		}
		if (method === "GET") {
			const ids = await deps.store.list();
			const swarms = (await Promise.all(
				ids.map((id) => statusOf(deps.store, id, deps.now())),
			)).filter((s): s is SwarmDetail => s !== null);
			return json({ swarms });
		}
		if (method === "DELETE") {
			const ids = await deps.store.list(100);
			await Promise.all(ids.map((id) => deps.store.stop(id, deps.now())));
			return json({ stopped: ids }, 202);
		}
		throw invalid("method", { reason: "method" });
	}
	if (!SWARM_ID_RE.test(rest)) throw notFound("no such swarm");
	const status = await statusOf(deps.store, rest, deps.now());
	if (status === null) throw notFound("no such swarm");
	if (method === "GET") return json(status);
	if (method === "DELETE") {
		await deps.store.stop(rest, deps.now());
		return json({ ...status, state: "stopping" }, 202);
	}
	throw invalid("method", { reason: "method" });
};

const productionDeps = (env: Env): SwarmRouteDeps => ({
	store: createSwarmStore(env.BLOBS as unknown as Bucket),
	create: async (id, params) => {
		await env.SWARM.create({ id, params });
	},
	now: () => Date.now(),
	newId: () => `swarm-${ulid().toLowerCase()}`,
});

/** `/-/api/swarm[/*]`: start, inspect, stop a swarm (dev stages with dev tools only). */
export const handleSwarm: RouteHandler = createSwarmHandler(productionDeps);
