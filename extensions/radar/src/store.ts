// Raw SQL over tartan.radar's own tables, with typed mappers. Synchronous:
// callers group writes in one `db.tx` so a handler's state and its outbox
// commit together.

import { type Db, inList, json } from "@tartan/ext-api";
import type { Footprint } from "@tartan/contract";
import {
	ACTIVE_SQL,
	type ConflictRow,
	type LaneRow,
	STAT_KEYS,
	type StatKey,
} from "./model.ts";
import { normalizePrefix, type ProjectRoot, sortRoots } from "./paths.ts";

// ---------------------------------------------------------------------------
// Lanes (projection of lane.* plus facts gathered from caps)
// ---------------------------------------------------------------------------

export const getLane = (d: Db, laneId: string): LaneRow | null =>
	d.first<LaneRow>("SELECT * FROM lanes WHERE lane_id = ?", laneId);

export const getLanes = (d: Db, ids: readonly string[]): Map<string, LaneRow> =>
	new Map(
		d.all<LaneRow>(
			`SELECT * FROM lanes WHERE lane_id IN ${inList.sql}`,
			inList.binding(ids),
		).map((l) => [l.lane_id, l]),
	);

export const laneByChange = (d: Db, changeId: string): LaneRow | null =>
	d.first<LaneRow>("SELECT * FROM lanes WHERE change_id = ?", changeId);

export const isActive = (lane: Pick<LaneRow, "state"> | null): boolean =>
	lane !== null && (lane.state === "open" || lane.state === "submitted");

export type LaneFacts = {
	readonly laneId: string;
	readonly owner: string;
	readonly entityKind?: string | null;
	readonly entityId?: string | null;
	readonly base: string;
	readonly head?: string | null;
	readonly state: string;
	readonly mode: string;
	readonly ref?: string | null;
	readonly remote?: string | null;
	readonly ownerLabel?: string | null;
	readonly workTitle?: string | null;
	readonly workWhy?: string | null;
	readonly openedAt: number;
};

/** Inserts or refreshes a lane; facts that are null keep their stored value. */
export const upsertLane = (d: Db, f: LaneFacts): void => {
	d.run(
		`INSERT INTO lanes (lane_id, owner, entity_kind, entity_id, base_sha, head_sha, state, mode, ref, remote,
			owner_label, work_title, work_why, range_base, opened_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (lane_id) DO UPDATE SET
			owner = excluded.owner,
			entity_kind = COALESCE(excluded.entity_kind, lanes.entity_kind),
			entity_id = COALESCE(excluded.entity_id, lanes.entity_id),
			base_sha = excluded.base_sha,
			head_sha = COALESCE(excluded.head_sha, lanes.head_sha),
			state = excluded.state,
			mode = excluded.mode,
			ref = COALESCE(excluded.ref, lanes.ref),
			remote = COALESCE(excluded.remote, lanes.remote),
			owner_label = COALESCE(excluded.owner_label, lanes.owner_label),
			work_title = COALESCE(excluded.work_title, lanes.work_title),
			work_why = COALESCE(excluded.work_why, lanes.work_why),
			range_base = COALESCE(lanes.range_base, excluded.range_base),
			opened_at = CASE WHEN lanes.opened_at > 0 THEN lanes.opened_at ELSE excluded.opened_at END`,
		f.laneId,
		f.owner,
		f.entityKind ?? null,
		f.entityId ?? null,
		f.base,
		f.head ?? null,
		f.state,
		f.mode,
		f.ref ?? null,
		f.remote ?? null,
		f.ownerLabel ?? null,
		f.workTitle ?? null,
		f.workWhy ?? null,
		f.base,
		f.openedAt,
	);
};

export const setLaneState = (d: Db, laneId: string, state: string): void => {
	d.run("UPDATE lanes SET state = ? WHERE lane_id = ?", state, laneId);
};

export const setFootprint = (
	d: Db,
	laneId: string,
	footprint: Footprint | undefined,
): void => {
	d.run("DELETE FROM footprints WHERE lane_id = ?", laneId);
	const rows = [
		...(footprint?.projects ?? []).map((v) => ["project", v] as const),
		...(footprint?.prefixes ?? []).map((v) =>
			["prefix", normalizePrefix(v)] as const
		),
	].filter(([, v]) => v !== "");
	for (const [kind, value] of rows) {
		d.run(
			"INSERT OR IGNORE INTO footprints (lane_id, kind, value) VALUES (?, ?, ?)",
			laneId,
			kind,
			value,
		);
	}
};

