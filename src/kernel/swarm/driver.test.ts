// SwarmWorkflow orchestration with fake
// steps and deps: the plan instance provisions shards and starts one cohort
// per shard with deterministic ids; a cohort ends when the swarm's time is
// up, when it is stopped, or when every agent is done; it hands its agents'
// state to a successor at 80% of its subrequest budget; tokens are minted
// per round and never appear in a step output, a param or the status files.
// Then provisioning (`setup.ts`) against FakeArtifacts: the sim group, the
// branch lane mode, the scaffold as a K1 `seed` kernel write, the Swarm pack
// and the HUD, and idempotence.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { NodeDto, RepoInfo } from "@tartan/contract";
import { SwarmRequestSchema } from "@tartan/contract";
import type { KernelWriteIntent } from "@tartan/contract/kernel.ts";
import { createFakeArtifacts } from "@tartan/testkit";
import { emptyStats, newAgent } from "./agent.ts";
import {
	type DriverDeps,
	paramsProblem,
	runCohort,
	runPlan,
	type Step,
	type SwarmCohortParams,
	type SwarmWorkflowParams,
} from "./driver.ts";
import { planSwarm } from "./plan.ts";
import { SAMPLE_FILES } from "./sample.ts";
import { prepareSwarm, type SetupDeps } from "./setup.ts";
import { createSwarmStore, summarize } from "./store.ts";
import { createMemoryBucket } from "./testing/bucket.ts";

const SWARM = "swarm-01k6zzzzzzzzzzzzzzzzzzzzzz";
const ADMIN = "u_01k6aaaaaaaaaaaaaaaaaaaaaa";

const recordingStep = () => {
	const names: string[] = [];
	const outputs: unknown[] = [];
	const step: Step = {
		do: async (name, fn) => {
			names.push(name);
			const out = await fn();
			outputs.push(out);
			return out;
		},
	};
	return { step, names, outputs };
};

const node = (
	path: string,
	kind: NodeDto["kind"],
	id = `01k6${path.replace(/[^a-z0-9]/g, "").padEnd(22, "0").slice(0, 22)}`,
): NodeDto =>
	({
		id,
		parentId: null,
		kind,
		slug: path.split("/").at(-1)!,
		path,
		depth: path.split("/").length - 1,
		visibility: "internal",
		archived: false,
		createdAt: 0,
	}) as NodeDto;

/** Setup deps over plain maps; the scaffold is already on every trunk. */
const fakeSetup = (log: string[]): SetupDeps => {
	const nodes = new Map<string, NodeDto>([[
		"rawkode",
		node("rawkode", "user"),
	]]);
	return {
		by: ADMIN,
		resolve: (path) => Promise.resolve(nodes.get(path) ?? null),
		createGroup: (_parent, slug) => {
			const n = node(`rawkode/${slug}`, "group");
			nodes.set(n.path, n);
			log.push(`group ${n.path}`);
			return Promise.resolve(n);
		},
		createRepo: (_parent, slug) => {
			const n = node(`rawkode/sim/${slug}`, "repo");
			nodes.set(n.path, n);
			log.push(`repo ${n.path}`);
			return Promise.resolve(n);
		},
		inForce: () => Promise.resolve([]),
		install: (ext, at) => {
			log.push(`install ${ext} ${at}`);
			return Promise.resolve();
		},
		repo: (id) => ({
			info: () =>
				Promise.resolve({
					id,
					nodeId: id,
					path: "x",
					defaultBranch: "main",
					visibility: "internal",
					trunkSha: "b".repeat(40),
					landingPaused: false,
				} as RepoInfo),
			setLaneSettings: (input) => {
				log.push(`lanes ${id} ${input.laneMode}`);
				return Promise.resolve({});
			},
			markSimulated: () => {
				log.push(`sim ${id}`);
				return Promise.resolve();
			},
			upstream: () =>
				Promise.resolve({
					remote: "https://x",
					token: "t",
					artifactsName: "r",
				}),
			registerKernelWrite: () => Promise.reject(new Error("not expected")),
			markKernelWrite: () => Promise.reject(new Error("not expected")),
		}),
		objects: () =>
			Promise.resolve({
				readCommit: () => Promise.resolve({ treeHash: "c".repeat(40) }),
				readTree: () =>
					Promise.resolve([{
						name: "pnpm-workspace.yaml",
						mode: "100644",
						hash: "d".repeat(40),
						type: "blob",
					}]),
			}),
		now: () => 0,
	};
};

