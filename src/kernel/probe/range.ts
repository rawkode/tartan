// K17 lane range: `rangeBase` is the merge base of `after` with trunk. Trunk is
// linear and `trunk_commits` gives every trunk commit a `seq`, so the merge
// base is the reachable trunk commit with the highest seq. The walk is SHA-only
// and runs in the repo that holds `after` (the lane repo of a `repo` lane): it
// follows first-parent chains one `log` page at a time, asks RepoDO for the
// trunk positions of each page in one batched call (`trunkSeqs`), stops a chain
// at its first trunk commit, and queues second parents (merges) as new chains.
// Past `LANE_RANGE_MAX_COMMITS` non-trunk commits, or on a root outside trunk,
// it reports `truncated` and the caller falls back to `lanes.base_sha` (or the
// default branch tip for a non-lane branch). Committer dates are never
// consulted, so forged dates cannot move the base.

import type { RepoStoreCommit, ResolvedSha } from "@tartan/contract/kernel.ts";
import { LANE_RANGE_MAX_COMMITS } from "../../constants.ts";

export type RangeWalkDeps = {
	/** First-parent history from `from` (inclusive), newest first. */
	log(
		from: ResolvedSha,
		options: { readonly limit: number },
	): Promise<RepoStoreCommit[]>;
	/** `trunk_commits.seq` of the given shas (absent = not on trunk). */
	trunkSeqs(shas: readonly string[]): Promise<Record<string, number>>;
};

export type RangeWalk = {
	/** Null when truncated. */
	readonly rangeBase: string | null;
	readonly truncated: boolean;
	readonly reason?:
		| "too-many-commits"
		| "root-outside-trunk"
		| "missing-commit";
	/** The non-trunk commits visited (the range), in walk order, newest first per chain. */
	readonly commits: readonly RepoStoreCommit[];
	/** `log` calls made (a typical lane push needs one). */
	readonly logPages: number;
};

/** Commits asked for by the first `log` page of a chain. */
export const RANGE_FIRST_PAGE = 100;

export const walkLaneRange = async (
	deps: RangeWalkDeps,
	after: ResolvedSha,
	options: { readonly maxCommits?: number; readonly firstPage?: number } = {},
): Promise<RangeWalk> => {
	const maxCommits = options.maxCommits ?? LANE_RANGE_MAX_COMMITS;
	const firstPage = options.firstPage ?? RANGE_FIRST_PAGE;
	const visited = new Set<string>();
	const range: RepoStoreCommit[] = [];
	const chains: ResolvedSha[] = [after];
	let best: { sha: string; seq: number } | null = null;
	let logPages = 0;
	const stop = (reason: NonNullable<RangeWalk["reason"]>): RangeWalk => ({
		rangeBase: null,
		truncated: true,
		reason,
		commits: range,
		logPages,
	});

	while (chains.length > 0) {
		let cursor: ResolvedSha | null = chains.shift()!;
		let pageSize = firstPage;
		while (cursor !== null && !visited.has(cursor)) {
			const page = await deps.log(cursor, { limit: pageSize });
			logPages++;
			if (page.length === 0 || page[0].hash !== cursor) {
				return stop("missing-commit");
			}
			const fresh = page.filter((c) => !visited.has(c.hash));
			const seqs = await deps.trunkSeqs(fresh.map((c) => c.hash));
			let next: ResolvedSha | null = null;
			let chainDone = false;
			for (const commit of page) {
				if (visited.has(commit.hash)) {
					chainDone = true;
					break;
				}
				visited.add(commit.hash);
				const seq = seqs[commit.hash];
				if (seq !== undefined) {
					if (best === null || seq > best.seq) best = { sha: commit.hash, seq };
					chainDone = true;
					break;
				}
				range.push(commit);
				if (range.length > maxCommits) return stop("too-many-commits");
				if (commit.parents.length === 0) return stop("root-outside-trunk");
				for (const parent of commit.parents.slice(1)) {
					if (!visited.has(parent)) chains.push(parent as ResolvedSha);
				}
				next = commit.parents[0] as ResolvedSha;
			}
			// The page ended inside the chain: continue from the last commit's
			// first parent, with pages as large as the remaining budget.
			cursor = chainDone ? null : next;
			pageSize = Math.min(
				1000,
				Math.max(firstPage, maxCommits - range.length + 1),
			);
		}
	}
	return best === null
		? stop("root-outside-trunk")
		: { rangeBase: best.sha, truncated: false, commits: range, logPages };
};
