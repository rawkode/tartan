// The fallback chain import > branch, the size estimate and the breaker. Real
// core on the land harness: imports pull through the
// capability route stand-in.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	capPath,
	fromRpcError,
	laneBranchRef,
	trunkRef,
} from "@tartan/contract";
import { setMeta } from "../../core.ts";
import {
	LANE_BREAKER,
	LANE_CAP_TTL_S,
	LANE_IMPORT_MAX_BYTES,
} from "../../../../constants.ts";
import { agentActor } from "../../../land/testing/harness.ts";
import {
	AGENTS,
	eventsOfType,
	openAs,
	openSeeded,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";

type LaneLike = { id: string };

const meta = (h: Parameters<typeof rowOf>[0], key: string): string | null =>
	(h.storage.sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray()[0]
		?.v as string | undefined) ?? null;

const imports = (h: { fake: { calls: readonly { op: string }[] } }) =>
	h.fake.calls.filter((c) => c.op === "import").length;

const failures = (h: Parameters<typeof eventsOfType>[0], laneId?: string) =>
	eventsOfType(h, "lane.seed_failed")
		.map((e) =>
			e.data as {
				laneId: string;
				code: string;
				next: string;
				attempt: number;
				platformFault: boolean;
			}
		)
		.filter((d) => laneId === undefined || d.laneId === laneId);

repoLaneTest(
	"MEMORY_LIMIT sets import_too_large_until and the lane opens as a branch lane without an import retry",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		equal(lane.state, "open");
		equal(lane.mode, "branch");
		equal(lane.seed, undefined);
		equal(imports(h), 1);
		deepStrictEqual(
			failures(h, lane.id).map((f) => [f.code, f.next, f.platformFault]),
			[["lane-too-large", "branch", false]],
		);
		ok(Number(meta(h, "import_too_large_until")) > h.clock.now());
		equal(rowOf(h, lane.id).repo_name, null);
		// The owner is told why its lane is a branch lane.
		deepStrictEqual(
			h.notices.map((n) => [
				n.principal,
				(n.notice.data as { code: string }).code,
			]),
			[[AGENTS[0], "lane-too-large"]],
		);
		// While the flag holds, the next lane skips import.
		const next = await openSeeded(h, AGENTS[1]);
		equal(next.mode, "branch");
		equal(imports(h), 1);
		equal(eventsOfType(h, "lane.mode_degraded").length, 0, "never a strike");
	},
	{ importMaxBytes: 10 },
);

repoLaneTest(
	"INTERNAL_ERROR retries once with a fresh nonce and name (the old capability 404s), then ends on branch with the same lane id",
	async (h) => {
		h.fake.faults.inject({
			op: "import",
			fault: { kind: "error", code: "INTERNAL_ERROR" },
			times: 2,
		});
		const lane = await openAs(h, AGENTS[0]);
		const first = rowOf(h, lane.id);
		await h.settle();
		const opened = await h.core.getLane(lane.id);
		equal(opened?.id, lane.id);
		equal(opened?.state, "open");
		equal(opened?.mode, "branch");
		equal(opened?.ref, laneBranchRef(lane.id));
		equal(opened?.seed, undefined);
		equal(rowOf(h, lane.id).repo_name, null);
		equal(imports(h), 2);
		deepStrictEqual(
			failures(h, lane.id).map((f) => [f.attempt, f.code, f.next]),
			[[1, "importer-unreachable", "import"], [
				2,
				"importer-unreachable",
				"branch",
			]],
		);
		const last = eventsOfType(h, "lane.opened").at(-1)?.data as {
			mode: string;
			reason?: string;
		};
		deepStrictEqual([last.mode, last.reason], [
			"branch",
			"importer-unreachable",
		]);
		// The seed intents are abandoned; the lane is a normal branch lane now.
		const seeds = h.storage.sql.exec(
			"SELECT DISTINCT state FROM kernel_writes WHERE target = ? AND purpose = 'lane-seed'",
			lane.id,
		).toArray().map((r) => r.state);
		ok(seeds.every((s) => s === "abandoned"), JSON.stringify(seeds));
		equal(h.notices.length, 1);
		equal(h.notices[0].principal, AGENTS[0]);
		// Attempt 1's capability, freshly signed, is dead.
		const exp = Math.floor(h.clock.now() / 1000) + LANE_CAP_TTL_S;
		const fields = {
			exp,
			laneId: lane.id,
			nonce: first.cap_nonce as string,
			repoId: h.repoId,
		};
		const mac = await h.capMac.sign(fields);
		const res = await h.capRoute(
			new Request(
				`https://git.example.test${
					capPath({ ...fields, mac })
				}/info/refs?service=git-upload-pack`,
			),
		);
		equal(res.status, 404);
		ok(
			h.capRoute.requests.at(-1)?.reachedDo,
			"the MAC verified; RepoDO refused",
		);
	},
);

repoLaneTest(
	"a trunk estimate above LANE_IMPORT_MAX_BYTES skips import and opens a branch lane",
	async (h) => {
		setMeta(h.storage.sql, "trunk_pack_bytes", LANE_IMPORT_MAX_BYTES + 1);
		const big = await openSeeded(h, AGENTS[0]);
		equal(big.mode, "branch");
		equal(big.state, "open");
		equal(imports(h), 0);
		equal(h.capRoute.requests.length, 0);
	},
);

