// conflicts@1 tools.
//
// - `conflicts_check` (read-only): "if I edit these paths (or work in this
//   footprint), who do I collide with?" from declared footprints and live
//   touches; with a `laneId` it also reports trunk drift on each path and
//   leaves out the lane itself and stacked lanes.
//   `work_claim` calls it with the new lane's footprint (claim-time
//   overlaps, whatever backend each lane uses).
// - `conflicts_list` (read-only): a repo's or a lane's conflicts.
// - `conflicts_ack` (mutating): an owner (or a Maintainer) records how the
//   conflict will be resolved; the other owner hears about it.

import {
	type Actor,
	denied,
	type ExtCtx,
	type Footprint,
	invalid,
	notFound,
	type ToolContext,
} from "@tartan/contract";
import { actingPrincipals, type Db, db, json } from "@tartan/ext-api";
import { repoIdOf, textEnv } from "./facts.ts";
import {
	type ConflictRow,
	EXT_SHORT,
	MAX_CHECK_LANES,
	MAX_LIST,
	TRUNK,
} from "./model.ts";
import { flushOutbox } from "./outbox.ts";
import type { EmitBody, NotifyBody } from "./reconcile.ts";
import {
	enqueue,
	footprintOf,
	getConflict,
	getLanes,
	touchesOf,
} from "./store.ts";
import { clean, fetchCommand, laneLabel, ownerLabel } from "./texts.ts";
import type { ConflictResolution } from "./types.ts";
import {
	askerOf,
	laneOrFetch,
	laneSummary,
	type Neighbour,
	neighboursOfFootprint,
	neighboursOfPath,
	suggestionFor,
	toConflict,
} from "./view.ts";

type CheckArgs = {
	readonly repo: string;
	readonly laneId?: string;
	readonly footprint?: Footprint;
	readonly paths?: readonly string[];
};

const resultOf = (
	x: ExtCtx,
	d: Db,
	asker: ReturnType<typeof askerOf>,
	n: Neighbour,
) => {
	const env = textEnv(x, d);
	const lanes = n.hits.slice(0, MAX_CHECK_LANES).map((h) => ({
		...laneSummary(h.lane),
		severity: h.severity,
		suggestion: suggestionFor(asker, h),
		fetch: fetchCommand(h.lane, env),
	}));
	const top = n.hits[0];
	if (top === undefined) {
		return n.drift
			? {
				target: n.target,
				lanes,
				severity: "trunk_drift" as const,
				suggestion: "rebase" as const,
			}
			: { target: n.target, lanes, suggestion: "proceed" as const };
	}
	return {
		target: n.target,
		lanes,
		severity: top.severity,
		suggestion: suggestionFor(asker, top),
		...(n.drift ? { drift: true } : {}),
	};
};

export const conflictsCheck = async (
	args: CheckArgs,
	x: ExtCtx,
) => {
	const d = db(x.sql);
	const me = args.laneId ? await laneOrFetch(x, d, args.laneId) : null;
	const asker = askerOf(d, me);
	const neighbours: Neighbour[] = [];
	if (args.paths && args.paths.length > 0) {
		neighbours.push(...args.paths.map((p) => neighboursOfPath(d, asker, p)));
	}
	if (args.footprint) {
		neighbours.push(...neighboursOfFootprint(d, asker, args.footprint));
	}
	if (!args.paths?.length && !args.footprint && me !== null) {
		neighbours.push(
			...touchesOf(d, me.lane_id).slice(0, 200).map((t) =>
				neighboursOfPath(d, asker, t.path)
			),
			...neighboursOfFootprint(d, asker, footprintOf(d, me.lane_id)),
		);
	}
	return { results: neighbours.map((n) => resultOf(x, d, asker, n)) };
};

type ListArgs = {
	readonly repo: string;
	readonly laneId?: string;
	readonly state?: "open" | "acked" | "cleared";
};

export const conflictsList = (args: ListArgs, x: ExtCtx) => {
	const d = db(x.sql);
	const states = args.state ? [args.state] : ["open", "acked"];
	const rows = args.laneId
		? d.all<ConflictRow>(
			`SELECT * FROM conflicts WHERE (a = ? OR b = ?) AND state IN (SELECT value FROM json_each(?))
			ORDER BY last_seen DESC, id LIMIT ?`,
			args.laneId,
			args.laneId,
			JSON.stringify(states),
			MAX_LIST,
		)
		: d.all<ConflictRow>(
			`SELECT * FROM conflicts WHERE state IN (SELECT value FROM json_each(?))
			ORDER BY last_seen DESC, id LIMIT ?`,
			JSON.stringify(states),
			MAX_LIST,
		);
	return { conflicts: rows.map(toConflict) };
};