export const footprintOf = (d: Db, laneId: string): Footprint => {
	const rows = d.all<{ kind: string; value: string }>(
		"SELECT kind, value FROM footprints WHERE lane_id = ? ORDER BY kind, value",
		laneId,
	);
	return {
		projects: rows.filter((r) => r.kind === "project").map((r) => r.value),
		prefixes: rows.filter((r) => r.kind === "prefix").map((r) => r.value),
	};
};

// ---------------------------------------------------------------------------
// Touches (the lane range rangeBase..head, K17)
// ---------------------------------------------------------------------------

export type Touch = {
	readonly path: string;
	readonly project: string | null;
	readonly change: string;
};

export type PushFacts = {
	readonly head: string;
	readonly rangeBase: string;
	readonly rangeTruncated: boolean;
	readonly commits: readonly string[];
	readonly truncated: boolean;
	readonly at: number;
};

/**
 * Replaces the lane's touches with its current range (cumulative: a second
 * push keeps the first push's paths; after a rebase the landed paths drop
 * out) and records the head they reflect.
 */
export const replaceTouches = (
	d: Db,
	laneId: string,
	touches: readonly Touch[],
	push: PushFacts,
): void => {
	d.run("DELETE FROM touches WHERE lane_id = ?", laneId);
	for (const t of touches) {
		d.run(
			`INSERT OR REPLACE INTO touches (lane_id, path, project, change, head_sha)
			VALUES (?, ?, ?, ?, ?)`,
			laneId,
			t.path,
			t.project,
			t.change,
			push.head,
		);
	}
	d.run(
		`UPDATE lanes SET head_sha = ?, range_base = ?, commits_json = ?, truncated = ?, last_push_at = ?,
			touches_at = ?, base_sha = CASE WHEN ? THEN base_sha ELSE ? END,
			state = CASE WHEN state = 'lost' THEN 'open' ELSE state END
		WHERE lane_id = ?`,
		push.head,
		push.rangeBase,
		json.encode(push.commits),
		push.truncated ? 1 : 0,
		push.at,
		push.head,
		push.rangeTruncated ? 1 : 0,
		push.rangeBase,
		laneId,
	);
};

export const dropTouches = (d: Db, laneId: string): void => {
	d.run("DELETE FROM touches WHERE lane_id = ?", laneId);
	d.run("UPDATE lanes SET touches_at = NULL WHERE lane_id = ?", laneId);
};

export const touchesOf = (
	d: Db,
	laneId: string,
): { path: string; project: string | null }[] =>
	d.all<{ path: string; project: string | null }>(
		"SELECT path, project FROM touches WHERE lane_id = ? ORDER BY path",
		laneId,
	);

/** Active lanes (other than `except`) touching `path`. */
export const lanesTouching = (
	d: Db,
	path: string,
	except: readonly string[] = [],
): LaneRow[] =>
	d.all<LaneRow>(
		`SELECT l.* FROM touches t JOIN lanes l ON l.lane_id = t.lane_id
		WHERE t.path = ? AND l.state IN ${ACTIVE_SQL}
			AND t.lane_id NOT IN ${inList.sql}
		ORDER BY COALESCE(l.last_push_at, l.opened_at) DESC`,
		path,
		inList.binding(except),
	);

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export const getConflict = (d: Db, id: string): ConflictRow | null =>
	d.first<ConflictRow>("SELECT * FROM conflicts WHERE id = ?", id);

export const conflictByKey = (
	d: Db,
	a: string,
	b: string,
	path: string,
): ConflictRow | null =>
	d.first<ConflictRow>(
		"SELECT * FROM conflicts WHERE a = ? AND b = ? AND path = ?",
		a,
		b,
		path,
	);

/** Open and acked conflicts that name `laneId` on either side. */
export const liveConflictsOf = (d: Db, laneId: string): ConflictRow[] =>
	d.all<ConflictRow>(
		`SELECT * FROM conflicts WHERE a = ? AND state <> 'cleared'
		UNION ALL
		SELECT * FROM conflicts WHERE b = ? AND state <> 'cleared'`,
		laneId,
		laneId,
	);

// ---------------------------------------------------------------------------
// Stats, meta, project roots
// ---------------------------------------------------------------------------

export const addStat = (d: Db, k: StatKey, n = 1): void => {
	if (n === 0) return;
	d.run(
		`INSERT INTO stats (k, v) VALUES (?, ?)
		ON CONFLICT (k) DO UPDATE SET v = stats.v + excluded.v`,
		k,
		n,
	);
};

