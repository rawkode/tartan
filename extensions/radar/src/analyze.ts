// The path-level join (M1): one lane's touches
// and declared footprint against every other active lane, plus trunk drift
// (landings after the lane's range base touching its paths). Pure reads over
// the extension's tables, so it runs in read-only contexts too.
//
// Severities produced here (M1): `declared` (footprint ∩ footprint, or a
// footprint over the other lane's touches), `same_project` (touches in the
// same project, no shared file), `same_file` (a shared path) and
// `trunk_drift`. `adjacent`/`textual` (hunks, diff3) are M2.
//
// Suppressed: stacked pairs (one lane's range carries the other lane's head,
// so its overlap is the other's own change).

import { type Db, inList, json } from "@tartan/ext-api";
import { ACTIVE_SQL, type LaneRow, SEVERITY_RANK, TRUNK } from "./model.ts";
import {
	ancestorsOrSelf,
	prefixIntersection,
	projectArea,
	underBounds,
} from "./paths.ts";
import {
	footprintOf,
	getLane,
	getLanes,
	isActive,
	landingSeqOf,
	touchesOf,
} from "./store.ts";
import type { ConflictSeverity } from "./types.ts";

export type Finding = {
	/** The other lane, or `trunk`. */
	readonly other: string;
	/** A file path (`same_file`, `trunk_drift`) or an area: a prefix or `project:<name>`. */
	readonly path: string;
	readonly project: string | null;
	readonly severity: ConflictSeverity;
	readonly detail: Readonly<Record<string, string | number | boolean | null>>;
};

/** True when one lane's range carries the other lane's current head (stacked). */
export const areStacked = (
	a: Pick<LaneRow, "head_sha" | "commits_json">,
	b: Pick<LaneRow, "head_sha" | "commits_json">,
): boolean => {
	const ca = json.decode<string[]>(a.commits_json, []);
	const cb = json.decode<string[]>(b.commits_json, []);
	return (b.head_sha !== null && ca.includes(b.head_sha)) ||
		(a.head_sha !== null && cb.includes(a.head_sha));
};

const keep = (
	found: Map<string, Finding>,
	f: Finding,
): void => {
	const key = `${f.other}\u0000${f.path}`;
	const prev = found.get(key);
	if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) {
		found.set(key, f);
	}
};

type OtherPath = { other: string; path: string; project: string | null };
type OtherValue = { other: string; value: string };