type AckArgs = {
	readonly conflictId: string;
	readonly resolution: ConflictResolution;
	readonly note?: string;
};

/** True when `actor` may acknowledge `row`: an owner of either lane, the user behind it, or a Maintainer. */
const mayAck = async (
	x: ExtCtx,
	d: Db,
	actor: Actor,
	repoId: string,
	row: ConflictRow,
): Promise<boolean> => {
	const acting = new Set(actingPrincipals({ actor }));
	const lanes = getLanes(d, [row.a, row.b].filter((s) => s !== TRUNK));
	const owners = [...lanes.values()].map((l) => l.owner);
	if (owners.some((o) => acting.has(o))) return true;
	for (const owner of owners) {
		try {
			const info = await x.caps.principals.get(owner);
			if (info.ownerUserId !== undefined && acting.has(info.ownerUserId)) {
				return true;
			}
		} catch {
			// unknown principal: not this actor's agent
		}
	}
	if (repoId === "") return false;
	try {
		return await x.caps.authz.check(actor.id, { id: repoId }, "approve");
	} catch {
		return false;
	}
};

/** Shared by the tool and the slot action. */
export const ackConflict = async (
	args: AckArgs,
	actor: Actor,
	repoHint: string | undefined,
	x: ExtCtx,
) => {
	const d = db(x.sql);
	const row = getConflict(d, args.conflictId);
	if (row === null) throw notFound(`conflict ${args.conflictId}`);
	if (actor.kind === "ext" || actor.kind === "system") {
		throw denied("actor", "conflicts_ack needs a user or agent actor");
	}
	const repoId = repoIdOf(x, repoHint);
	if (!(await mayAck(x, d, actor, repoId, row))) {
		throw denied(
			"role",
			"only the owner of either lane, or a Maintainer, acknowledges a conflict",
		);
	}
	if (row.state === "cleared") return toConflict(row);
	const now = x.caps.clock.now();
	const note = args.note ? clean(args.note, 1000) : undefined;
	const env = textEnv(x, d);
	const lanes = getLanes(d, [row.a, row.b].filter((s) => s !== TRUNK));
	const acting = new Set(actingPrincipals({ actor }));
	const actorLane = [...lanes.values()].find((l) => acting.has(l.owner));
	const who = actorLane ? ownerLabel(actorLane) : actor.id;
	d.tx(() => {
		d.run(
			"UPDATE conflicts SET state = 'acked', ack_json = ?, last_seen = ? WHERE id = ?",
			json.encode({
				by: actor.id,
				resolution: args.resolution,
				...(note ? { note } : {}),
				at: now,
			}),
			now,
			row.id,
		);
		const ev: EmitBody = {
			type: "conflicts.acked",
			data: { conflictId: row.id, by: actor.id, resolution: args.resolution },
			subject: { kind: "conflict", id: row.id },
			correlation: `lane:${row.a}`,
		};
		enqueue(d, `ev_${x.caps.ids.ulid()}`, "emit", ev, now);
		for (const lane of lanes.values()) {
			if (acting.has(lane.owner)) continue;
			const other = [...lanes.values()].find((l) => l.lane_id !== lane.lane_id);
			const body: NotifyBody = {
				principal: lane.owner,
				notice: {
					repo: { id: repoId },
					laneId: lane.lane_id,
					kind: "conflict",
					severity: "info",
					text: [
						`radar: ${who} acknowledged ${row.severity} ${row.path}${
							other ? ` (${laneLabel(other)})` : ""
						}: ${args.resolution}${note ? ` — ${note}` : ""}`,
						...(other && args.resolution === "stack"
							? [`their lane: ${fetchCommand(other, env)}`]
							: []),
					].join("\n"),
					data: {
						conflictId: row.id,
						resolution: args.resolution,
						by: actor.id,
					},
					dedupeKey: `${EXT_SHORT}:ack:${row.id}:${now}`,
				},
			};
			enqueue(d, `nt_${x.caps.ids.ulid()}`, "notify", body, now);
		}
	});
	await flushOutbox(x, d);
	return toConflict(getConflict(d, row.id)!);
};

export const callTool = async (
	name: string,
	args: unknown,
	ctx: ToolContext,
	x: ExtCtx,
): Promise<unknown> => {
	switch (name) {
		case "conflicts_check":
			return await conflictsCheck(args as CheckArgs, x);
		case "conflicts_list":
			return conflictsList(args as ListArgs, x);
		case "conflicts_ack":
			return await ackConflict(
				args as AckArgs,
				ctx.actor,
				ctx.repo,
				x,
			);
		default:
			throw invalid(`tartan.radar has no tool ${name}`);
	}
};
