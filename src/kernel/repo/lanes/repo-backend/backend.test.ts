// The `repo` LaneBackend (K11, U53): `upstream({laneId})` names the lane's
// CURRENT lane repo with a token scoped to it alone, pushes through the lane
// remote are recorded against the lane, `fetchSpec` points at the lane repo,
// and the 24 h token `import()` returns never reaches storage, events or logs.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { LANE_REPO_HEAD_REF, trunkRef } from "@tartan/contract";
import { lsRefs } from "@tartan/gitproto";
import { authorizationFor } from "../../gitremote.ts";
import {
	AGENTS,
	eventsOfType,
	openSeeded,
	pushRepoLane,
	repoLaneTest,
	rowOf,
} from "./testing/lanes.ts";

repoLaneTest(
	"upstream({laneId}) is the lane's own repo, with a token that cannot write trunk or another lane",
	async (h) => {
		const a = await openSeeded(h, AGENTS[0]);
		const b = await openSeeded(h, AGENTS[1]);
		const nameA = rowOf(h, a.id).repo_name as string;
		const nameB = rowOf(h, b.id).repo_name as string;
		const up = await h.core.upstream({ laneId: a.id }, "write");
		equal(up.artifactsName, nameA);
		equal(up.kind, "lane-repo");
		equal(up.ref, LANE_REPO_HEAD_REF);
		equal(up.remote, h.fake.remote(nameA));
		// Cached per (repo, scope): the same token again.
		equal((await h.core.upstream({ laneId: a.id }, "write")).token, up.token);
		// Layer 2: the binding refuses the lane token on trunk and on lane B.
		const status = async (name: string) => {
			const res = await h.fake.fetch(
				new Request(
					`${h.fake.remote(name)}/info/refs?service=git-receive-pack`,
					{ headers: { authorization: authorizationFor(up.token) } },
				),
			);
			await res.body?.cancel();
			return res.status;
		};
		equal(await status(nameA), 200);
		ok(
			[401, 403].includes(await status(h.canonical)),
			"not the canonical repo",
		);
		ok([401, 403].includes(await status(nameB)), "not another lane");
		// The read side answers from the lane repo too.
		const read = await h.core.upstream({ laneId: a.id }, "read");
		const refs = await lsRefs({
			url: read.remote,
			authorization: authorizationFor(read.token),
		}, { refPrefixes: [LANE_REPO_HEAD_REF] });
		deepStrictEqual(refs.map((r) => r.sha), [a.base]);
		// laneFetchSpecs: the lane repo, by SHA, with its own name for the exec.
		const [spec] = await h.core.laneFetchSpecs([a.id]);
		deepStrictEqual(spec, {
			remote: h.fake.remote(nameA),
			sha: a.base,
			token: { artifactsName: nameA, scope: "read" },
		});
	},
);

repoLaneTest(
	"a push through the lane remote records target = the lane and repo_name, and moves lanes.head_sha",
	async (h) => {
		const lane = await openSeeded(h, AGENTS[0]);
		const pushed = await pushRepoLane(h, {
			laneId: lane.id,
			owner: AGENTS[0],
			files: { "src/a.ts": "export const a = 1;\n" },
		});
		const row = rowOf(h, lane.id);
		equal(row.head_sha, pushed.head);
		equal(row.pushes, 1);
		const push = h.storage.sql.exec(
			"SELECT target, repo_name, ref, before, after, via FROM pushes WHERE id = ?",
			pushed.pushId as string,
		).one();
		deepStrictEqual(push, {
			target: lane.id,
			repo_name: row.repo_name,
			ref: LANE_REPO_HEAD_REF,
			before: lane.base,
			after: pushed.head,
			via: "gateway",
		});
		const accepted = eventsOfType(h, "push.accepted").at(-1)?.data as {
			target?: string;
			laneId?: string;
		};
		ok(accepted !== undefined);
		// The trigger event of that push merges into the gateway record (no K2).
		await h.observeAll();
		h.clock.advance(10 * 60 * 1000);
		await h.runTimers();
		equal(rowOf(h, lane.id).quarantined, 0);
		equal(await h.core.resolveRef(lane.id), pushed.head);
		equal(
			await h.core.resolveRef(trunkRef("main")),
			lane.base,
			"trunk did not move",
		);
	},
);

repoLaneTest(
	"the 24 h token import() returns never reaches storage, events or logs",
	async (h) => {
		await openSeeded(h, AGENTS[0]);
		const issued = h.fake.inspect.issuedTokens().filter((t) =>
			t.origin === "import"
		);
		equal(issued.length, 1);
		const secret = issued[0].plaintext;
		const tables = h.storage.sql.exec(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		).toArray().map((r) => r.name as string);
		for (const table of tables) {
			const dump = JSON.stringify(
				h.storage.sql.exec(`SELECT * FROM "${table}"`).toArray(),
			);
			ok(!dump.includes(secret), `token in ${table}`);
		}
		const events = JSON.stringify(h.events.read({ since: 0, limit: 10_000 }));
		ok(!events.includes(secret), "token in events");
		ok(!JSON.stringify(h.logs).includes(secret), "token in logs");
		ok(!JSON.stringify(h.notices).includes(secret), "token in notices");
		// No unredacted capability path in the binding's call log either.
		ok(
			!JSON.stringify(h.fake.calls).match(/\/-\/cap\/v1\/\d{10}\//),
			"cap path redacted",
		);
	},
);
