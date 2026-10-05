// Capability state: `capUse` is atomic and single-use
// for the pack request,
// `info` is bounded, a nonce dies when the lane leaves `opening`, reports
// classify failures and measure trunk, and an unexplained upstream tip
// behind `trunk-moved` is a K1 observation.

import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
	fromRpcError,
	LANE_REPO_HEAD_REF,
	laneArtifactsName,
	trunkRef,
} from "@tartan/contract";
import { CAP_INFO_USES_MAX } from "../../../../constants.ts";
import { agentActor } from "../../../land/testing/harness.ts";
import {
	AGENTS,
	openAs,
	openSeeded,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";

/** A lane held `opening` on its first attempt (its import parked at the binding). */
const parkedLane = async (h: Parameters<typeof rowOf>[0]) => {
	const held = h.fake.faults.inject({
		op: "import",
		fault: { kind: "hold" },
		times: 1,
	});
	const lane = await openAs(h, AGENTS[0]);
	const row = rowOf(h, lane.id);
	return { lane, nonce: row.cap_nonce as string, held };
};

repoLaneTest(
	"capUse: ≤ 3 info requests, one pack request, then nothing",
	async (h) => {
		const { lane, nonce, held } = await parkedLane(h);
		for (let i = 0; i < CAP_INFO_USES_MAX; i++) {
			const use = await h.core.capUse(lane.id, nonce, "info");
			ok(use.ok, `info ${i + 1}`);
		}
		deepStrictEqual(await h.core.capUse(lane.id, nonce, "info"), {
			ok: false,
			reason: "uses-exceeded",
		});
		const pack = await h.core.capUse(lane.id, nonce, "pack");
		ok(pack.ok);
		if (pack.ok) {
			equal(pack.ctx.laneId, lane.id);
			equal(pack.ctx.repoId, h.repoId);
			equal(pack.ctx.attempt, 1);
			equal(pack.ctx.base, await h.core.resolveRef(trunkRef("main")));
			equal(pack.ctx.defaultBranch, "main");
			equal(pack.ctx.pinBase, false);
		}
		deepStrictEqual(await h.core.capUse(lane.id, nonce, "pack"), {
			ok: false,
			reason: "consumed",
		});
		deepStrictEqual(await h.core.capUse(lane.id, nonce, "info"), {
			ok: false,
			reason: "consumed",
		});
		equal(
			await h.core.capContext(lane.id, nonce),
			null,
			"a consumed nonce serves nothing",
		);
		deepStrictEqual(
			await h.core.capUse(lane.id, "0".repeat(32), "info"),
			{ ok: false, reason: "unknown" },
		);
		await h.core.closeLane(lane.id, "x", agentActor(AGENTS[0]));
		deepStrictEqual(await h.core.capUse(lane.id, nonce, "info"), {
			ok: false,
			reason: "not-opening",
		});
		held.release();
		await h.settle();
	},
);

repoLaneTest(
	"a nonce dies when its lane opens: a replay after open is refused",
	async (h) => {
		const lane = await openAs(h, AGENTS[0]);
		const nonce = rowOf(h, lane.id).cap_nonce as string;
		ok((await h.core.capContext(lane.id, nonce)) !== null);
		await h.settle();
		equal(rowOf(h, lane.id).state, "open");
		equal(rowOf(h, lane.id).cap_nonce, null);
		equal(await h.core.capContext(lane.id, nonce), null);
		deepStrictEqual(await h.core.capUse(lane.id, nonce, "pack"), {
			ok: false,
			reason: "not-opening",
		});
	},
);

repoLaneTest(
	"capReport: a served pack is the trunk measurement; outcomes classify the nonce",
	async (h) => {
		const { lane, nonce, held } = await parkedLane(h);
		await h.core.capReport(lane.id, nonce, {
			op: "pack",
			bytes: 12_345,
			outcome: "served",
		});
		equal(
			h.storage.sql.exec("SELECT v FROM meta WHERE k = 'trunk_pack_bytes'")
				.one().v,
			"12345",
		);
		equal(rowOf(h, lane.id).cap_outcome, "served");
		await h.core.capReport(lane.id, nonce, { op: "info", outcome: "aborted" });
		equal(rowOf(h, lane.id).cap_outcome, "aborted");
		// Another attempt's (stale) nonce never writes this attempt's outcome.
		await h.core.capReport(lane.id, "1".repeat(32), {
			op: "info",
			outcome: "upstream-error",
		});
		equal(rowOf(h, lane.id).cap_outcome, "aborted");
		for (
			const bad of [
				{ op: "x", outcome: "served" },
				{ op: "pack", outcome: "nope" },
				{ op: "pack", outcome: "served", bytes: -1 },
				{ op: "info", outcome: "trunk-moved", upstreamTip: "zz" },
			]
		) {
			await rejects(
				() => h.core.capReport(lane.id, nonce, bad as never),
				(e: unknown) => fromRpcError(e).code === "invalid",
				JSON.stringify(bad),
			);
		}
		await rejects(
			() => h.core.capUse("ln_x", nonce, "info"),
			(e: unknown) => fromRpcError(e).code === "invalid",
		);
		held.release();
		await h.settle();
	},
);

repoLaneTest(
	"an unexplained upstream tip behind trunk-moved parks a K1 observation; an explained one does not",
	async (h) => {
		const { lane, nonce, held } = await parkedLane(h);
		const trunk = await h.core.resolveRef(trunkRef("main")) as string;
		const explained = "e".repeat(40);
		await h.core.registerKernelWrite({
			target: "repo",
			ref: "refs/heads/main",
			expectOld: trunk,
			newSha: explained,
			purpose: "trunk",
			ownerKind: "land",
			ownerId: "adv_x",
		});
		const use = await h.core.capUse(lane.id, nonce, "info");
		ok(use.ok && use.ctx.explainedTips.includes(explained));
		await h.core.capReport(lane.id, nonce, {
			op: "info",
			outcome: "trunk-moved",
			upstreamTip: explained,
		});
		const count = () =>
			Number(
				h.storage.sql.exec(
					"SELECT COUNT(*) AS n FROM pending_observations WHERE ref = 'refs/heads/main'",
				).one().n,
			);
		equal(count(), 0);
		await h.core.capReport(lane.id, nonce, {
			op: "info",
			outcome: "trunk-moved",
			upstreamTip: "d".repeat(40),
		});
		equal(count(), 1);
		equal(rowOf(h, lane.id).cap_outcome, "trunk-moved");
		held.release();
		await h.settle();
	},
);

repoLaneTest(
	"on a canonical repo whose default branch is master the lane repo still carries exactly refs/heads/main",
	async (h) => {
		const trunk = await h.core.resolveRef(trunkRef("master"));
		ok(trunk);
		const lane = await openSeeded(h, AGENTS[0]);
		equal(lane.state, "open");
		equal(lane.base, trunk);
		const name = laneArtifactsName(h.repoId, lane.id.slice(3), 1);
		deepStrictEqual(h.fake.inspect.refs(name), { [LANE_REPO_HEAD_REF]: trunk });
		equal(h.fake.inspect.repo(name)?.defaultBranch, "main");
	},
	{ defaultBranch: "master" },
);
