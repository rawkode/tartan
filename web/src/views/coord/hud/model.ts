// The HUD page's model (WP19 view hosting WP20's `tartan.hud`; WP19
// acceptance "every judge question has a screen reachable in ≤ 2 clicks
// from the HUD"). Pure: which nodes the page shows, which repositories the
// "Where to look" table lists (a bounded walk of the hierarchy), and the
// link each judge question takes for a repository. No DOM, no fetching of
// its own: callers pass the API's `children` reader.

import type {
	NodeDto,
	NodesResponse,
	StaticContributionDto,
} from "@tartan/contract/api.ts";
import { nodeHref } from "../../../router/params.ts";

/** Top-level namespaces whose HUD the forge home shows. */
export const MAX_NAMESPACES = 8;
/** `children()` calls the "Where to look" walk may make. */
export const MAX_WALK_CALLS = 12;
/** Repositories the "Where to look" table lists. */
export const MAX_GUIDE_REPOS = 6;
/** The swarm's sharded sim repos live under `<namespace>/sim`. */
export const SIM_GROUP = "sim";

export const hudHref = (node: string): string =>
	`/-/hud?node=${encodeURIComponent(node)}`;

/** The `?node=` query value, when it is a plausible node path. */
export const selectedNode = (query: unknown): string | null => {
	const value = Array.isArray(query) ? query[0] : query;
	if (typeof value !== "string") return null;
	const path = value.replace(/^\/+|\/+$/g, "");
	return /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/.test(path)
		? path
		: null;
};

export type Children = (
	parent: string,
	cursor?: string,
) => Promise<Pick<NodesResponse, "nodes" | "cursor">>;

export type Walked = {
	readonly repos: readonly NodeDto[];
	/** True when the walk stopped at a limit before it saw everything. */
	readonly truncated: boolean;
	/** Sim groups that were counted by the HUD but not listed. */
	readonly simGroups: readonly string[];
};

/**
 * Repositories under `roots`, breadth first, at most `MAX_WALK_CALLS`
 * `children()` calls and `MAX_GUIDE_REPOS` repos. A root that is itself a
 * repo is listed as is. Groups named `sim` (the swarm's shards) are not
 * entered: their repos are many and simulated.
 */
export const walkRepos = async (
	roots: readonly NodeDto[],
	children: Children,
	limits: { readonly calls?: number; readonly repos?: number } = {},
): Promise<Walked> => {
	const maxCalls = limits.calls ?? MAX_WALK_CALLS;
	const maxRepos = limits.repos ?? MAX_GUIDE_REPOS;
	const repos: NodeDto[] = [];
	const simGroups: string[] = [];
	const queue: NodeDto[] = [];
	for (const root of roots) {
		if (root.kind === "repo") repos.push(root);
		else queue.push(root);
	}
	let calls = 0;
	let truncated = false;
	while (queue.length > 0 && repos.length < maxRepos) {
		if (calls >= maxCalls) {
			truncated = true;
			break;
		}
		const parent = queue.shift()!;
		calls++;
		let page: Pick<NodesResponse, "nodes" | "cursor">;
		try {
			page = await children(parent.path);
		} catch {
			continue;
		}
		if (page.cursor) truncated = true;
		for (const child of page.nodes) {
			if (child.archived) continue;
			if (child.kind === "repo") repos.push(child);
			else if (child.slug === SIM_GROUP) simGroups.push(child.path);
			else queue.push(child);
		}
	}
	if (repos.length > maxRepos || queue.length > 0) truncated = true;
	return {
		repos: repos.slice(0, maxRepos),
		truncated,
		simGroups,
	};
};

export type JudgeQuestion = {
	readonly id: "q1" | "q2" | "q3" | "q4" | "q5";
	readonly question: string;
	readonly answer: string;
};

/** The five questions and where Tartan answers each. */
export const JUDGE_QUESTIONS: readonly JudgeQuestion[] = [
	{
		id: "q1",
		question: "How do agents know what others are doing?",
		answer: "Lanes",
	},
	{
		id: "q2",
		question: "What happens when changes conflict?",
		answer: "Radar",
	},
	{ id: "q3", question: "How do you review everything?", answer: "Changes" },
	{
		id: "q4",
		question: "How do you track why a change was made?",
		answer: "Advances",
	},
	{
		id: "q5",
		question: "How do you compare and pick what ships?",
		answer: "Policies",
	},
];

export type QuestionLink = {
	readonly id: JudgeQuestion["id"];
	readonly text: string;
	readonly href: string;
};

const tabHref = (
	repo: string,
	tabs: readonly StaticContributionDto[],
	route: string,
): string | null => {
	const tab = tabs.find((t) =>
		t.slot === "repo.tab" && (t.route ?? "").split("/")[0] === route
	);
	return tab ? `${nodeHref(repo)}/-/${route}` : null;
};

/**
 * One click from the HUD for each question. Kernel views (Lanes, Advances)
 * always exist; extension tabs (Radar, Weave, Changes) only when the repo's
 * view lists them, with a kernel view as the fallback.
 */
export const questionLinks = (
	repo: string,
	tabs: readonly StaticContributionDto[],
): readonly QuestionLink[] => {
	const base = nodeHref(repo);
	const lanes = `${base}/-/lanes`;
	const advances = `${base}/-/advances`;
	const radar = tabHref(repo, tabs, "radar");
	const weave = tabHref(repo, tabs, "weave");
	const changes = tabHref(repo, tabs, "changes");
	return [
		{ id: "q1", text: "Lanes", href: lanes },
		radar
			? { id: "q2", text: "Radar", href: radar }
			: weave
			? { id: "q2", text: "Weave", href: weave }
			: { id: "q2", text: "Lanes", href: lanes },
		changes
			? { id: "q3", text: "Changes", href: changes }
			: { id: "q3", text: "Advances", href: advances },
		{ id: "q4", text: "Advances", href: advances },
		{ id: "q5", text: "Policies", href: "/-/extensions" },
	];
};
