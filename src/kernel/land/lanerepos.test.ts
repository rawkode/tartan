// LandWorkflow on `repo`-backend lanes (WP10): compose fetches each
// lane head by SHA from its own lane repo with a read token scoped to it,
// `push-refs-n` pushes the change refs WITH objects so the landed heads outlive
// the lane repos, a cold mirror re-fetches them, and the K5 repair does the
// same. Real core + land + event log on `node:sqlite`, FakeArtifacts on
// loopback, stock git as the sandbox, lanes seeded with `import()` through the
// capability route stand-in.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { changeRef, trunkRef } from "@tartan/contract";
import {
	AGENTS,
	eventsOfType,
	openAs,
	openSeeded,
	pushRepoLane,
	repoLaneTest,
	rowOf,
} from "../repo/lanes/repo-backend/testing/lanes.ts";
import {
	createLandHarness,
	gitIn,
	hasGit,
	type LandHarness,
} from "./testing/harness.ts";
import {
	landRequest,
	pushLane,
	QUEUE_INST,
	submitChange,
	type SubmittedChange,
} from "./testing/lanes.ts";
import { createFakeStep } from "./testing/step.ts";

const FILES = [0, 1, 2].map((i) => ({
	[`src/feature-${i}.ts`]: `export const f${i} = ${i};\n`,
}));

/** Three `repo` lanes, each with one pushed commit, submitted and approved. */
const threeRepoChanges = async (h: LandHarness): Promise<SubmittedChange[]> => {
	const out: SubmittedChange[] = [];
	for (const [i, owner] of AGENTS.slice(0, 3).entries()) {
		const lane = await openSeeded(h, owner);
		equal(lane.mode, "repo");
		const pushed = await pushRepoLane(h, {
			laneId: lane.id,
			owner,
			files: FILES[i],
		});
		out.push(submitChange(h, pushed));
	}
	return out;
};

const treeOf = async (h: LandHarness, sha: string): Promise<string> =>
	(await (await h.fake.get(h.canonical)).readCommit(sha))?.treeHash ?? "";

const noTamper = async (h: LandHarness): Promise<void> => {
	await h.observeAll();
	for (let i = 0; i < 3; i++) {
		h.clock.advance(10 * 60 * 1000);
		await h.runTimers();
		await h.settle();
	}
	const types = h.events.read({ since: 0, limit: 10_000 }).map((e) => e.type);
	ok(!types.includes("ref.tampered"), `ref.tampered raised: ${types}`);
	for (
		const row of h.storage.sql.exec("SELECT quarantined FROM lanes").toArray()
	) {
		equal(row.quarantined, 0, "no lane quarantined");
	}
};

repoLaneTest(
	"compose of 3 changes from 3 lane repos lands the same tree as from branch lanes",
	async (h) => {
		const changes = await threeRepoChanges(h);
		const request = landRequest(h, changes);
		await h.land.submit(request, QUEUE_INST);
		const result = await h.drive(request.batchId);
		equal(result.state, "landed", JSON.stringify(result));
		equal(result.landed?.length, 3);
		const trunk = await h.core.resolveRef(trunkRef("main"));
		equal(trunk, result.landed?.[2].commit);

		// The same three heads composed from branch lanes give the same trees.
		if (!hasGit) return;
		const b = await createLandHarness();
		try {
			const branchChanges: SubmittedChange[] = [];
			for (const [i, owner] of AGENTS.slice(0, 3).entries()) {
				const lane = await pushLane(b, { owner, files: FILES[i] });
				branchChanges.push(submitChange(b, lane));
			}
			const br = landRequest(b, branchChanges);
			await b.land.submit(br, QUEUE_INST);
			const landed = await b.drive(br.batchId);
			equal(landed.state, "landed");
			for (const i of [0, 1, 2]) {
				equal(
					await treeOf(h, result.landed?.[i].commit as string),
					await treeOf(b, landed.landed?.[i].commit as string),
					`tree of change ${i + 1}`,
				);
			}
		} finally {
			await b.close();
		}
		await noTamper(h);
	},
);

repoLaneTest(
	"each lane fetch uses a token scoped to its own lane repo",
	async (h) => {
		const changes = await threeRepoChanges(h);
		const request = landRequest(h, changes);
		await h.land.submit(request, QUEUE_INST);
		equal((await h.drive(request.batchId)).state, "landed");
		const laneRemotes = changes.map((c) =>
			h.fake.remote(rowOf(h, c.laneId).repo_name as string)
		);
		const fetches = h.execs.filter((e) => e.argv.includes("fetch"));
		for (const remote of laneRemotes) {
			const using = fetches.filter((e) => e.argv.includes(remote));
			equal(using.length, 1, `one fetch from ${remote}`);
			const headers = Object.entries(using[0].env).filter(([k, v]) =>
				k.startsWith("GIT_CONFIG_KEY_") && v.endsWith(".extraHeader")
			).map(([, v]) => v);
			deepStrictEqual(headers, [`http.${remote}.extraHeader`]);
			equal(using[0].uid, "tartan-git");
		}
		// The binding scopes tokens: a token for lane A cannot read lane B.
		const a = rowOf(h, changes[0].laneId).repo_name as string;
		const bName = rowOf(h, changes[1].laneId).repo_name as string;
		const tokenA = await (await h.fake.get(a)).createToken("read", 600);
		const denied = await h.fake.fetch(
			new Request(`${h.fake.remote(bName)}/info/refs?service=git-upload-pack`, {
				headers: { authorization: `Bearer ${tokenA.plaintext}` },
			}),
		);
		ok(
			denied.status === 401 || denied.status === 403,
			`status ${denied.status}`,
		);
		await denied.body?.cancel();
	},
);

