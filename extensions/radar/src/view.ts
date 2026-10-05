// Read models shared by tools, context and slots: the conflicts@1 entity of
// a row, lane summaries, and "who else is here" for a path or a footprint
// (the same rules as the join, answered from the tables without writing).

import type { Conflict, ExtCtx, Footprint, Lane } from "@tartan/contract";
import { type Db, inList, json } from "@tartan/ext-api";
import { areStacked, driftFloor } from "./analyze.ts";
import { fetchLane, projectState } from "./facts.ts";
import {
	ACTIVE_SQL,
	type ConflictRow,
	type LaneRow,
	SEVERITY_RANK,
} from "./model.ts";
import {
	ancestorsOrSelf,
	normalizePrefix,
	projectArea,
	projectOf,
	type ProjectRoot,
	underBounds,
} from "./paths.ts";
import { getLane, latestRoots } from "./store.ts";
import { clean, ownerLabel, suggest } from "./texts.ts";
import type { ConflictSeverity, Suggestion } from "./types.ts";

export const toConflict = (row: ConflictRow): Conflict => {
	const ack = json.decode<
		{ by?: string; resolution?: string; note?: string; at?: number } | null
	>(row.ack_json, null);
	return {
		id: row.id,
		a: row.a,
		b: row.b,
		path: row.path,
		...(row.project !== null ? { project: row.project } : {}),
		severity: row.severity,
		suggestion: row.suggestion,
		state: row.state,
		...(row.state === "cleared" ? { avoided: row.avoided === 1 } : {}),
		firstSeen: row.first_seen,
		lastSeen: row.last_seen,
		...(ack ? { ack } : {}),
	};
};

/** A lane as `conflicts_check` and context name it. */
export const laneSummary = (lane: LaneRow) => ({
	laneId: lane.lane_id,
	agent: ownerLabel(lane),
	...(lane.entity_kind === "work" && lane.entity_id
		? { work: lane.entity_id }
		: {}),
	...(lane.work_title ? { title: clean(lane.work_title, 120) } : {}),
	...(lane.work_why ? { why: clean(lane.work_why, 300) } : {}),
	state: lane.state,
	mode: lane.mode,
});

/** A lane row for a lane radar has not projected yet (read-only callers). */
export const transientLane = (lane: Lane): LaneRow => ({
	lane_id: lane.id,
	owner: lane.owner,
	entity_kind: lane.entity?.kind ?? null,
	entity_id: lane.entity?.id ?? null,
	base_sha: lane.base,
	head_sha: lane.head ?? null,
	state: projectState(lane.state),
	mode: lane.mode,
	ref: lane.ref,
	remote: lane.remote,
	owner_label: null,
	work_title: null,
	work_why: null,
	change_id: null,
	range_base: lane.base,
	commits_json: "[]",
	truncated: 0,
	opened_at: lane.createdAt,
	last_push_at: lane.lastPushAt ?? null,
	touches_at: null,
});

/** The asking lane: projected, else read through caps (never stored here). */
export const laneOrFetch = async (
	x: ExtCtx,
	d: Db,
	laneId: string,
): Promise<LaneRow | null> => {
	const known = getLane(d, laneId);
	if (known !== null) return known;
	const lane = await fetchLane(x, laneId);
	return lane === null ? null : transientLane(lane);
};

export type Hit = {
	readonly lane: LaneRow;
	readonly severity: ConflictSeverity;
};

export type Neighbour = {
	readonly target: string;
	readonly hits: readonly Hit[];
	/** Trunk drift on this path since the asking lane's base. */
	readonly drift: boolean;
};

const add = (hits: Map<string, Hit>, lane: LaneRow, s: ConflictSeverity) => {
	const prev = hits.get(lane.lane_id);
	if (!prev || SEVERITY_RANK[s] > SEVERITY_RANK[prev.severity]) {
		hits.set(lane.lane_id, { lane, severity: s });
	}
};

const activeLanes = (
	d: Db,
	sql: string,
	...bindings: (string | number | null)[]
): LaneRow[] =>
	d.all<LaneRow>(
		`SELECT DISTINCT l.* FROM ${sql} AND l.state IN ${ACTIVE_SQL}`,
		...bindings,
	);

export type Asker = {
	readonly me: LaneRow | null;
	readonly exclude: readonly string[];
	readonly roots: readonly ProjectRoot[];
};

export const askerOf = (d: Db, me: LaneRow | null): Asker => ({
	me,
	exclude: me ? [me.lane_id] : [],
	roots: latestRoots(d),
});

const finish = (a: Asker, hits: Map<string, Hit>): Hit[] =>
	[...hits.values()]
		.filter((h) =>
			!a.exclude.includes(h.lane.lane_id) &&
			!(a.me && areStacked(a.me, h.lane))
		)
		.sort((x, y) =>
			SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] ||
			(y.lane.last_push_at ?? y.lane.opened_at) -
				(x.lane.last_push_at ?? x.lane.opened_at)
		);

