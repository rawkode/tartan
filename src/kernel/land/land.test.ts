// LandWorkflow end to end on one RepoDO (real core, event log and land
// modules on `node:sqlite`), the testkit FakeArtifacts on loopback (real git
// objects, per-ref CAS, trigger events) and stock git as the sandbox.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	changeRef,
	CHANGES_PREFIX,
	isGerritChangeId,
	NOTES_REF,
	ZERO_SHA,
} from "@tartan/contract";
import { decodeNote, notePaths } from "./notes.ts";
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
	trunkOf,
} from "./testing/lanes.ts";

const AGENTS = [
	"a_01k6eeeeeeeeeeeeeeeeeeeeee",
	"a_01k6ffffffffffffffffffffff",
	"a_01k6gggggggggggggggggggggg",
];

const test = (name: string, fn: (h: LandHarness) => Promise<void>) =>
	Deno.test({
		name,
		ignore: !hasGit,
		sanitizeOps: false,
		sanitizeResources: false,
		fn: async () => {
			const h = await createLandHarness();
			try {
				await fn(h);
			} finally {
				await h.close();
			}
		},
	});

/** Three lanes, each adding its own file, submitted and approved. */
const threeChanges = async (h: LandHarness): Promise<SubmittedChange[]> => {
	const out: SubmittedChange[] = [];
	for (const [i, owner] of AGENTS.entries()) {
		const lane = await pushLane(h, {
			owner,
			files: { [`src/feature-${i}.ts`]: `export const f${i} = ${i};\n` },
		});
		out.push(submitChange(h, lane));
	}
	return out;
};

const commitMessage = async (h: LandHarness, sha: string): Promise<string> => {
	const repo = await h.fake.get(h.canonical);
	return (await repo.readCommit(sha))?.message ?? "";
};

const noTamper = async (h: LandHarness): Promise<void> => {
	await h.observeAll();
	h.clock.advance(10 * 60 * 1000);
	await h.runTimers();
	await h.settle();
	h.clock.advance(10 * 60 * 1000);
	await h.runTimers();
	const types = h.events.read({ since: 0, limit: 10_000 }).map((e) => e.type);
	ok(!types.includes("ref.tampered"), `ref.tampered raised: ${types}`);
};

