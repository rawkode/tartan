// The clone's lane record (WP11): `<git dir>/tartan/lanes.json`, written by
// `tartan lane open`, read by the pre-push check. It is a cache of the
// caller's own lanes; the forge (`lanes_get`) answers for anything else.

import type { Git } from "./git.ts";

export type LaneRecord = {
	readonly laneId: string;
	readonly repo: string;
	readonly mode: "repo" | "branch";
	/** Absolute lane remote (`repo`) or the repo's git URL (`branch`). */
	readonly remote: string;
	readonly ref: string;
	readonly branch: string;
	/** The `lane-<n>` git remote added for a `repo` lane. */
	readonly remoteName?: string;
	readonly owner?: string;
};

const recordPath = async (git: Git): Promise<string | null> => {
	const out = await git([
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"tartan/lanes.json",
	]);
	return out.code === 0 ? out.stdout.trim() : null;
};

export const readLanes = async (git: Git): Promise<LaneRecord[]> => {
	const path = await recordPath(git);
	if (path === null) return [];
	try {
		return JSON.parse(await Deno.readTextFile(path)) as LaneRecord[];
	} catch {
		return [];
	}
};

export const recordLane = async (git: Git, lane: LaneRecord): Promise<void> => {
	const path = await recordPath(git);
	if (path === null) return;
	const lanes = (await readLanes(git)).filter((l) => l.laneId !== lane.laneId);
	await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	await Deno.writeTextFile(
		path,
		JSON.stringify([...lanes, lane], null, "\t") + "\n",
	);
};