/** Who else is at `path`: shared file, same project, or a footprint over it. */
export const neighboursOfPath = (d: Db, a: Asker, path: string): Neighbour => {
	const hits = new Map<string, Hit>();
	const ex = inList.binding(a.exclude);
	for (
		const l of activeLanes(
			d,
			`touches t JOIN lanes l ON l.lane_id = t.lane_id
			WHERE t.path = ? AND t.lane_id NOT IN ${inList.sql}`,
			path,
			ex,
		)
	) add(hits, l, "same_file");
	const project = projectOf(a.roots, path) ??
		d.value<string>(
			"SELECT project FROM touches WHERE path = ? AND project IS NOT NULL LIMIT 1",
			path,
		);
	if (project !== null) {
		for (
			const l of activeLanes(
				d,
				`touches t JOIN lanes l ON l.lane_id = t.lane_id
				WHERE t.project = ? AND t.lane_id NOT IN ${inList.sql}`,
				project,
				ex,
			)
		) add(hits, l, "same_project");
	}
	for (
		const l of activeLanes(
			d,
			`footprints f JOIN lanes l ON l.lane_id = f.lane_id
			WHERE f.lane_id NOT IN ${inList.sql}
				AND ((f.kind = 'prefix' AND f.value IN ${inList.sql})
					OR (f.kind = 'project' AND f.value = ?))`,
			ex,
			inList.binding(ancestorsOrSelf(path)),
			project,
		)
	) add(hits, l, "declared");
	const drift = a.me !== null && (d.value<number>(
				`SELECT COUNT(*) FROM landed_paths lp JOIN landings la ON la.seq = lp.seq
		WHERE lp.path = ? AND la.seq > ? AND (la.lane_id IS NULL OR la.lane_id <> ?)`,
				path,
				driftFloor(d, a.me),
				a.me.lane_id,
			) ?? 0) > 0;
	return { target: path, hits: finish(a, hits), drift };
};

/** Active lanes whose declared footprint covers `path` (a prefix above it, or its project). */
export const lanesDeclaring = (
	d: Db,
	path: string,
	roots: readonly ProjectRoot[],
): LaneRow[] =>
	activeLanes(
		d,
		`footprints f JOIN lanes l ON l.lane_id = f.lane_id
		WHERE ((f.kind = 'prefix' AND f.value IN ${inList.sql})
			OR (f.kind = 'project' AND f.value = ?))`,
		inList.binding(ancestorsOrSelf(path)),
		projectOf(roots, path),
	);

/** Who else is in a declared prefix: footprints overlapping it, or touches under it. */
export const neighboursOfPrefix = (
	d: Db,
	a: Asker,
	raw: string,
): Neighbour => {
	const prefix = normalizePrefix(raw);
	const [lo, hi] = underBounds(prefix);
	const ex = inList.binding(a.exclude);
	const hits = new Map<string, Hit>();
	for (
		const l of activeLanes(
			d,
			`footprints f JOIN lanes l ON l.lane_id = f.lane_id
			WHERE f.kind = 'prefix' AND f.lane_id NOT IN ${inList.sql}
				AND (f.value IN ${inList.sql} OR (f.value > ? AND f.value < ?))`,
			ex,
			inList.binding(ancestorsOrSelf(prefix)),
			lo,
			hi,
		)
	) add(hits, l, "declared");
	for (
		const l of activeLanes(
			d,
			`touches t JOIN lanes l ON l.lane_id = t.lane_id
			WHERE t.lane_id NOT IN ${inList.sql} AND (t.path = ? OR (t.path > ? AND t.path < ?))`,
			ex,
			prefix,
			lo,
			hi,
		)
	) add(hits, l, "declared");
	return { target: prefix, hits: finish(a, hits), drift: false };
};

/** Who else declared or touches a project. */
export const neighboursOfProject = (
	d: Db,
	a: Asker,
	project: string,
): Neighbour => {
	const ex = inList.binding(a.exclude);
	const hits = new Map<string, Hit>();
	for (
		const l of activeLanes(
			d,
			`footprints f JOIN lanes l ON l.lane_id = f.lane_id
			WHERE f.kind = 'project' AND f.value = ? AND f.lane_id NOT IN ${inList.sql}`,
			project,
			ex,
		)
	) add(hits, l, "declared");
	for (
		const l of activeLanes(
			d,
			`touches t JOIN lanes l ON l.lane_id = t.lane_id
			WHERE t.project = ? AND t.lane_id NOT IN ${inList.sql}`,
			project,
			ex,
		)
	) add(hits, l, "same_project");
	return { target: projectArea(project), hits: finish(a, hits), drift: false };
};

/** Neighbours of a footprint: one entry per prefix and per project. */
export const neighboursOfFootprint = (
	d: Db,
	a: Asker,
	fp: Footprint,
): Neighbour[] => [
	...fp.prefixes.map((p) => neighboursOfPrefix(d, a, p)),
	...fp.projects.map((p) => neighboursOfProject(d, a, p)),
];

/** The suggestion for the asker about one neighbour. */
export const suggestionFor = (
	a: Asker,
	hit: Hit,
): Suggestion => suggest(hit.severity, a.me ?? NOBODY, hit.lane);

const NOBODY: LaneRow = {
	lane_id: "",
	owner: "",
	entity_kind: null,
	entity_id: null,
	base_sha: "",
	head_sha: null,
	state: "open",
	mode: "branch",
	ref: null,
	remote: null,
	owner_label: null,
	work_title: null,
	work_why: null,
	change_id: null,
	range_base: null,
	commits_json: "[]",
	truncated: 0,
	opened_at: 0,
	last_push_at: null,
	touches_at: null,
};
