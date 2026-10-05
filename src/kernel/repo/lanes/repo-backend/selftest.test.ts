// The post-claim lane-repo self-test: after a (fake) claim it opens one scratch
// lane through the real seeder and the capability route, `import` only,
// verifies it and deletes both repos; with the route blocked it reports
// `importer-unreachable` and runs no fallback; it never changes `LANE_MODE`.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type LaneSelfTestResult,
	parseArtifactsName,
	type SetupStateDto,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { LANE_MODE } from "../../../../constants.ts";
import type { Env } from "../../../../env.ts";
import type { RouteContext } from "../../../../router.ts";
import {
	createLandHarness,
	hasGit,
	type LandHarness,
} from "../../../land/testing/harness.ts";
import {
	laneSelfTestRoute,
	runLaneSelfTestWith,
	type SelfTestDeps,
} from "./selftest.ts";

const DONE: SetupStateDto = {
	state: "done",
	forgeName: "Tartan test",
	canonicalOrigin: "https://git.example.test",
	rootKeyFallback: false,
};

const depsOf = (
	h: LandHarness,
	stored: LaneSelfTestResult[],
	state: SetupStateDto = DONE,
): SelfTestDeps => ({
	artifacts: h.fake,
	repo: () => ({
		core: () => h.core,
		events: () => ({
			read: (q) => Promise.resolve(h.events.read(q)),
		}),
	}),
	gitJobs: h.gitJobs,
	tree: h.tree,
	setupState: () => Promise.resolve(state),
	store: (result) => {
		stored.push(result);
		return Promise.resolve();
	},
	now: () => h.clock.now(),
	// The harness RepoDO plays the scratch RepoDO: its id is the scratch id.
	ulid: () => h.repoId,
	sleep: (ms) => {
		h.clock.advance(ms);
		return Promise.resolve();
	},
	log: () => {},
});

const selfTest = (
	name: string,
	fn: (h: LandHarness) => Promise<void>,
) =>
	Deno.test({
		name,
		ignore: !hasGit,
		sanitizeOps: false,
		sanitizeResources: false,
		fn: async () => {
			// A scratch RepoDO: not initialized, not a node of the tree, and
			// on a forge whose own LANE_MODE is the branch default.
			const h = await createLandHarness({
				init: false,
				laneMode: "branch",
				ownerLaneModes: ["import", "branch"],
			});
			try {
				await fn(h);
			} finally {
				await h.close();
			}
		},
	});

const laneRepos = (h: LandHarness) =>
	h.fake.inspect.names().filter((n) => parseArtifactsName(n)?.kind === "lane");

selfTest(
	"after a claim it opens and deletes one scratch lane through the real route (import only)",
	async (h) => {
		const stored: LaneSelfTestResult[] = [];
		const result = await runLaneSelfTestWith(
			depsOf(h, stored),
			"u_01k6aaaaaaaaaaaaaaaaaaaaaa",
		);
		equal(result.ok, true, JSON.stringify(result));
		equal(result.seed, "import");
		ok(result.seedMs !== undefined);
		deepStrictEqual(stored, [result]);
		// Both repos are gone again, and their index rows say so.
		deepStrictEqual(h.fake.inspect.names(), []);
		for (const row of h.index.values()) equal(row.state, "deleted", row.name);
		// The route served the import: one info, one pack.
		deepStrictEqual(h.capRoute.requests.map((r) => [r.op, r.status]), [
			["info", 200],
			["pack", 200],
		]);
		equal(LANE_MODE, "branch", "the forge's LANE_MODE is unchanged");
	},
);

selfTest(
	"with /-/cap/* blocked it reports importer-unreachable, runs no fallback and cleans up",
	async (h) => {
		h.capRoute.blocked = true;
		const stored: LaneSelfTestResult[] = [];
		const result = await runLaneSelfTestWith(
			depsOf(h, stored),
			"u_01k6aaaaaaaaaaaaaaaaaaaaaa",
		);
		equal(result.ok, false);
		equal(result.code, "importer-unreachable");
		ok(result.hint?.includes("/-/cap/*"), result.hint);
		deepStrictEqual(stored, [result]);
		// No retry and no branch fallback ran.
		equal(
			h.fake.calls.filter((c) => c.op === "import").length,
			1,
			"one import, no retry",
		);
		const opened = h.events.read({ since: 0, limit: 1000 }).filter((e) =>
			e.type === "lane.opened"
		);
		ok(
			opened.every((e) => (e.data as { mode: string }).mode === "branch"),
			"every lane the probe opened is a branch lane",
		);
		deepStrictEqual(laneRepos(h), []);
		await h.settle();
	},
);

selfTest(
	"before the claim it refuses with a hint and touches nothing",
	async (h) => {
		const stored: LaneSelfTestResult[] = [];
		const result = await runLaneSelfTestWith(
			depsOf(h, stored, { state: "idp", rootKeyFallback: false }),
			"u_01k6aaaaaaaaaaaaaaaaaaaaaa",
		);
		equal(result.ok, false);
		ok(result.hint?.includes("claimed"));
		deepStrictEqual(h.fake.inspect.names(), []);
	},
);

Deno.test("the self-test route: Owner only; POST runs it, GET shows the last result", async () => {
	const result: LaneSelfTestResult = {
		ok: true,
		seed: "import",
		seedMs: 3,
		at: 1,
	};
	const owner = "u_01k6aaaaaaaaaaaaaaaaaaaaaa";
	const handler = laneSelfTestRoute(() => ({
		isOwner: (p) => Promise.resolve(p === owner),
		run: () => Promise.resolve(result),
		last: () => Promise.resolve(result),
	}));
	const ctx = (method: string, auth: Partial<AuthContext> | null) =>
		({
			req: new Request("https://git.example.test/-/api/admin/selftest/lanes", {
				method,
			}),
			url: new URL("https://git.example.test/-/api/admin/selftest/lanes"),
			params: {},
			env: {} as Env,
			ctx: {} as ExecutionContext,
			auth: auth === null ? null : {
				kind: "user",
				via: "session",
				scopes: [],
				nodeId: null,
				laneId: null,
				maxRole: 50,
				isAdmin: true,
				...auth,
			} as AuthContext,
		}) as unknown as RouteContext;
	equal((await handler(ctx("POST", null))).status, 401);
	equal(
		(await handler(ctx("POST", { principal: "u_01k6bbbbbbbbbbbbbbbbbbbbbb" })))
			.status,
		403,
	);
	const ran = await handler(ctx("POST", { principal: owner }));
	equal(ran.status, 200);
	deepStrictEqual(await ran.json(), result);
	const last = await handler(ctx("GET", { principal: owner }));
	deepStrictEqual(await last.json(), { last: result });
	// The Owner's bounded tokens never run it (it creates and deletes
	// Artifacts repos and drains the control bucket).
	for (
		const bounds of [
			{ nodeId: "01k6nnnnnnnnnnnnnnnnnnnnnn" },
			{ maxRole: 20 as const },
			{ isAdmin: false },
			{ laneId: "ln_01k6llllllllllllllllllllll" },
		]
	) {
		const pat = { principal: owner, via: "pat" as const, ...bounds };
		equal(
			(await handler(ctx("POST", pat))).status,
			403,
			JSON.stringify(bounds),
		);
	}
});