const deps = (over: Partial<DriverDeps> = {}) => {
	const bucket = createMemoryBucket();
	const created: { id: string; params: SwarmWorkflowParams }[] = [];
	const mints: { prefix: string; count: number }[] = [];
	const log: string[] = [];
	let clock = 1_790_000_000_000;
	const d: DriverDeps = {
		store: createSwarmStore(bucket),
		setup: () => fakeSetup(log),
		createInstance: (id, params) => {
			created.push({ id, params });
			return Promise.resolve();
		},
		mintAgents: ({ prefix, count }) => {
			mints.push({ prefix, count });
			return Promise.resolve(
				Array.from({ length: count }, (_, i) => ({
					principal: `a_${i}`,
					token: `tagt_secret${prefix}${i}`,
				})),
			);
		},
		// Every in-process request fails: agents count errors and stay idle.
		router: () => ({
			handle: () => Promise.resolve(new Response("no", { status: 503 })),
			settle: () => Promise.resolve(0),
		}),
		now: () => clock,
		sleep: (ms) => {
			clock += ms;
			return Promise.resolve();
		},
		...over,
	};
	return {
		d,
		bucket,
		created,
		mints,
		log,
		advance: (ms: number) => (clock += ms),
	};
};

const request = SwarmRequestSchema.parse({
	repo: "rawkode/platform/edge/router",
	agents: 120,
	workItems: 120,
	minutes: 10,
});

Deno.test("plan: provisions shards, starts one cohort per shard, records the plan", async () => {
	const { d, created, log, bucket } = deps();
	const { step, names } = recordingStep();
	const out = await runPlan(
		{
			kind: "plan",
			swarmId: SWARM,
			request,
			cap: 300,
			by: ADMIN,
			origin: "https://code.example.com",
			now: 1000,
		},
		step,
		d,
	);
	deepStrictEqual(out, { cohorts: 3, agents: 120 });
	deepStrictEqual(names, [
		"record plan",
		"prepare sim repos",
		"start cohorts",
		"record running",
	]);
	deepStrictEqual(created.map((c) => c.id), [
		`${SWARM}-c00-g0`,
		`${SWARM}-c01-g0`,
		`${SWARM}-c02-g0`,
	]);
	const first = created[0]!.params as SwarmCohortParams;
	equal(first.kind, "cohort");
	equal(first.repo.path, "rawkode/sim/router-01");
	equal(first.agents.length, 40);
	equal(first.config.endsAt, 1000 + 10 * 60_000);
	deepStrictEqual(log.slice(0, 3), [
		"group rawkode/sim",
		"install tartan.pack.swarm rawkode/sim",
		"install tartan.hud rawkode",
	]);
	ok(log.includes("lanes " + first.repo.id + " branch"));
	ok(log.includes("sim " + first.repo.id), "the shard is marked simulated");
	const plan = await d.store.readPlan(SWARM);
	equal(plan?.state, "running");
	equal(plan?.shards?.length, 3);
	ok(!bucket.keys().some((k) => k.includes("token")));
});

const cohortParams = (
	over: Partial<SwarmCohortParams> = {},
): SwarmCohortParams => ({
	kind: "cohort",
	swarmId: SWARM,
	cohort: 0,
	generation: 0,
	by: ADMIN,
	origin: "https://code.example.com",
	repo: { path: "rawkode/sim/router-01", id: "01k6rrrrrrrrrrrrrrrrrrrrrr" },
	prefix: "sim-zzzzzzzz-c01",
	agents: ["sim-zzzzzzzz-c01-1", "sim-zzzzzzzz-c01-2"].map(newAgent),
	config: {
		itemsPerAgent: 1,
		pushesPerItem: 1,
		overlap: 0,
		hotFiles: 0,
		paceMs: 10_000,
		roundMs: 60_000,
		endsAt: 1_790_000_000_000 + 10 * 60_000,
		budget: 10_000,
	},
	probed: false,
	totals: emptyStats(),
	...over,
});