/** Pair findings of `me` against every other active lane (no trunk drift). */
export const pairFindings = (d: Db, me: LaneRow): Finding[] => {
	const laneId = me.lane_id;
	const found = new Map<string, Finding>();
	const touches = touchesOf(d, laneId);
	const fp = footprintOf(d, laneId);

	// same_file: shared paths (index on touches.path).
	const shared = d.all<OtherPath>(
		`SELECT o.lane_id AS other, o.path AS path, t.project AS project
		FROM touches t
		JOIN touches o ON o.path = t.path AND o.lane_id <> t.lane_id
		JOIN lanes l ON l.lane_id = o.lane_id
		WHERE t.lane_id = ? AND l.state IN ${ACTIVE_SQL}`,
		laneId,
	);
	const sharedProjects = new Set<string>();
	for (const r of shared) {
		keep(found, {
			other: r.other,
			path: r.path,
			project: r.project,
			severity: "same_file",
			detail: { via: "touches" },
		});
		if (r.project !== null) sharedProjects.add(`${r.other}\u0000${r.project}`);
	}

	// same_project: touches in a common project, no shared file in it.
	const projects = d.all<{ other: string; project: string; n: number }>(
		`SELECT o.lane_id AS other, o.project AS project, COUNT(*) AS n
		FROM (SELECT DISTINCT project FROM touches WHERE lane_id = ? AND project IS NOT NULL) p
		JOIN touches o ON o.project = p.project AND o.lane_id <> ?
		JOIN lanes l ON l.lane_id = o.lane_id
		WHERE l.state IN ${ACTIVE_SQL}
		GROUP BY o.lane_id, o.project`,
		laneId,
		laneId,
	);
	for (const r of projects) {
		if (sharedProjects.has(`${r.other}\u0000${r.project}`)) continue;
		keep(found, {
			other: r.other,
			path: projectArea(r.project),
			project: r.project,
			severity: "same_project",
			detail: { via: "touches", paths: r.n },
		});
	}

	// declared: my footprint against their footprints and touches.
	const declared = (other: string, path: string, project: string | null) =>
		keep(found, {
			other,
			path,
			project,
			severity: "declared",
			detail: { via: "footprint" },
		});
	for (const p of fp.prefixes) {
		const [lo, hi] = underBounds(p);
		for (
			const r of d.all<OtherValue>(
				`SELECT f.lane_id AS other, f.value AS value FROM footprints f
				JOIN lanes l ON l.lane_id = f.lane_id
				WHERE f.kind = 'prefix' AND f.lane_id <> ? AND l.state IN ${ACTIVE_SQL}
					AND (f.value IN ${inList.sql} OR (f.value > ? AND f.value < ?))`,
				laneId,
				inList.binding(ancestorsOrSelf(p)),
				lo,
				hi,
			)
		) declared(r.other, prefixIntersection(p, r.value), null);
		for (
			const r of d.all<{ other: string }>(
				`SELECT DISTINCT t.lane_id AS other FROM touches t
				JOIN lanes l ON l.lane_id = t.lane_id
				WHERE t.lane_id <> ? AND l.state IN ${ACTIVE_SQL}
					AND (t.path = ? OR (t.path > ? AND t.path < ?))`,
				laneId,
				p,
				lo,
				hi,
			)
		) declared(r.other, p, null);
	}
	if (fp.projects.length > 0) {
		for (
			const r of d.all<OtherValue>(
				`SELECT f.lane_id AS other, f.value AS value FROM footprints f
				JOIN lanes l ON l.lane_id = f.lane_id
				WHERE f.kind = 'project' AND f.lane_id <> ? AND l.state IN ${ACTIVE_SQL}
					AND f.value IN ${inList.sql}
				UNION
				SELECT DISTINCT t.lane_id AS other, t.project AS value FROM touches t
				JOIN lanes l ON l.lane_id = t.lane_id
				WHERE t.lane_id <> ? AND l.state IN ${ACTIVE_SQL}
					AND t.project IN ${inList.sql}`,
				laneId,
				inList.binding(fp.projects),
				laneId,
				inList.binding(fp.projects),
			)
		) declared(r.other, projectArea(r.value), r.value);
	}
	// Their footprints over my touches.
	if (touches.length > 0) {
		const dirs = [...new Set(touches.flatMap((t) => ancestorsOrSelf(t.path)))];
		const mine = [
			...new Set(touches.flatMap((t) => t.project === null ? [] : [t.project])),
		];
		for (
			const r of d.all<OtherValue & { kind: string }>(
				`SELECT f.lane_id AS other, f.value AS value, f.kind AS kind FROM footprints f
				JOIN lanes l ON l.lane_id = f.lane_id
				WHERE f.lane_id <> ? AND l.state IN ${ACTIVE_SQL}
					AND ((f.kind = 'prefix' AND f.value IN ${inList.sql})
						OR (f.kind = 'project' AND f.value IN ${inList.sql}))`,
				laneId,
				inList.binding(dirs),
				inList.binding(mine),
			)
		) {
			if (r.kind === "prefix") declared(r.other, r.value, null);
			else declared(r.other, projectArea(r.value), r.value);
		}
	}

	// Suppress stacked pairs.
	const others = getLanes(d, [
		...new Set([...found.values()].map((f) => f.other)),
	]);
	return [...found.values()].filter((f) => {
		const other = others.get(f.other);
		return other !== undefined && !areStacked(me, other);
	});
};

/**
 * The landing seq after which trunk landings are news to `lane`: the landing
 * of its range base, else (a base older than radar's history) the last
 * landing before the lane opened.
 */
export const driftFloor = (d: Db, lane: LaneRow): number => {
	const base = lane.range_base ?? lane.base_sha;
	const seq = landingSeqOf(d, base);
	if (seq !== null) return seq;
	return d.value<number>(
		"SELECT MAX(seq) FROM landings WHERE at <= ?",
		lane.opened_at,
	) ?? 0;
};

/** Trunk drift: landings after the lane's range base that touched its paths. */
export const driftFindings = (d: Db, lane: LaneRow): Finding[] => {
	const rows = d.all<
		{
			path: string;
			project: string | null;
			change_id: string | null;
			lane_id: string | null;
			commit_sha: string;
		}
	>(
		`SELECT lp.path AS path, lp.project AS project, la.change_id AS change_id,
			la.lane_id AS lane_id, la.commit_sha AS commit_sha
		FROM touches t
		JOIN landed_paths lp ON lp.path = t.path
		JOIN landings la ON la.seq = lp.seq
		WHERE t.lane_id = ? AND la.seq > ? AND (la.lane_id IS NULL OR la.lane_id <> ?)
		ORDER BY la.seq DESC`,
		lane.lane_id,
		driftFloor(d, lane),
		lane.lane_id,
	);
	const found = new Map<string, Finding>();
	for (const r of rows) {
		if (found.has(r.path)) continue;
		found.set(r.path, {
			other: TRUNK,
			path: r.path,
			project: r.project,
			severity: "trunk_drift",
			detail: {
				commit: r.commit_sha,
				changeId: r.change_id,
				laneId: r.lane_id,
			},
		});
	}
	return [...found.values()];
};

/** Everything radar knows about one lane: pair findings and trunk drift. */
export const analyzeLane = (d: Db, laneId: string): Finding[] => {
	const me = getLane(d, laneId);
	if (me === null || !isActive(me)) return [];
	return [...pairFindings(d, me), ...driftFindings(d, me)];
};