repoLaneTest(
	"three lanes falling back with a platform fault within 10 minutes degrade the repo for 1 hour",
	async (h) => {
		h.fake.faults.inject({
			op: "import",
			fault: { kind: "error", code: "INTERNAL_ERROR" },
		});
		const opened: LaneLike[] = [];
		for (const agent of AGENTS.slice(0, 3)) {
			const lane = await openSeeded(h, agent);
			equal(lane.mode, "branch");
			opened.push(lane);
			h.clock.advance(60_000);
		}
		const degraded = eventsOfType(h, "lane.mode_degraded");
		equal(degraded.length, 1);
		const data = degraded[0].data as {
			from: string;
			to: string;
			until: number;
			strikes: { laneId: string }[];
		};
		deepStrictEqual([data.from, data.to], ["import", "branch"]);
		deepStrictEqual(
			data.strikes.map((s) => s.laneId).sort(),
			opened.map((l) => l.id).sort(),
		);
		const before = imports(h);
		const fourth = await openSeeded(h, AGENTS[3]);
		equal(fourth.mode, "branch");
		equal(
			imports(h),
			before,
			"the next lane opens as a branch lane without trying import",
		);
		equal((await h.core.laneSettings()).effectiveMode, "branch");
		// After the hour the configured mode is tried again.
		h.clock.advance(LANE_BREAKER.degradeMs + 1);
		await openSeeded(h, AGENTS[3]);
		equal(imports(h), before + 2, "import tried again (and retried once)");
	},
);

repoLaneTest(
	"trunk-moved retries and cancelled lanes never strike",
	async (h) => {
		const trunk = await h.core.resolveRef(trunkRef("main")) as string;
		// A kernel-explained trunk move (an Advance's intent) during each import.
		const moved = "f".repeat(40);
		await h.core.registerKernelWrite({
			target: "repo",
			ref: "refs/heads/main",
			expectOld: trunk,
			newSha: moved,
			purpose: "trunk",
			ownerKind: "land",
			ownerId: "adv_test",
		});
		let first = true;
		h.capRoute.upstreamTip = () => {
			if (!first) return null;
			first = false;
			return moved;
		};
		for (const agent of AGENTS.slice(0, 3)) {
			first = true;
			const lane = await openSeeded(h, agent);
			equal(lane.state, "open");
			equal(lane.seed, "import");
			deepStrictEqual(failures(h, lane.id).map((f) => f.code), ["trunk-moved"]);
		}
		// Three lanes closed while opening.
		for (const agent of AGENTS.slice(0, 3)) {
			const lane = await openAs(h, agent);
			await h.core.closeLane(lane.id, "cancel", agentActor(agent));
		}
		await h.settle();
		equal(eventsOfType(h, "lane.mode_degraded").length, 0);
		const breaker = h.storage.sql.exec(
			"SELECT v FROM meta WHERE k = 'lane_breaker'",
		).toArray();
		equal(breaker.length, 0, "no strike recorded");
		// The explained move parked no K1 observation.
		const parked = h.storage.sql.exec(
			"SELECT COUNT(*) AS n FROM pending_observations",
		).one().n;
		equal(parked, 0);
	},
);

repoLaneTest(
	"the forge ceiling of lane repos opens the lane on branch at once (lane-repo-ceiling)",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		equal(lane.mode, "branch");
		deepStrictEqual(
			failures(h, lane.id).map((f) => [f.code, f.next, f.platformFault]),
			[["lane-repo-ceiling", "branch", false]],
		);
		equal(imports(h), 0, "no capability minted, no import");
		equal(h.capRoute.requests.length, 0);
		// The ceiling is remembered briefly: the next lane plans branch at once.
		const next = await openAs(h, AGENTS[1]);
		equal(next.mode, "branch");
		equal(next.state, "open");
	},
	{ laneRepoCeiling: 0 },
);

repoLaneTest(
	"an index upsert failure mints no capability and ends the attempt interrupted",
	async (h) => {
		const index = h.tree.indexArtifacts.bind(h.tree);
		let calls = 0;
		(h.tree as { indexArtifacts: unknown }).indexArtifacts = (
			input: Parameters<typeof index>[0],
		) => calls++ === 0 ? Promise.reject(new Error("forge down")) : index(input);
		const lane = await openAs(h, AGENTS[0]);
		const firstNonce = rowOf(h, lane.id).cap_nonce;
		await h.settle();
		deepStrictEqual(failures(h, lane.id).map((f) => f.code), ["interrupted"]);
		const row = rowOf(h, lane.id);
		equal(row.state, "open");
		equal(row.seed_attempt, 2);
		// Only attempt 2 reached the route: attempt 1 minted nothing.
		deepStrictEqual(h.capRoute.requests.map((r) => r.op), ["info", "pack"]);
		ok(firstNonce !== null);
		equal(imports(h), 1);
	},
);

repoLaneTest(
	"the 201st active repo lane of one repo gets lane-cap",
	async (h) => {
		const principals = Array.from(
			{ length: 11 },
			(_, i) => `a_01k6zzzzzzzzzzzzzzzzzzzz${i.toString(36).padStart(2, "0")}`,
		);
		let opened = 0;
		for (const principal of principals) {
			for (let i = 0; i < 20 && opened < 200; i++) {
				await openAs(h, principal);
				opened++;
			}
			h.clock.advance(61_000);
		}
		const refused = fromRpcError(
			await openAs(h, principals[10]).catch((e: unknown) => e),
		);
		equal(refused.code, "denied");
		equal(refused.reason, "lane-cap");
		await h.settle();
	},
);