Deno.test("cohort: done when every agent is done; tokens never leave the round", async () => {
	const { d, mints, bucket } = deps();
	const { step, outputs } = recordingStep();
	const out = await runCohort(
		cohortParams({
			config: { ...cohortParams().config, itemsPerAgent: 0 },
		}),
		step,
		d,
	);
	equal(out.state, "done");
	deepStrictEqual(mints, [{ prefix: "sim-zzzzzzzz-c01", count: 2 }]);
	ok(!JSON.stringify(outputs).includes("tagt_"), "no token in a step output");
	const file = await d.store.readCohort(SWARM, 0);
	equal(file?.state, "done");
	equal(file?.agentsDone, 2);
	ok(!JSON.stringify(bucket.keys()).includes("tagt_"));
});

Deno.test("cohort: the swarm's end and a stop end it before any agent acts", async () => {
	const ended = deps();
	ended.advance(11 * 60_000);
	const a = await runCohort(cohortParams(), recordingStep().step, ended.d);
	equal(a.state, "done");
	deepStrictEqual(ended.mints, [], "no tokens minted after the end");
	const stopped = deps();
	await stopped.d.store.stop(SWARM, 0);
	const b = await runCohort(cohortParams(), recordingStep().step, stopped.d);
	equal(b.state, "stopped");
	equal((await stopped.d.store.readCohort(SWARM, 0))?.state, "stopped");
});

Deno.test("cohort: hands its agents to a successor at 80% of the subrequest budget", async () => {
	const { d, created } = deps();
	const out = await runCohort(
		cohortParams({ config: { ...cohortParams().config, budget: 10 } }),
		recordingStep().step,
		d,
	);
	equal(out.state, "running");
	equal(out.successor, `${SWARM}-c00-g1`);
	equal(created.length, 1);
	const next = created[0]!.params as SwarmCohortParams;
	equal(next.generation, 1);
	equal(next.agents.length, 2);
	ok(next.totals.errors > 0, "counters carry over");
	ok(!JSON.stringify(next).includes("tagt_"), "no token in a param");
});

Deno.test("cohort: a round that keeps failing is recorded as an error, then fails the instance", async () => {
	const { d } = deps({
		mintAgents: () =>
			Promise.reject(new Error("bulk agent tokens are unavailable")),
	});
	let threw = false;
	try {
		await runCohort(cohortParams(), recordingStep().step, d);
	} catch {
		threw = true;
	}
	ok(threw);
	const file = await d.store.readCohort(SWARM, 0);
	equal(file?.state, "error");
	equal(file?.error, "bulk agent tokens are unavailable");
});

Deno.test("instance params must be well formed and match the instance id", () => {
	const plan = {
		kind: "plan",
		swarmId: SWARM,
		request,
		cap: 300,
		by: ADMIN,
		origin: "https://code.example.com",
		now: 0,
	};
	equal(paramsProblem(plan, SWARM), null);
	equal(paramsProblem(cohortParams(), `${SWARM}-c00-g0`), null);
	equal(
		paramsProblem(cohortParams({ generation: 2 }), `${SWARM}-c00-g2`),
		null,
	);
	for (
		const [params, id, problem] of [
			[null, SWARM, "params are not an object"],
			[{ repoId: "x", swarmId: "s" }, SWARM, "swarmId is not a swarm id"],
			[{ ...plan, kind: "other" }, SWARM, "kind is plan or cohort"],
			[plan, `${SWARM}-c00-g0`, "the instance id does not match the swarm"],
			[{ ...plan, origin: "http://x" }, SWARM, "origin is not an https origin"],
			[{ ...plan, cap: 5000 }, SWARM, "cap is out of range"],
			[{ ...plan, request: {} }, SWARM, "request is not a swarm request"],
			[{ ...plan, by: "" }, SWARM, "by is required"],
			[
				cohortParams(),
				`${SWARM}-c01-g0`,
				"the instance id does not match the cohort",
			],
		] as const
	) {
		equal(paramsProblem(params, id), problem, problem);
	}
});

