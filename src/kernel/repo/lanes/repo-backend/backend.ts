// The `repo` implementation of `LaneBackend` (WP5b; K11): every lane is its own
// Artifacts repo, the lane's CURRENT seed attempt's
// `l-<repoUlid>-<laneUlid>[-<n>]`, whose only ref is `refs/heads/main`.
//
// - `remoteFor`: the lane repo's `Upstream` with a memory-only token scoped
//   to that one repo (the gateway's lane-remote pushes use the `write` one,
//   layer 2 of the lane-remote isolation).
// - `readTip`: v2 `ls-refs` of `refs/heads/main`; null when the repo is gone
//   or has no `main`.
// - `fetchSpec`: where a sandbox exec fetches a lane head by SHA (the remote
//   recorded when the attempt created the repo; the exec mints its own read
//   token for exactly this name).
// - `gc`: `gc.ts`.

import { LANE_REPO_HEAD_REF, notFound, unavailable } from "@tartan/contract";
import type {
	LaneBackend,
	LaneFetchSpec,
	LaneRow,
	Upstream,
} from "@tartan/contract/kernel.ts";
import { attemptByName, type Ctx } from "./context.ts";
import { createLaneRepoGc, readTip } from "./gc.ts";

const nameOf = (lane: LaneRow): string => {
	if (lane.mode !== "repo" || lane.repo_name === null) {
		throw notFound(`lane ${lane.id} has no lane repo`);
	}
	return lane.repo_name;
};

export const createRepoLaneBackend = (
	ctx: Ctx,
	gc: ReturnType<typeof createLaneRepoGc>,
): LaneBackend => {
	const remoteFor = async (
		lane: LaneRow,
		scope: "read" | "write",
	): Promise<Upstream> => {
		const name = nameOf(lane);
		const token = await ctx.access.token(name, scope);
		const known = attemptByName(ctx, name);
		if (known !== null && known.remote === null) {
			ctx.tx(() =>
				ctx.sql.exec(
					"UPDATE lane_seed_attempts SET remote = ? WHERE repo_name = ?",
					token.remote,
					name,
				)
			);
		}
		return {
			artifactsName: name,
			remote: token.remote,
			token: token.token,
			expiresAt: token.expiresAt,
			kind: "lane-repo",
			ref: LANE_REPO_HEAD_REF,
		};
	};

	const fetchSpec = (lane: LaneRow, sha: string): LaneFetchSpec => {
		const name = nameOf(lane);
		const remote = attemptByName(ctx, name)?.remote ??
			ctx.access.knownRemote(name);
		if (remote === null || remote === undefined) {
			// Learn it for the caller's retry (a step retry of compose).
			ctx.detach("lane repo remote lookup failed", async () => {
				const learned = await ctx.access.remote(name);
				ctx.tx(() =>
					ctx.sql.exec(
						"UPDATE lane_seed_attempts SET remote = ? WHERE repo_name = ?",
						learned,
						name,
					)
				);
			});
			throw unavailable(`the remote of ${name} is not known yet; retry`);
		}
		return { remote, sha, token: { artifactsName: name, scope: "read" } };
	};

	return {
		name: "repo",
		remoteFor,
		readTip: (lane) =>
			lane.repo_name === null
				? Promise.resolve(null)
				: readTip(ctx, lane.repo_name),
		fetchSpec,
		gc: (lane, expectHead) => gc.gc(lane, expectHead),
	};
};
