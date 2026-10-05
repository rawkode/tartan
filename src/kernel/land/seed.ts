// Dev-only audited history seeding (WP10): `seedHistory({count, actor})` writes
// `count` Advances on trunk so a shadow gate has a history to be replayed over
// ("acme.no-secrets would have vetoed 2 of the last 41 advances").
//
// - Dev tools only (`TARTAN_STAGE` ^dev and `TARTAN_DEV_TOOLS=1`);
//   anywhere else the method answers `not_found`.
// - One commit per Advance on top of trunk's tip, each appending a line to
//   `SEEDED_HISTORY.md`; two of them (about 30 % and 75 % of the way) also
//   add a `.env` file holding AWS's documented example access key id, so a
//   secret-scanning gate has something to veto. Nothing real is written.
// - The commits go to trunk in ONE push through the K1 ledger (purpose
//   `seed`, owner `seed:<first batch>`): the intent is registered first,
//   then pushed, then marked `pushed`, which applies it to the ref index
//   and the push log, as every kernel write (K1).
// - Each commit gets its own land batch (state `landed`, reason "seeded
//   history", candidate swept) and one `done` Advance `expectOld..newSha`,
//   so `/-/api/advances` and the gate replay read them like real ones.
//   They are labelled: the batches' reason carries `seeded: true` and the
//   Advances' owner instance is `seed-<batch>` (`AdvanceDto.seeded`).
// - No events are appended: a seeded Advance never ran gates, notified a
//   subscriber or landed a change.

import {
	type Actor,
	advanceId,
	conflict,
	invalid,
	notFound,
	repoArtifactsName,
	ZERO_SHA,
} from "@tartan/contract";
import type { RepoStore } from "@tartan/contract/kernel.ts";
import {
	encodeCommit,
	encodeTree,
	type PackObject,
	writePack,
} from "@tartan/gitproto";
import { first, indexSha, type LandCtx, repoIds } from "./ctx.ts";
import { createCanonicalAccess } from "./upstream.ts";

/** At most this many Advances per call (the replay reads ≤ 50). */
export const SEED_MAX = 100;
/** The file every seeded commit appends a line to. */
export const SEEDED_FILE = "SEEDED_HISTORY.md";
/** AWS's documented example access key id (never a real credential). */
export const SEED_FAKE_KEY = "AKIAIOSFODNN7EXAMPLE";
/** The owner instance of every seeded Advance starts with this. */
export const SEED_INSTANCE_PREFIX = "seed-";
/** Seeded commits are a minute apart, ending now. */
const SEED_SPACING_S = 60;

/** 1-based positions of the commits that carry a fake key (two, from 2 up). */
export const fakeKeyPositions = (count: number): readonly number[] =>
	count < 2 ? [] : [
		Math.max(1, Math.round(count * 0.3)),
		Math.max(2, Math.round(count * 0.75)),
	];

export type SeedDeps = {
	readonly artifacts: RepoStore;
	/** Dev tools are on. */
	readonly devTools: boolean;
};

export type SeedResult = {
	readonly advances: number;
	readonly batches: readonly string[];
	readonly head: string;
	readonly withFakeKeys: readonly number[];
};

const encoder = new TextEncoder();

const validCount = (count: unknown): number => {
	if (
		typeof count !== "number" || !Number.isInteger(count) || count < 1 ||
		count > SEED_MAX
	) {
		throw invalid(`count is 1–${SEED_MAX}`);
	}
	return count;
};