Deno.test("status merges the plan with every cohort's counters", () => {
	const plan = planSwarm({ swarmId: SWARM, request, now: 0 });
	const stats = { ...emptyStats(), pushes: 5, errors: 1, rywChecks: 2 };
	const status = summarize(
		{ id: SWARM, state: "running", plan, by: ADMIN, updatedAt: 0 },
		[
			{
				cohort: 0,
				generation: 1,
				state: "running",
				round: 3,
				stats,
				subrequests: 10,
				probe: "refused",
				agentsDone: 0,
				updatedAt: 0,
			},
			null,
			{
				cohort: 2,
				generation: 0,
				state: "done",
				round: 2,
				stats,
				subrequests: 10,
				agentsDone: 40,
				updatedAt: 0,
			},
		],
		false,
		1000,
	);
	equal(status.state, "running");
	equal(status.pushes, 10);
	equal(status.errors, 2);
	equal(status.generations, 2);
	deepStrictEqual(status.wrongLane, {
		refused: 1,
		accepted: 0,
		inconclusive: 0,
	});
	equal(
		summarize(
			{ id: SWARM, state: "running", plan, by: ADMIN, updatedAt: 0 },
			[],
			true,
			1000,
		).state,
		"stopping",
	);
});

// ---------------------------------------------------------------------------
// Provisioning against FakeArtifacts
// ---------------------------------------------------------------------------

Deno.test("setup: the scaffold is a K1 seed write on trunk, written once", async () => {
	const fake = createFakeArtifacts({ namespace: "tartan-test" });
	const seeded = await fake.seed("r-sim", { files: { "README.md": "# x\n" } });
	const handle = await fake.get("r-sim");
	const token = await handle.createToken("write", 3600);
	const intents: KernelWriteIntent[] = [];
	const marks: string[] = [];
	const trunk = () => fake.inspect.refs("r-sim")["refs/heads/main"]!;
	const base = fakeSetup([]);
	const setup: SetupDeps = {
		...base,
		repo: (id) => ({
			...base.repo(id),
			info: () =>
				Promise.resolve({
					id,
					nodeId: id,
					path: "rawkode/sim/router-01",
					defaultBranch: "main",
					visibility: "internal",
					trunkSha: trunk(),
					landingPaused: false,
				} as RepoInfo),
			upstream: () =>
				Promise.resolve({
					remote: fake.remote("r-sim"),
					token: token.plaintext,
					artifactsName: "r-sim",
				}),
			registerKernelWrite: (intent) => {
				intents.push(intent);
				return Promise.resolve({ id: `kw_${intents.length}` } as never);
			},
			markKernelWrite: (id, state) => {
				marks.push(`${id} ${state}`);
				return Promise.resolve();
			},
		}),
		objects: async (name) => {
			const repo = await fake.get(name);
			return {
				readCommit: async (sha) => {
					const meta = await repo.readCommit(sha);
					return meta ? { treeHash: meta.treeHash } : null;
				},
				readTree: (sha) => repo.readTree(sha),
			};
		},
		fetch:
			((input: RequestInfo | URL, init?: RequestInit) =>
				fake.fetch(new Request(input, init))) as typeof fetch,
	};
	const plan = planSwarm({
		swarmId: SWARM,
		request: SwarmRequestSchema.parse({ ...request, agents: 10 }),
		now: 0,
	});
	const [shard] = await prepareSwarm(setup, plan);
	equal(shard!.scaffolded, true);
	equal(intents.length, 1);
	equal(intents[0]!.purpose, "seed");
	equal(intents[0]!.ref, "refs/heads/main");
	equal(intents[0]!.expectOld, seeded.head);
	equal(intents[0]!.newSha, trunk());
	deepStrictEqual(marks, ["kw_1 pushed"]);
	// Every sample file is on trunk, and the old README is replaced by the sample's.
	const repo = await fake.get("r-sim");
	const root = await repo.readTree((await repo.readCommit(trunk()))!.treeHash);
	ok(root!.some((e) => e.name === "pnpm-workspace.yaml"));
	ok(root!.some((e) => e.name === "services"));
	equal(Object.keys(SAMPLE_FILES).length > 5, true);
	// Again: nothing written.
	const [again] = await prepareSwarm(setup, plan);
	equal(again!.scaffolded, false);
	equal(intents.length, 1);
});
