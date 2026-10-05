/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The swarm through the real Worker (vitest project `swarm`):
// provisioning with the real ForgeDO tree and registry and RepoDO core (the
// sim group, a shard on the branch backend, the sample monorepo written as a
// K1 seed kernel write, the Swarm pack and the HUD installed), then a paced
// round of simulated agents speaking MCP and git smart HTTP to the Worker's
// own `fetch` with their own tokens: work_create → work_claim → pushes to
// their own lane refs through the gateway → changes_submit →
// changes_get read-your-writes. One agent's push to another's lane
// is refused by the gateway. The HUD (tartan.hud on the namespace) counts
// the agents' lanes. Only the IdP and Artifacts are fakes.
//
// Agents are created with the regular agents API: bulk minting needs dev
// tools in ForgeDO's own env, which the pool runs with `TARTAN_DEV_TOOLS=0`.

import {
	createExecutionContext,
	introspectWorkflowInstance,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoArtifactsName } from "@tartan/contract";
import type { MeResponse, ViewResponse } from "@tartan/contract/api.ts";
import worker from "../../index.ts";
import { settleBackground } from "../../../test/env.ts";
import { b64urlJson } from "../../../web/src/api/client.ts";
import {
	call,
	claimForge,
	env,
	jsonOf,
	type Patched,
	patchGlobals,
	repoke,
} from "../exthost/api/test/worker.ts";
import { newAgent, type SimAgentState } from "./agent.ts";
import { type RoundResult, runRound } from "./cohort.ts";
import { planSwarm } from "./plan.ts";
import { prepareSwarm } from "./setup.ts";
import { createInProcessPort, type Handle } from "./transport.ts";
import type { SwarmWorkflowParams } from "./driver.ts";
import { createSwarmStore } from "./store.ts";
import { createSetupDeps } from "./wiring.ts";

const NAMESPACE = "simns";
const ORIGIN = "https://code.example.com";

let patched: Patched;
let session = "";
let owner = "";
const agents: { handle: string; token: string; id: string }[] = [];
let shard = { path: "", repoId: "" };
let round: RoundResult;

const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
	const res = await call(path, { ...init, cookie: session });
	const body = await jsonOf<T>(res);
	if (res.status >= 300) {
		throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
	}
	return body;
};

/** The Worker's own `fetch`, background work awaited per request. */
const handle: Handle = async (req) => {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	const body = await res.arrayBuffer();
	await waitOnExecutionContext(ctx);
	return new Response(body, { status: res.status, headers: res.headers });
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
	patched = await patchGlobals();
	session = await claimForge(patched);
	owner = (await api<MeResponse>("/-/api/me")).principal!.id;
	await api("/-/api/nodes", {
		method: "POST",
		body: JSON.stringify({ kind: "group", slug: NAMESPACE }),
	});
	const plan = planSwarm({
		swarmId: "swarm-01k6wwwwwwwwwwwwwwwwwwwwww",
		request: {
			repo: `${NAMESPACE}/platform/router`,
			agents: 3,
			workItems: 6,
			overlap: 0.5,
			hotFiles: 2,
			minutes: 5,
		},
		now: Date.now(),
	});
	const [ready] = await prepareSwarm(createSetupDeps(env, owner), plan);
	shard = { path: ready!.path, repoId: ready!.repoId };
	for (const handleName of plan.cohorts[0]!.agents) {
		const created = await api<{ token: string; agent: { id: string } }>(
			"/-/api/agents",
			{
				method: "POST",
				body: JSON.stringify({
					name: handleName,
					tool: "other",
					node: `${NAMESPACE}/sim`,
					maxRole: 30,
				}),
			},
		);
		agents.push({
			handle: handleName,
			token: created.token,
			id: created.agent.id,
		});
	}
	const start = Date.now();
	round = await runRound({
		cfg: {
			swarmId: plan.swarmId,
			repo: shard.path,
			itemsPerAgent: 2,
			pushesPerItem: 2,
			overlap: plan.overlap,
			hotFiles: plan.hotFiles,
			now: () => Date.now(),
		},
		agents: agents.map((a) => newAgent(a.handle)),
		portOf: (h) =>
			createInProcessPort({
				handle,
				origin: ORIGIN,
				token: agents.find((a) => a.handle === h)!.token,
				repo: shard.path,
			}),
		round: 0,
		roundMs: 40_000,
		paceMs: 300,
		now: () => Date.now(),
		sleep,
		probe: true,
	});
	expect(Date.now() - start).toBeLessThan(60_000);
}, 120_000);

afterAll(async () => {
	await settleBackground();
	patched?.restore();
});