repoLaneTest(
	"the landed heads stay fetchable at refs/tartan/changes/<id> after the lane repos are deleted",
	async (h) => {
		const changes = await threeRepoChanges(h);
		const request = landRequest(h, changes);
		await h.land.submit(request, QUEUE_INST);
		equal((await h.drive(request.batchId)).state, "landed");
		const refs = h.fake.inspect.refs(h.canonical);
		for (const c of changes) equal(refs[changeRef(c.changeId)], c.head);
		// Lane GC deletes the lane repos once the change refs are in the index.
		for (const c of changes) equal(rowOf(h, c.laneId).state, "closed");
		const run = await h.core.gcLanes(h.clock.now() + 25 * 60 * 60 * 1000);
		deepStrictEqual(
			[...run.deleted].sort(),
			changes.map((c) => c.laneId).sort(),
		);
		for (const c of changes) {
			equal(rowOf(h, c.laneId).state, "deleted");
			ok(
				!h.fake.inspect.names().includes(
					rowOf(h, c.laneId).repo_name as string,
				),
			);
		}
		// A stock clone fetches every landed head from the canonical repo.
		const repo = await h.fake.get(h.canonical);
		const token = await repo.createToken("read", 600);
		const remote = (await repo.info()).remote;
		const auth = {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
		};
		await gitIn(h.home, h.home, ["init", "-q", "--bare", "check.git"]);
		for (const c of changes) {
			await gitIn(h.home, `${h.home}/check.git`, [
				"fetch",
				"-q",
				remote,
				`${changeRef(c.changeId)}:refs/check/${c.changeId}`,
			], { env: auth });
			equal(
				await gitIn(h.home, `${h.home}/check.git`, [
					"rev-parse",
					`refs/check/${c.changeId}`,
				]),
				c.head,
			);
		}
		await noTamper(h);
	},
);

repoLaneTest(
	"a container restart before push-refs-n re-fetches the lane heads from their lane repos",
	async (h) => {
		const changes = await threeRepoChanges(h);
		const request = landRequest(h, changes);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.before = async (name) => {
			if (name === "push-refs-1") {
				// The `git:<repoId>` container restarted: its mirror is empty.
				await Deno.remove(h.mirrorRoot, { recursive: true });
				await Deno.mkdir(h.mirrorRoot, { recursive: true });
			}
		};
		equal((await h.drive(request.batchId, step)).state, "landed");
		const refs = h.fake.inspect.refs(h.canonical);
		for (const c of changes) equal(refs[changeRef(c.changeId)], c.head);
		await noTamper(h);
	},
);

repoLaneTest(
	"the K5 repair with a cold mirror pushes the missing change refs with their objects",
	async (h) => {
		const changes = await threeRepoChanges(h);
		const request = landRequest(h, changes);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.failTimes.set("push-refs-1", 100);
		const crashed = await h.drive(request.batchId, step).then(
			() => null,
			(error: unknown) => error,
		);
		ok(crashed !== null, "the instance died after pushing trunk");
		const refsBefore = h.fake.inspect.refs(h.canonical);
		for (const c of changes) {
			equal(refsBefore[changeRef(c.changeId)], undefined);
		}
		// A cold mirror (the container restarted), then the K5 sweeper.
		await Deno.remove(h.mirrorRoot, { recursive: true });
		await Deno.mkdir(h.mirrorRoot, { recursive: true });
		h.instanceStates.set(
			`land-${h.repoId}-${request.batchId.slice(3)}`,
			"errored",
		);
		h.clock.advance(6 * 60 * 1000);
		await h.runTimers();
		await h.settle();
		equal((await h.land.status(request.batchId))?.state, "landed");
		const refs = h.fake.inspect.refs(h.canonical);
		for (const c of changes) equal(refs[changeRef(c.changeId)], c.head);
		await noTamper(h);
	},
);

repoLaneTest(
	"a lane opened while an Advance pushed trunk but not completed opens on import at its new_sha, no strike",
	async (h) => {
		const changes = await threeRepoChanges(h);
		const request = landRequest(h, changes);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		let opened: { laneId: string; trunk: string | null } | null = null;
		step.before = async (name) => {
			if (name !== "push-notes-1" || opened !== null) return;
			const lane = await openAs(h, AGENTS[3]);
			await h.settle();
			opened = {
				laneId: lane.id,
				trunk: h.fake.inspect.refs(h.canonical)["refs/heads/main"] ?? null,
			};
		};
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		ok(opened !== null);
		const { laneId, trunk } = opened as { laneId: string; trunk: string };
		const lane = await h.core.getLane(laneId);
		equal(lane?.state, "open");
		equal(lane?.mode, "repo");
		equal(lane?.seed, "import");
		equal(lane?.base, trunk, "the Advance's new_sha, not the old index tip");
		equal(trunk, result.landed?.[2].commit);
		equal(eventsOfType(h, "lane.seed_failed").length, 0);
		equal(
			h.storage.sql.exec("SELECT v FROM meta WHERE k = 'lane_breaker'")
				.toArray().length,
			0,
		);
	},
);
