// context@1 "neighbourhood": active lanes whose
// footprint or touches intersect the asking lane's (work title and why,
// agent, paths, last push), its open conflicts with suggestions, and trunk
// drift. Read-only; within the contributor's `maxBytes`.

import {
	type ContextRequest,
	type ContextSection,
	defuseFences,
	type ExtCtx,
	truncateBytes,
} from "@tartan/contract";
import { type Db, db } from "@tartan/ext-api";
import { textEnv } from "./facts.ts";
import {
	type ConflictRow,
	type LaneRow,
	SEVERITY_RANK,
	TRUNK,
} from "./model.ts";
import { footprintOf, getLanes, liveConflictsOf, touchesOf } from "./store.ts";
import { clean, laneLabel, sideOf, suggestionText } from "./texts.ts";
import {
	askerOf,
	type Hit,
	laneOrFetch,
	neighboursOfFootprint,
	neighboursOfPath,
} from "./view.ts";

const ago = (now: number, at: number | null): string => {
	if (at === null) return "no push yet";
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 90) return `last push ${s}s ago`;
	const m = Math.round(s / 60);
	return m < 90
		? `last push ${m} min ago`
		: `last push ${Math.round(m / 60)} h ago`;
};

const laneOfRequest = async (
	x: ExtCtx,
	d: Db,
	req: ContextRequest,
): Promise<LaneRow | null> => {
	if (req.laneId) return await laneOrFetch(x, d, req.laneId);
	if (!req.work) return null;
	return d.first<LaneRow>(
		`SELECT * FROM lanes WHERE entity_kind = 'work' AND entity_id = ?
			AND state IN ('open','submitted') AND (owner = ? OR owner = ?)
		ORDER BY opened_at DESC LIMIT 1`,
		req.work,
		req.actor.id,
		req.actor.onBehalfOf ?? req.actor.id,
	);
};

export const neighbourhood = async (
	req: ContextRequest,
	x: ExtCtx,
): Promise<ContextSection[]> => {
	const d = db(x.sql);
	const me = await laneOfRequest(x, d, req);
	const asker = askerOf(d, me);
	const now = x.caps.clock.now();
	const env = textEnv(x, d);

	const paths = req.paths?.length
		? req.paths
		: me
		? touchesOf(d, me.lane_id).map((t) => t.path)
		: [];
	const near = new Map<string, { hit: Hit; paths: Set<string> }>();
	const note = (hit: Hit, target: string) => {
		const prev = near.get(hit.lane.lane_id);
		if (!prev) {
			near.set(hit.lane.lane_id, { hit, paths: new Set([target]) });
			return;
		}
		prev.paths.add(target);
		if (SEVERITY_RANK[hit.severity] > SEVERITY_RANK[prev.hit.severity]) {
			prev.hit = hit;
		}
	};
	for (const p of paths.slice(0, 200)) {
		for (const h of neighboursOfPath(d, asker, p).hits) note(h, p);
	}
	if (me) {
		for (
			const n of neighboursOfFootprint(d, asker, footprintOf(d, me.lane_id))
		) {
			for (const h of n.hits) note(h, n.target);
		}
	}
	const conflicts: ConflictRow[] = me
		? liveConflictsOf(d, me.lane_id).sort((a, b) =>
			SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
		)
		: [];
	if (near.size === 0 && conflicts.length === 0) return [];

	const lanes = getLanes(
		d,
		conflicts.map((c) => sideOf(c, me!.lane_id)).filter((s) => s !== TRUNK),
	);
	const lines: string[] = [];
	if (near.size > 0) {
		lines.push("Active lanes near yours:");
		const ranked = [...near.values()].sort((a, b) =>
			SEVERITY_RANK[b.hit.severity] - SEVERITY_RANK[a.hit.severity]
		);
		for (const { hit, paths: ps } of ranked.slice(0, 10)) {
			const l = hit.lane;
			const shown = [...ps].slice(0, 3).join(", ");
			const more = ps.size > 3 ? ` (+${ps.size - 3} more)` : "";
			const why = l.work_why ? ` — why: ${clean(l.work_why, 160)}` : "";
			lines.push(
				`- ${hit.severity}: ${laneLabel(l)} at ${shown}${more}; ${
					ago(now, l.last_push_at)
				}${why}`,
			);
		}
	}
	if (conflicts.length > 0) {
		lines.push("", "Open conflicts on your lane:");
		for (const c of conflicts.slice(0, 8)) {
			const otherId = sideOf(c, me!.lane_id);
			const other = otherId === TRUNK ? null : lanes.get(otherId) ?? null;
			lines.push(
				`- ${c.id} ${c.severity} ${c.path} ⟷ ${
					other ? laneLabel(other) : "trunk"
				}${c.state === "acked" ? " (acked)" : ""}; suggestion: ${
					suggestionText(c.suggestion, other, env)
				}`,
			);
		}
	}
	const md = truncateBytes(defuseFences(lines.join("\n")), req.maxBytes);
	return [{
		id: "neighbourhood",
		title: "Neighbourhood (radar)",
		priority: "conflicts",
		md,
	}];
};
