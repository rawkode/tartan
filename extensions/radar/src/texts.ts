// Suggestions and the text of notices, tool answers and context. A suggestion
// that points at another lane carries that lane's own fetch command, taken from
// its backend: `git fetch <its lane remote> main` for a `repo` lane, `git fetch
// origin refs/heads/lanes/<id>` for a `branch` lane. Untrusted text (work
// titles, why) is stripped of control characters and kept short.

import { laneGitPath, stripControl, truncateChars } from "@tartan/contract";
import type { LaneRow } from "./model.ts";
import { TRUNK } from "./model.ts";
import type { ConflictSeverity, Suggestion } from "./types.ts";

type LaneLike = Pick<
	LaneRow,
	| "lane_id"
	| "owner"
	| "owner_label"
	| "entity_kind"
	| "entity_id"
	| "work_title"
	| "state"
	| "mode"
	| "ref"
	| "remote"
>;

export type TextEnv = {
	/** Canonical https origin of the forge, when the installation config names one. */
	readonly origin: string | null;
	/** Trunk's branch name (the repo's default branch). */
	readonly trunk: string;
	/** The repo's node path, for a lane remote radar has not seen yet. */
	readonly repoPath: string | null;
};

export const clean = (text: string, max: number): string =>
	truncateChars(stripControl(text).replace(/\s+/g, " ").trim(), max);

/** The agent or user label of a lane's owner. */
export const ownerLabel = (lane: Pick<LaneRow, "owner" | "owner_label">) =>
	clean(lane.owner_label ?? lane.owner, 40);

/** `#38` from `acme/platform/router#38`. */
export const shortWork = (
	lane: Pick<LaneRow, "entity_kind" | "entity_id">,
): string | null => {
	if (!lane.entity_id) return null;
	if (lane.entity_kind === "work") {
		const hash = lane.entity_id.lastIndexOf("#");
		return hash >= 0 ? lane.entity_id.slice(hash) : lane.entity_id;
	}
	return null;
};

/** `ln_7 (codex-2, #38 "per-tenant quotas")`. */
export const laneLabel = (lane: LaneLike): string => {
	const work = shortWork(lane);
	const title = lane.work_title ? ` "${clean(lane.work_title, 60)}"` : "";
	const what = work ? `, ${work}${title}` : title ? `,${title}` : "";
	return `${lane.lane_id} (${ownerLabel(lane)}${what})`;
};

/** The command that fetches another lane's head. */
export const fetchCommand = (lane: LaneLike, env: TextEnv): string => {
	if (lane.mode === "repo") {
		const remote = lane.remote ??
			laneGitPath(env.repoPath ?? "<repo>", lane.lane_id);
		const url = env.origin
			? `${env.origin.replace(/\/+$/, "")}${remote}`
			: remote;
		return `git fetch ${url} main`;
	}
	return `git fetch origin ${lane.ref ?? `refs/heads/lanes/${lane.lane_id}`}`;
};

const sameWork = (a: LaneLike, b: LaneLike): boolean =>
	a.entity_kind === "work" && b.entity_kind === "work" &&
	a.entity_id !== null && a.entity_id === b.entity_id;

/**
 * What `me` should do about an overlap with `other` (deterministic):
 * - trunk drift → `rebase` onto trunk;
 * - a second claim of the same work item → `yield`;
 * - declared footprints → `coordinate` before editing;
 * - same project, different files → `proceed`;
 * - a shared file → `stack` onto the other lane when it is already
 *   submitted (ahead of you), else `coordinate`.
 */
export const suggest = (
	severity: ConflictSeverity,
	me: LaneLike,
	other: LaneLike | null,
): Suggestion => {
	if (severity === "trunk_drift" || other === null) return "rebase";
	if (sameWork(me, other)) return "yield";
	if (severity === "declared") return "coordinate";
	if (severity === "same_project") return "proceed";
	return other.state === "submitted" ? "stack" : "coordinate";
};

/** The suggestion with the exact commands (`suggestion: …` lines). */
export const suggestionText = (
	suggestion: Suggestion,
	other: LaneLike | null,
	env: TextEnv,
): string => {
	const rebaseTrunk = `git fetch origin ${env.trunk} && git rebase FETCH_HEAD`;
	if (other === null) return `rebase onto trunk (${rebaseTrunk})`;
	const who = ownerLabel(other);
	const stack = `${fetchCommand(other, env)} && git rebase FETCH_HEAD`;
	switch (suggestion) {
		case "coordinate":
			return `coordinate (MCP inbox_send to ${who}) or stack onto ${other.lane_id} (${stack})`;
		case "stack":
			return `stack onto ${other.lane_id} (${stack}), or coordinate (MCP inbox_send to ${who})`;
		case "rebase":
			return `rebase onto trunk (${rebaseTrunk})`;
		case "yield":
			return `yield: ${other.lane_id} works on the same item; coordinate with ${who} (MCP inbox_send) before going on`;
		case "proceed":
			return "proceed (different files in the same project)";
	}
};

export type NoticeItem = {
	readonly severity: ConflictSeverity;
	readonly path: string;
	readonly other: LaneLike | null;
};

const itemLine = (item: NoticeItem): string =>
	item.other === null
		? `${item.severity}  ${item.path} ⟷ trunk (landed since your base)`
		: `${item.severity}  ${item.path} ⟷ ${laneLabel(item.other)}`;

/**
 * The notice to the lane that changed (its push, its claim or a landing that
 * drifted it): one summary, the top items, and the suggestion for the first.
 */
export const selfNotice = (
	me: LaneLike,
	items: readonly NoticeItem[],
	suggestion: Suggestion,
	env: TextEnv,
	maxItems: number,
): string => {
	const counts = new Map<string, number>();
	for (const i of items) {
		counts.set(i.severity, (counts.get(i.severity) ?? 0) + 1);
	}
	const summary = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
	const lines = items.slice(0, maxItems).map(itemLine);
	const more = items.length > maxItems
		? [
			`(+${
				items.length - maxItems
			} more: conflicts_list {laneId: "${me.lane_id}"})`,
		]
		: [];
	return [
		`radar: ${summary} on your lane ${me.lane_id}`,
		...lines,
		...more,
		`suggestion: ${suggestionText(suggestion, items[0]?.other ?? null, env)}`,
	].join("\n");
};

/** The notice to the other lane's owner: who now overlaps them, and where. */
export const peerNotice = (
	peer: LaneLike,
	cause: LaneLike,
	items: readonly NoticeItem[],
	suggestion: Suggestion,
	env: TextEnv,
	maxItems: number,
): string => {
	const top = items[0]?.severity ?? "declared";
	const paths = items.slice(0, maxItems).map((i) => i.path);
	const more = items.length > maxItems
		? ` (+${items.length - maxItems} more)`
		: "";
	const verb = top === "declared"
		? `overlaps the footprint of your lane ${peer.lane_id}`
		: `now edits what your lane ${peer.lane_id} edits`;
	return [
		`radar: ${top} ${laneLabel(cause)} ${verb}: ${paths.join(", ")}${more}`,
		`suggestion: ${suggestionText(suggestion, cause, env)}`,
	].join("\n");
};

export const sideOf = (row: { a: string; b: string }, laneId: string) =>
	row.a === laneId ? row.b : row.a;

export const isTrunk = (side: string): boolean => side === TRUNK;