export const getStats = (d: Db): Record<StatKey, number> => {
	const rows = d.all<{ k: string; v: number }>("SELECT k, v FROM stats");
	const out = Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as Record<
		StatKey,
		number
	>;
	for (const r of rows) {
		if ((STAT_KEYS as readonly string[]).includes(r.k)) {
			out[r.k as StatKey] = r.v;
		}
	}
	return out;
};

export const getMeta = (d: Db, k: string): string | null =>
	d.value<string>("SELECT v FROM meta WHERE k = ?", k);

export const setMeta = (d: Db, k: string, v: string): void => {
	d.run(
		"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
		k,
		v,
	);
};

export const getRoots = (d: Db, sha: string): ProjectRoot[] | null => {
	const raw = d.value<string>(
		"SELECT roots_json FROM project_roots WHERE sha = ?",
		sha,
	);
	return raw === null ? null : json.decode<ProjectRoot[]>(raw, []);
};

/** The most recently stored roots (read-only callers that cannot fetch a graph). */
export const latestRoots = (d: Db): ProjectRoot[] =>
	json.decode<ProjectRoot[]>(
		d.value<string>(
			"SELECT roots_json FROM project_roots ORDER BY at DESC, sha LIMIT 1",
		),
		[],
	);

export const putRoots = (
	d: Db,
	sha: string,
	roots: readonly ProjectRoot[],
	at: number,
): void => {
	d.run(
		`INSERT INTO project_roots (sha, roots_json, at) VALUES (?, ?, ?)
		ON CONFLICT (sha) DO UPDATE SET roots_json = excluded.roots_json, at = excluded.at`,
		sha,
		json.encode(sortRoots(roots)),
		at,
	);
	// Keep the 50 newest graphs.
	d.run(
		`DELETE FROM project_roots WHERE sha NOT IN
			(SELECT sha FROM project_roots ORDER BY at DESC LIMIT 50)`,
	);
};

// ---------------------------------------------------------------------------
// Landings (trunk order) for trunk drift
// ---------------------------------------------------------------------------

export type Landing = {
	readonly advanceId: string;
	readonly laneId: string | null;
	readonly changeId: string | null;
	readonly commit: string;
	readonly trunk: string;
	readonly old: string;
	readonly at: number;
};

/** Records a landing and its paths; returns its seq, or null when already recorded. */
export const recordLanding = (
	d: Db,
	l: Landing,
	paths: readonly { path: string; project: string | null }[],
): number | null => {
	const seen = d.value<number>(
		"SELECT seq FROM landings WHERE advance_id = ? AND commit_sha = ?",
		l.advanceId,
		l.commit,
	);
	if (seen !== null) return null;
	const seq = (d.value<number>("SELECT MAX(seq) FROM landings") ?? 0) + 1;
	d.run(
		`INSERT INTO landings (seq, advance_id, lane_id, change_id, commit_sha, trunk_sha, old_sha, at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		seq,
		l.advanceId,
		l.laneId,
		l.changeId,
		l.commit,
		l.trunk,
		l.old,
		l.at,
	);
	for (const p of paths) {
		d.run(
			"INSERT OR IGNORE INTO landed_paths (seq, path, project) VALUES (?, ?, ?)",
			seq,
			p.path,
			p.project,
		);
	}
	return seq;
};

/**
 * The seq after which landings are newer than `base` (a trunk commit), or
 * null when `base` is not a commit radar saw land (older than its history).
 */
export const landingSeqOf = (d: Db, base: string): number | null => {
	const at = d.value<number>(
		"SELECT MAX(seq) FROM landings WHERE commit_sha = ? OR trunk_sha = ?",
		base,
		base,
	);
	if (at !== null) return at;
	const before = d.value<number>(
		"SELECT MIN(seq) FROM landings WHERE old_sha = ?",
		base,
	);
	return before === null ? null : before - 1;
};

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export type OutboxRow = {
	id: string;
	kind: "emit" | "notify";
	body_json: string;
	at: number;
	attempts: number;
};

export const enqueue = (
	d: Db,
	id: string,
	kind: "emit" | "notify",
	body: unknown,
	at: number,
): void => {
	d.run(
		"INSERT OR IGNORE INTO outbox (id, kind, body_json, at) VALUES (?, ?, ?, ?)",
		id,
		kind,
		json.encode(body),
		at,
	);
};

export const pendingOutbox = (d: Db, limit: number): OutboxRow[] =>
	d.all<OutboxRow>(
		"SELECT * FROM outbox ORDER BY at, id LIMIT ?",
		limit,
	);