test("lands 3 changes as a linear chain with trailers, notes and change refs", async (h) => {
	const before = await trunkOf(h);
	const changes = await threeChanges(h);
	const request = landRequest(h, changes);
	const submitted = await h.land.submit(request, QUEUE_INST);
	deepStrictEqual(submitted, { batchId: request.batchId, created: true });
	equal(
		h.instances.length,
		1,
		"the Workflow instance is created after the row",
	);
	for (const c of changes) {
		equal((await h.core.getLane(c.laneId))?.state, "landing");
	}

	const result = await h.drive(request.batchId);
	equal(result.state, "landed");
	equal(result.landed?.length, 3);

	const refs = h.fake.inspect.refs(h.canonical);
	const commits = result.landed?.map((l) => l.commit) ?? [];
	equal(refs["refs/heads/main"], commits[2]);
	// A linear chain: each squash commit's parent is the previous one.
	const repo = await h.fake.get(h.canonical);
	const chain = [before, ...commits];
	for (let i = 1; i < chain.length; i++) {
		const c = await repo.readCommit(chain[i]);
		deepStrictEqual(c?.parents, [chain[i - 1]]);
	}
	// Kernel trailers from verified state; the forged provider one is dropped.
	const message = await commitMessage(h, commits[0]);
	ok(message.startsWith("Change 1\n\nWhy change 1 exists.\n\n"), message);
	const changeIdLine = message.split("\n").find((l) =>
		l.startsWith("Change-Id: ")
	);
	ok(changeIdLine && isGerritChangeId(changeIdLine.slice(11)), message);
	ok(message.includes(`Tartan-Change: ${changes[0].changeId}`), message);
	ok(message.includes("Tartan-Work: acme/shop#1"), message);
	ok(message.includes(`Tartan-Agent: ${AGENTS[0]}`), message);
	ok(!message.includes("forged by the provider"), message);
	ok(
		message.includes(`Tartan-Advance: adv_${request.batchId.slice(3)}_1`),
		message,
	);
	// Change refs keep each landed lane head.
	for (const c of changes) equal(refs[changeRef(c.changeId)], c.head);
	// One why note per landed commit, read by SHA only (K15).
	const notesTip = refs[NOTES_REF];
	ok(notesTip, "refs/notes/tartan exists");
	for (const [i, commit] of commits.entries()) {
		let text: string | null = null;
		for (const path of notePaths(commit)) {
			const blob = await repo.readFile({ ref: notesTip, path });
			if (blob !== null) {
				text = await (blob as Blob).text();
				break;
			}
		}
		const note = text === null ? null : decodeNote(text);
		ok(note, `note for ${commit}`);
		equal(note?.kernel.change, changes[i].changeId);
		equal(note?.kernel.laneHead, changes[i].head);
		equal(note?.kernel.laneHeadRef, `${CHANGES_PREFIX}${changes[i].changeId}`);
		equal(note?.kernel.landedBy, QUEUE_INST);
		equal(note?.kernel.actor, AGENTS[i]);
		equal(note?.kernel.checks.state, "skipped");
		deepStrictEqual(note?.kernel.reason.events, request.reason.events);
	}

	// RepoDO state: index, trunk commits, landings, lanes, events.
	equal(await h.core.resolveRef("refs/heads/main"), commits[2]);
	deepStrictEqual(
		await h.core.trunkSeqs(commits),
		Object.fromEntries(commits.map((c, i) => [c, i + 1])),
	);
	for (const c of changes) {
		const lane = await h.core.getLane(c.laneId);
		equal(lane?.state, "closed", "landed lanes are closed");
		equal(h.landInternal.landingByLaneSync(c.laneId)?.lane_head, c.head);
	}
	const status = await h.land.status(request.batchId);
	equal(status?.state, "landed");
	const { advances } = await h.land.advances({});
	equal(advances.length, 1);
	equal(advances[0].id, `adv_${request.batchId.slice(3)}_1`);
	equal(advances[0].state, "done");
	equal(advances[0].newSha, commits[2]);
	equal(status?.advanceId, advances[0].id);
	const types = h.events.read({ since: 0, limit: 10_000 }).map((e) => e.type);
	for (
		const t of ["land.submitted", "ref.advanced", "land.completed"]
	) ok(types.includes(t), `${t} in ${types}`);

	await noTamper(h);
});

test("a stock clone shows the notes with git log --notes=tartan", async (h) => {
	const changes = await threeChanges(h);
	const request = landRequest(h, changes);
	await h.land.submit(request, QUEUE_INST);
	const result = await h.drive(request.batchId);
	equal(result.state, "landed");
	const repo = await h.fake.get(h.canonical);
	const token = await repo.createToken("read", 600);
	const remote = (await repo.info()).remote;
	const auth = {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`,
	};
	await gitIn(h.home, h.home, ["clone", "-q", remote, "clone"], { env: auth });
	await gitIn(h.home, `${h.home}/clone`, [
		"fetch",
		"-q",
		"origin",
		"refs/notes/*:refs/notes/*",
		`${changeRef(changes[0].changeId)}:refs/remotes/changes/first`,
	], { env: auth });
	const log = await gitIn(h.home, `${h.home}/clone`, [
		"log",
		"--notes=tartan",
		"-3",
		"--format=%s%n%N",
	]);
	ok(log.includes('"v":1'), log);
	ok(log.includes(changes[2].changeId), log);
	equal(
		await gitIn(h.home, `${h.home}/clone`, [
			"rev-parse",
			"refs/remotes/changes/first",
		]),
		changes[0].head,
	);
	const trailers = await gitIn(h.home, `${h.home}/clone`, [
		"log",
		"-1",
		"--format=%(trailers:key=Tartan-Advance,valueonly)",
	]);
	equal(trailers.trim(), `adv_${request.batchId.slice(3)}_1`);
	void ZERO_SHA;
});