describe("swarm through the real Worker", () => {
	it("provisions the shard: branch lanes, the sample monorepo on trunk, the Swarm pack and the HUD", async () => {
		expect(shard.path).toBe(`${NAMESPACE}/sim/router-01`);
		const settings = await api<{ laneMode: string; effectiveMode: string }>(
			`/-/api/repos/${shard.repoId}/lanes/settings`,
		);
		expect(settings.effectiveMode).toBe("branch");
		const tree = await api<{ entries: { name: string }[] }>(
			`/-/api/tree?repo=${encodeURIComponent(shard.path)}&ref=main&path=`,
		);
		expect(tree.entries.map((e) => e.name)).toEqual(
			expect.arrayContaining([
				"pnpm-workspace.yaml",
				"services",
				"packages",
				"apps",
			]),
		);
		const installs = await api<
			{ installations: { installation: { extId: string } }[] }
		>(
			`/-/api/installations?node=${encodeURIComponent(shard.path)}`,
		);
		const ids = installs.installations.map((i) => i.installation.extId);
		expect(ids).toEqual(
			expect.arrayContaining(["tartan.work", "tartan.changes", "tartan.hud"]),
		);
	});

	it("drives every agent through claim, pushes, submit and read-your-writes", () => {
		const { stats } = round;
		expect(round.agents.map((a) => a.phase)).toEqual(["done", "done", "done"]);
		expect(stats.lastError).toBeUndefined();
		expect(stats.errors).toBe(0);
		expect(stats.claims).toBe(6);
		expect(stats.pushes).toBe(12);
		expect(stats.submits).toBe(6);
		expect(stats.rywChecks).toBe(stats.submits);
		expect(stats.rywMismatches).toBe(0);
	});

	it("writes only the agents' own lane refs; trunk is moved only by the kernel", async () => {
		const refs = await (env.ARTIFACTS as unknown as {
			refs(name: string): Promise<Record<string, string>>;
		}).refs(repoArtifactsName(shard.repoId));
		const lanes = Object.keys(refs).filter((r) =>
			r.startsWith("refs/heads/lanes/")
		);
		expect(lanes.length).toBe(6);
		const heads = round.agents.flatMap((a: SimAgentState) =>
			a.lane ? [a.lane.ref] : []
		);
		for (const ref of heads) expect(lanes).toContain(ref);
		expect(
			Object.keys(refs).filter((r) =>
				r.startsWith("refs/heads/") && !r.startsWith("refs/heads/lanes/")
			),
		)
			.toEqual(["refs/heads/main"]);
	});

	it("refuses one agent's push to another agent's lane", () => {
		expect(round.probe).toBe("refused");
		expect(round.stats.pushesRejected).toBe(0);
	});

	it("the HUD on the namespace counts the agents' lanes", async () => {
		const view = await api<ViewResponse>(
			`/-/api/view?path=${NAMESPACE}&view=hud`,
		);
		const metric = view.slots.find((s) =>
			s.ext === "tartan.hud" && s.id === "active-lanes"
		);
		expect(metric).toBeDefined();
		let value = -1;
		for (let i = 0; i < 60 && value < 1; i++) {
			const res = await call(
				`/-/api/slot/${metric!.installationId}/${metric!.id}?ctx=${
					b64urlJson({ node: NAMESPACE })
				}`,
				{ cookie: session },
			);
			const doc = await jsonOf<
				{ root: { children?: { t: string; value?: number }[] } }
			>(res);
			value = doc.root.children?.find((n) => n.t === "stat")?.value ?? -1;
			if (value < 1) {
				if (i % 10 === 9) await repoke();
				await sleep(200);
			}
		}
		// Lanes opened by the round's claims; some may have landed or closed since.
		expect(value).toBeGreaterThanOrEqual(1);
	});

	it("the swarm API is invisible without dev tools and lists swarms with them", async () => {
		const res = await call("/-/api/swarm", { cookie: session });
		expect(res.status).toBe(404);
		const ctx = createExecutionContext();
		const dev = await worker.fetch(
			new Request(`${ORIGIN}/-/api/swarm`, { headers: { cookie: session } }),
			{ ...env, TARTAN_STAGE: "dev-test", TARTAN_DEV_TOOLS: "1" },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(dev.status).toBe(200);
		expect(await dev.json()).toMatchObject({ swarms: expect.any(Array) });
	});
});

describe("SwarmWorkflow in workerd", () => {
	const swarm = env.SWARM as unknown as Workflow<SwarmWorkflowParams>;
	const store = () => createSwarmStore(env.BLOBS);

	it("refuses params that name no swarm, or another instance", async () => {
		const id = `swarm-${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
		const instance = await introspectWorkflowInstance(swarm, id);
		try {
			await swarm.create({
				id,
				params: { repoId: "x", swarmId: "s" } as unknown as SwarmWorkflowParams,
			});
			await instance.waitForStatus("errored");
			expect((await instance.getError()).message).toContain(
				"NonRetryableError",
			);
		} finally {
			await instance.dispose();
		}
	});

	it("a plan provisions its shard, starts its cohort, and a swarm past its end finishes at once", async () => {
		const swarmId = "swarm-01k6vvvvvvvvvvvvvvvvvvvvvv";
		const cohortId = `${swarmId}-c00-g0`;
		const plan = await introspectWorkflowInstance(swarm, swarmId);
		const cohort = await introspectWorkflowInstance(swarm, cohortId);
		try {
			await swarm.create({
				id: swarmId,
				params: {
					kind: "plan",
					swarmId,
					request: {
						repo: `${NAMESPACE}/platform/router`,
						agents: 2,
						workItems: 2,
						overlap: 0,
						hotFiles: 0,
						minutes: 1,
					},
					cap: 300,
					by: owner,
					origin: ORIGIN,
					// Started long ago: its cohorts find the swarm over and end at once.
					now: 0,
				},
			});
			await plan.waitForStatus("complete");
			const planned = await store().readPlan(swarmId);
			expect(planned?.state).toBe("running");
			expect(planned?.shards?.map((x) => x.path)).toEqual([
				`${NAMESPACE}/sim/router-01`,
			]);
			await cohort.waitForStatus("complete");
			const file = await store().readCohort(swarmId, 0);
			expect(file?.state).toBe("done");
			expect(file?.stats.requests).toBe(0);
			const listed = await worker.fetch(
				new Request(`${ORIGIN}/-/api/swarm/${swarmId}`, {
					headers: { cookie: session },
				}),
				{ ...env, TARTAN_STAGE: "dev-test", TARTAN_DEV_TOOLS: "1" },
				createExecutionContext(),
			);
			const status = await listed.json() as { state: string; agents: number };
			expect(status).toMatchObject({ state: "done", agents: 2 });
		} finally {
			await plan.dispose();
			await cohort.dispose();
		}
	});
});