export const createSeeder = (ctx: LandCtx, deps: () => SeedDeps) => {
	const seedHistory = async (
		input: { count: number; actor: Actor },
	): Promise<SeedResult> => {
		const { artifacts, devTools } = deps();
		if (!devTools) throw notFound("not found");
		const count = validCount(input?.count);
		const actor = input?.actor;
		if (
			actor === undefined || typeof actor.id !== "string" ||
			actor.id.length === 0
		) {
			throw invalid("actor is required");
		}
		const ids = repoIds(ctx);
		const base = indexSha(ctx, ids.trunkRef);
		if (base === null || base === ZERO_SHA) {
			throw invalid("the repo has no trunk to seed on");
		}
		const inflight = first<{ id: string }>(
			ctx.sql,
			"SELECT id FROM advances WHERE ref = ? AND state IN ('locked','pushing')",
			ids.trunkRef,
		);
		if (inflight !== null) {
			throw conflict(`an Advance is in flight on ${ids.trunkRef}`);
		}

		const repo = await artifacts.get(repoArtifactsName(ids.repoId));
		const baseCommit = await repo.readCommit(base);
		if (baseCommit === null) throw notFound(`no commit ${base}`);
		const rootEntries = (await repo.readTree(baseCommit.treeHash)) ?? [];
		const logEntry = rootEntries.find((e) => e.name === SEEDED_FILE);
		const existingLog = logEntry === undefined
			? ""
			: (await (await repo.readBlob(logEntry.hash))?.text()) ?? "";

		const keys = new Set(fakeKeyPositions(count));
		const now = Math.floor(ctx.clock.now() / 1000);
		const objects: PackObject[] = [];
		const commits: { sha: string; parent: string; key: boolean }[] = [];
		let parent = base;
		let log = existingLog;
		let tree = rootEntries.map((e) => ({
			mode: e.mode as "100644",
			name: e.name,
			id: e.hash,
		}));
		for (let i = 1; i <= count; i++) {
			log += `- seeded advance ${i} of ${count} (dev only, labelled seeded)\n`;
			const added: { name: string; content: string }[] = [
				{ name: SEEDED_FILE, content: log },
			];
			if (keys.has(i)) {
				added.push({
					name: `seeded-${i}.env`,
					content:
						`# Seeded for the shadow replay (AWS's documented example key)\nAWS_ACCESS_KEY_ID=${SEED_FAKE_KEY}\n`,
				});
			}
			const blobs: PackObject[] = added.map((a) => ({
				type: "blob",
				data: encoder.encode(a.content),
			}));
			const { ids: blobIds } = await writePack(blobs);
			const names = new Set(added.map((a) => a.name));
			tree = [
				...tree.filter((e) => !names.has(e.name)),
				...added.map((a, j) => ({
					mode: "100644" as const,
					name: a.name,
					id: blobIds[j],
				})),
			];
			const treeData = encodeTree(tree);
			const at = now - (count - i) * SEED_SPACING_S;
			const commit = encodeCommit({
				tree: (await writePack([{ type: "tree", data: treeData }])).ids[0],
				parents: [parent],
				author: { name: "Tartan seed", email: "seed@tartan.invalid", at },
				message:
					`Seeded advance ${i} of ${count}\n\nWritten by the dev-only seedHistory for the gate replay; not a real change.\n`,
			});
			const commitObject: PackObject = { type: "commit", data: commit };
			const { ids: commitIds } = await writePack([commitObject]);
			objects.push(...blobs, { type: "tree", data: treeData }, commitObject);
			commits.push({ sha: commitIds[0], parent, key: keys.has(i) });
			parent = commitIds[0];
		}
		const head = parent;
		const batchIds = commits.map(() => `lb_${ctx.ids.ulid()}`);

		// K1: the intent before the push, `pushed` after it.
		const intent = ctx.tx(() =>
			ctx.core.registerKernelWriteSync({
				target: "repo",
				ref: ids.trunkRef,
				expectOld: base,
				newSha: head,
				purpose: "seed",
				ownerKind: "kernel",
				ownerId: `seed:${batchIds[0]}`,
			})
		);
		const { pack } = await writePack(objects);
		const access = createCanonicalAccess({ artifacts, repoId: ids.repoId });
		let pushed = false;
		try {
			const [status] = await access.pushRefs(
				[{ ref: ids.trunkRef, old: base, new: head }],
				{ pack },
			);
			pushed = status?.ok === true;
			if (status === undefined || !status.ok) {
				throw conflict(
					`the seed push was refused: ${status?.reason ?? "no status"}`,
				);
			}
		} finally {
			ctx.tx(() =>
				ctx.core.markKernelWriteSync(intent.id, pushed ? "pushed" : "abandoned")
			);
		}

		// The labelled history: one landed batch and one done Advance each.
		const at = ctx.clock.now();
		ctx.tx(() => {
			commits.forEach((c, i) => {
				const batchId = batchIds[i];
				const instance = `${SEED_INSTANCE_PREFIX}${batchId}`;
				const created = at - (commits.length - i) * 1000;
				ctx.sql.exec(
					`INSERT INTO land_batches (id, instance_id, ref, instance_created, requested_by,
					   partition_key, base_sha, attempt, candidate_sha, changes_json, reason_json,
					   affected_json, test_policy, state, result_json, request_hash, created_at,
					   finished_at, candidate_swept)
					 VALUES (?, ?, ?, 1, ?, NULL, ?, 1, NULL, '[]', ?, NULL, 'none', 'landed', ?, ?, ?, ?, 1)`,
					batchId,
					instance,
					ids.trunkRef,
					actor.id,
					c.parent,
					JSON.stringify({
						summary: "seeded history (dev only)",
						events: [],
						seeded: true,
					}),
					JSON.stringify({ seeded: true, head: c.sha }),
					`seed:${c.sha}`,
					created,
					created,
				);
				ctx.sql.exec(
					`INSERT INTO advances (id, batch_id, attempt, ref, expect_old, new_sha, owner_instance,
					   lease_until, step, state, evidence_reused, gate_results_json, chain_seq, chain_head,
					   created_at, finished_at)
					 VALUES (?, ?, 1, ?, ?, ?, ?, 0, 'refs-pushed', 'done', 0, NULL, NULL, NULL, ?, ?)`,
					advanceId(batchId, 1),
					batchId,
					ids.trunkRef,
					c.parent,
					c.sha,
					instance,
					created,
					created,
				);
			});
		});
		ctx.ports.log("seeded history", {
			advances: commits.length,
			by: actor.id,
			intent: intent.id,
		});
		return {
			advances: commits.length,
			batches: batchIds,
			head,
			withFakeKeys: commits.flatMap((c, i) => c.key ? [i + 1] : []),
		};
	};

	return { seedHistory };
};
