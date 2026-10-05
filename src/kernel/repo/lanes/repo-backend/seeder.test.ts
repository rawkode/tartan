// The lane-repo seeder end to end (WP5b): the REAL RepoDO core (WP5a), event
// log and land modules on `node:sqlite`, this backend, FakeArtifacts on
// loopback whose `import()` pulls through the capability route stand-in, and
// stock git.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	LANE_REPO_HEAD_REF,
	laneArtifactsName,
	trunkRef,
} from "@tartan/contract";
import { seedTimerKey } from "@tartan/contract/kernel.ts";
import { redactedLog } from "./context.ts";
import {
	AGENTS,
	eventsOfType,
	openAs,
	openSeeded,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";

repoLaneTest(
	"a lane opens `opening`, then `open` on its own lane repo seeded with import()",
	async (h) => {
		const trunk = await h.core.resolveRef(trunkRef("main"));
		const lane = await openAs(h, AGENTS[0]);
		equal(lane.state, "opening");
		equal(lane.mode, "repo");
		equal(lane.seed, "import");
		equal(lane.ref, LANE_REPO_HEAD_REF);
		deepStrictEqual(eventsOfType(h, "lane.opening").length, 1);
		await h.settle();
		const opened = await h.core.getLane(lane.id);
		ok(opened !== null);
		equal(opened.state, "open");
		equal(opened.mode, "repo");
		equal(opened.seed, "import");
		equal(opened.base, trunk);
		equal(opened.head, trunk);
		ok(opened.seedMs !== undefined);
		const name = laneArtifactsName(h.repoId, lane.id.slice(3), 1);
		equal(rowOf(h, lane.id).repo_name, name);
		deepStrictEqual(h.fake.inspect.refs(name), {
			[LANE_REPO_HEAD_REF]: trunk,
		});
		const openedEvents = eventsOfType(h, "lane.opened");
		equal(openedEvents.length, 1);
		deepStrictEqual(
			{
				mode: (openedEvents[0].data as { mode: string }).mode,
				seed: (openedEvents[0].data as { seed: string }).seed,
			},
			{ mode: "repo", seed: "import" },
		);
		// The watchdog is gone and the index row is live.
		equal(h.timers.get("core", seedTimerKey(lane.id)), null);
		equal(h.index.get(name)?.state, "live");
		// One GET info/refs and one POST, both reaching RepoDO.
		deepStrictEqual(
			h.capRoute.requests.map((r) => [r.op, r.status]),
			[["info", 200], ["pack", 200]],
		);
	},
);

repoLaneTest(
	"openSeeded helper: four lanes of different agents open concurrently",
	async (h) => {
		const lanes = await Promise.all(AGENTS.map((a) => openAs(h, a)));
		await h.settle();
		for (const lane of lanes) {
			const now = await h.core.getLane(lane.id);
			equal(now?.state, "open", lane.id);
			equal(now?.mode, "repo");
		}
		const again = await openSeeded(h, AGENTS[0]);
		equal(again.state, "open");
	},
);

repoLaneTest(
	"an import error quoting a capability path or an Artifacts token is logged redacted",
	async (h) => {
		const secretPath = `/-/cap/v1/1790000000/ln_01k6eeeeeeeeeeeeeeeeeeeeee/${
			"a".repeat(32)
		}/${"b".repeat(64)}/`;
		const token = `art_v2_x_${"c".repeat(40)}?expires=1790000000`;
		h.fake.faults.inject({
			op: "import",
			times: 1,
			fault: {
				kind: "error",
				code: "INTERNAL_ERROR",
				message:
					`fetch https://git.example.test${secretPath}repo.git failed; token ${token}`,
			},
		});
		const lane = await openAs(h, AGENTS[0]);
		await h.settle();
		const line = h.logs.find((l) => l.message === "import failed");
		ok(line !== undefined, "the failure was logged");
		const text = JSON.stringify(h.logs);
		ok(!text.includes("a".repeat(32)), "no capability nonce");
		ok(!text.includes("b".repeat(64)), "no capability mac");
		ok(!text.includes("c".repeat(40)), "no Artifacts token");
		ok(String(line.data.error).includes("/-/cap/<redacted>/"));
		ok(String(line.data.error).includes("art_v2_<redacted>"));
		equal((await h.core.getLane(lane.id))?.state, "open", "the retry opens it");
		// The production sink redacts what it is handed, too.
		const printed: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void printed.push(args.join(" "));
		try {
			redactedLog("core")(`push ${token}`, { url: secretPath });
		} finally {
			console.error = original;
		}
		equal(printed.length, 1);
		ok(
			!printed[0].includes("c".repeat(40)) &&
				!printed[0].includes("b".repeat(64)),
		);
	},
);
