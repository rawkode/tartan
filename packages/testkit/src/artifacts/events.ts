// `cf.artifacts.repo.pushed` trigger payloads: one event per updated ref; no event for a no-op push or a repo created by
// import; `commits` only for `refs/heads/*`, newest first, walked from
// `after` back to `before` (to the root for a new branch), capped at 20,
// with `totalCommitsCount` capped at 21 and `commitsTruncated` set past 20.
// There is no pusher and no top-level timestamp.

import { parseCommit, ZERO_OID } from "../git/objects.ts";
import type { RepoState } from "./state.ts";

export type PushedCommit = {
	readonly id: string;
	readonly message: string;
	readonly messageTruncated: boolean;
	readonly timestamp: string;
	readonly author: { readonly name: string; readonly email: string };
	readonly committer: { readonly name: string; readonly email: string };
	readonly parents: readonly string[];
};

export type FakePushEvent = {
	readonly id: string;
	readonly type: "cf.artifacts.repo.pushed";
	readonly source: { readonly namespace: string; readonly repoName: string };
	readonly payload: {
		readonly ref: string;
		readonly before: string;
		readonly after: string;
		readonly commits: readonly PushedCommit[];
		readonly totalCommitsCount: number;
		readonly commitsTruncated: boolean;
	};
};

export const PUSH_EVENT_COMMITS_MAX = 20;

const pushedCommits = (
	repo: RepoState,
	ref: string,
	before: string,
	after: string,
): PushedCommit[] => {
	if (!ref.startsWith("refs/heads/") || after === ZERO_OID) return [];
	const out: PushedCommit[] = [];
	let current: string | undefined = after;
	// One past the cap is enough to know the list was truncated.
	while (
		current && current !== before && out.length <= PUSH_EVENT_COMMITS_MAX
	) {
		const object = repo.store.get(current);
		if (!object || object.type !== "commit") break;
		const c = parseCommit(object.data);
		out.push({
			id: current,
			message: c.message.replace(/\n$/, ""),
			messageTruncated: false,
			timestamp: new Date(c.committer.at * 1000).toISOString(),
			author: { name: c.author.name, email: c.author.email },
			committer: { name: c.committer.name, email: c.committer.email },
			parents: [...c.parents],
		});
		current = c.parents[0];
	}
	return out;
};

export const pushEvent = (
	namespace: string,
	repo: RepoState,
	ref: string,
	before: string,
	after: string,
): FakePushEvent => {
	const walked = pushedCommits(repo, ref, before, after);
	return {
		id: crypto.randomUUID(),
		type: "cf.artifacts.repo.pushed",
		source: { namespace, repoName: repo.name },
		payload: {
			ref,
			before,
			after,
			commits: walked.slice(0, PUSH_EVENT_COMMITS_MAX),
			totalCommitsCount: walked.length,
			commitsTruncated: walked.length > PUSH_EVENT_COMMITS_MAX,
		},
	};
};
