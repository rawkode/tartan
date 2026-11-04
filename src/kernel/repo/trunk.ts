// The trunk-commit set (K17): every trunk commit the kernel knows, in trunk
// order (an imported first-parent chain at seq ≤ 0, genesis 0, each landing or
// Owner's direct push 1, 2, …). Trunk moves only forward, so a commit's merge base with trunk is its reachable
// entry with the highest seq; WP8's range walk asks `trunkSeqs` one log page at
// a time.

import { invalid, isIdOf, isSha } from "@tartan/contract";
import {
	type Core,
	getMetaNumber,
	jsonList,
	rows,
	scalar,
	setMeta,
} from "./core.ts";

/** `trunk_commits` positions of `shas` (absent = not on trunk). */
export const trunkSeqsSync = (
	sql: SqlStorage,
	shas: readonly string[],
): Record<string, number> => {
	if (shas.length > 1000) throw invalid("at most 1000 shas per call");
	const wanted = shas.filter(isSha);
	if (wanted.length === 0) return {};
	return Object.fromEntries(
		rows<{ sha: string; seq: number }>(
			sql,
			`SELECT sha, seq FROM trunk_commits
			 WHERE sha IN (SELECT value FROM json_each(?))`,
			jsonList(wanted),
		).map((row) => [row.sha, row.seq]),
	);
};

/** New trunk commits, in trunk order, at the next seqs (a known one keeps its seq). */
const appendTrunkCommits = (
	core: Core,
	shas: readonly string[],
	source: "advance" | "push",
): void => {
	let next = scalar(core.sql, "SELECT MAX(seq) AS n FROM trunk_commits") + 1;
	for (const sha of shas) {
		const inserted = rows<{ sha: string }>(
			core.sql,
			`INSERT INTO trunk_commits (sha, seq, source) VALUES (?, ?, ?)
			 ON CONFLICT (sha) DO NOTHING RETURNING sha`,
			sha,
			Math.max(next, 1),
			source,
		);
		if (inserted.length > 0) next = Math.max(next, 1) + 1;
	}
};

/**
 * An Owner's direct push to the default branch, in `recordPush`'s transaction:
 * the commits it added at the next seqs, so `?sha=` and K17 see them as trunk,
 * and its bytes added to `meta.trunk_pack_bytes`.
 */
export const recordTrunkPushSync = (
	core: Core,
	input: { readonly commits: readonly string[]; readonly bytes?: number },
): void => {
	for (const sha of input.commits) {
		if (!isSha(sha)) throw invalid(`not a sha: ${sha}`);
	}
	appendTrunkCommits(core, input.commits, "push");
	const estimate = getMetaNumber(core.sql, "trunk_pack_bytes");
	if (estimate !== null && input.bytes !== undefined) {
		setMeta(core.sql, "trunk_pack_bytes", estimate + input.bytes);
	}
};

/**
 * `completeAdvance` (WP10) in its transaction: the landed commits at the next
 * seqs, in trunk order, and the landed lanes' gateway-pushed bytes added to
 * `meta.trunk_pack_bytes` (human-branch and unlanded lane pushes
 * never count).
 */
export const recordLandingSync = (
	core: Core,
	input: {
		readonly trunkCommits: readonly string[];
		readonly landedLaneIds: readonly string[];
	},
): void => {
	for (const sha of input.trunkCommits) {
		if (!isSha(sha)) throw invalid(`not a sha: ${sha}`);
	}
	for (const laneId of input.landedLaneIds) {
		if (!isIdOf("lane", laneId)) throw invalid(`not a lane id: ${laneId}`);
	}
	appendTrunkCommits(core, input.trunkCommits, "advance");
	const estimate = getMetaNumber(core.sql, "trunk_pack_bytes");
	if (estimate === null || input.landedLaneIds.length === 0) return;
	const pushed = scalar(
		core.sql,
		`SELECT COALESCE(SUM(bytes), 0) AS n FROM pushes
		 WHERE target IN (SELECT value FROM json_each(?)) AND via IN ('gateway','swarm')
		 AND bytes IS NOT NULL`,
		jsonList(input.landedLaneIds),
	);
	setMeta(core.sql, "trunk_pack_bytes", estimate + pushed);
};

/** The imported first-parent chain (seq 0 = tip, negative below; K17). */
export const recordImportChainSync = (
	core: Core,
	chain: readonly string[],
): number => {
	core.sql.exec("DELETE FROM trunk_commits WHERE source = 'import'");
	let seq = 0;
	let count = 0;
	for (const sha of chain) {
		const inserted = rows<{ sha: string }>(
			core.sql,
			`INSERT INTO trunk_commits (sha, seq, source) VALUES (?, ?, 'import')
			 ON CONFLICT DO NOTHING RETURNING sha`,
			sha,
			seq,
		);
		if (inserted.length > 0) {
			seq--;
			count++;
		}
	}
	return count;
};
