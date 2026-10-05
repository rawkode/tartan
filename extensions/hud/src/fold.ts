// What one event means for the HUD (pure): the counters it bumps, the lane
// whose state it moves, the review it records. The store applies the effects
// once per event (per-stream cursor), so the fold never needs to know about
// redelivery or backfill.
//
// Events and what they count:
// - `lane.opening` / `lane.opened` / `lane.closed|lost|archived|deleted`:
//   the active-lanes gauge (opening and open lanes) and lanes opened; a lost
//   lane its agent renews comes back (`lane.opened{reason: "resumed"}`), and
//   is not counted as opened again;
// - `conflicts.detected`: a predicted conflict (radar, during work);
// - `conflicts.cleared` with `avoided: true`: a conflict that never reached
//   trunk because a party adapted;
// - `ref.advanced`: each change it lands;
// - `review.requested` (always `route: "human"`) and `review.decided`: the
//   changes reviewed, and those that needed a human.
// Shadow events (a policy on trial) count for nothing.

import type { Envelope } from "@tartan/contract";

/** Per-minute counter names (`counters.metric`); `.sim` variants count simulated agents only. */
export const METRIC = {
	lanesOpened: "lanes.opened",
	lanesActive: "lanes.active",
	predicted: "conflicts.predicted",
	avoided: "conflicts.avoided",
	landed: "landed",
	reviewed: "reviewed",
	human: "human",
} as const;
export type Metric = typeof METRIC[keyof typeof METRIC];

export type LaneState = "opening" | "open" | "gone";

export type HudEffect =
	| { readonly kind: "count"; readonly metric: Metric; readonly n: number }
	| {
		readonly kind: "lane";
		readonly laneId: string;
		readonly state: LaneState;
		/** A lost lane renewed by its agent (the only way back from `gone`). */
		readonly resumed?: true;
	}
	| {
		readonly kind: "review";
		readonly changeId: string;
		/** True when the change was routed to a human (it stays true). */
		readonly human: boolean;
	};

/** The event types the HUD subscribes to (`tartan.json` `subscribe`). */
export const HUD_EVENTS = [
	"lane.*",
	"conflicts.detected",
	"conflicts.cleared",
	"ref.advanced",
	"review.requested",
	"review.decided",
] as const;

const GONE = new Set([
	"lane.closed",
	"lane.lost",
	"lane.archived",
	"lane.deleted",
]);

const record = (data: unknown): Record<string, unknown> =>
	typeof data === "object" && data !== null
		? data as Record<string, unknown>
		: {};

const str = (value: unknown): string | null =>
	typeof value === "string" && value !== "" ? value : null;

export const foldEvent = (ev: Envelope): readonly HudEffect[] => {
	if (ev.shadow) return [];
	const data = record(ev.data);
	if (ev.type.startsWith("lane.")) {
		const laneId = str(data["laneId"]);
		if (laneId === null) return [];
		if (ev.type === "lane.opening") {
			return [{ kind: "lane", laneId, state: "opening" }];
		}
		if (ev.type === "lane.opened") {
			if (data["reason"] === "resumed") {
				return [{ kind: "lane", laneId, state: "open", resumed: true }];
			}
			return [
				{ kind: "lane", laneId, state: "open" },
				{ kind: "count", metric: METRIC.lanesOpened, n: 1 },
			];
		}
		return GONE.has(ev.type) ? [{ kind: "lane", laneId, state: "gone" }] : [];
	}
	switch (ev.type) {
		case "conflicts.detected":
			return [{ kind: "count", metric: METRIC.predicted, n: 1 }];
		case "conflicts.cleared":
			return data["avoided"] === true
				? [{ kind: "count", metric: METRIC.avoided, n: 1 }]
				: [];
		case "ref.advanced": {
			const changes = Array.isArray(data["changes"]) ? data["changes"] : [];
			return changes.length > 0
				? [{ kind: "count", metric: METRIC.landed, n: changes.length }]
				: [];
		}
		case "review.requested":
		case "review.decided": {
			const changeId = str(data["changeId"]);
			if (changeId === null) return [];
			const human = ev.type === "review.requested" ||
				data["route"] === "human";
			return [{ kind: "review", changeId, human }];
		}
		default:
			return [];
	}
};
