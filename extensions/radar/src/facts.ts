// Facts radar gathers through caps before a state transaction (every call is
// best effort: a missing fact degrades a label or a project, never the
// join): the lane itself, its owner's label, its work item's title and why,
// the repo's path and trunk branch, and project roots at a trunk commit.

import {
	type ExtCtx,
	type Footprint,
	type Lane,
	WORK_REF_RE,
} from "@tartan/contract";
import type { Db } from "@tartan/ext-api";
import { type ProjectRoot } from "./paths.ts";
import type { LaneFacts } from "./store.ts";
import { getMeta, getRoots, putRoots, setMeta } from "./store.ts";
import type { TextEnv } from "./texts.ts";

const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
	try {
		return await fn();
	} catch {
		return null;
	}
};

/** The repo of a repo-scoped installation (`repo:<id>` scope key), else the hint. */
export const repoIdOf = (x: ExtCtx, hint?: string | null): string => {
	const key = x.install.scopeKey;
	if (key.startsWith("repo:")) return key.slice("repo:".length);
	return hint ?? "";
};

/** Radar's view of a lane state: `landing` still counts as submitted. */
export const projectState = (state: string): string =>
	state === "landing" ? "submitted" : state;

export const isActiveLaneState = (state: string): boolean =>
	state === "open" || state === "submitted" || state === "landing";

export const fetchLane = (x: ExtCtx, laneId: string): Promise<Lane | null> =>
	attempt(() => x.caps.lanes.get(laneId));

type Seed = {
	readonly laneId: string;
	readonly owner: string;
	readonly entity?: { readonly kind: string; readonly id: string } | null;
	readonly base: string;
	readonly head?: string | null;
	readonly mode: string;
	readonly state: string;
	readonly footprint?: Footprint;
	readonly openedAt: number;
};

export type GatheredLane = {
	readonly facts: LaneFacts;
	readonly footprint: Footprint | undefined;
};

/** Lane facts from the lane itself (when readable), its owner and its work item. */
export const gatherLane = async (
	x: ExtCtx,
	seed: Seed,
	known: Lane | null = null,
): Promise<GatheredLane> => {
	const lane = known ?? await fetchLane(x, seed.laneId);
	const owner = lane?.owner ?? seed.owner;
	const entity = lane?.entity ?? seed.entity ?? null;
	const [principal, work] = await Promise.all([
		attempt(() => x.caps.principals.get(owner)),
		entity?.kind === "work" && WORK_REF_RE.test(entity.id)
			? attempt(() =>
				x.caps.interfaces.call("work@1", "work_get", { ref: entity.id })
			)
			: Promise.resolve(null),
	]);
	const item = (work ?? {}) as { title?: unknown; why?: unknown };
	return {
		facts: {
			laneId: seed.laneId,
			owner,
			entityKind: entity?.kind ?? null,
			entityId: entity?.id ?? null,
			base: lane?.base ?? seed.base,
			head: lane?.head ?? seed.head ?? null,
			state: projectState(lane?.state ?? seed.state),
			mode: lane?.mode ?? seed.mode,
			ref: lane?.ref ??
				(seed.mode === "repo"
					? "refs/heads/main"
					: `refs/heads/lanes/${seed.laneId}`),
			remote: lane?.remote ?? null,
			ownerLabel: principal?.handle ?? null,
			workTitle: typeof item.title === "string" ? item.title : null,
			workWhy: typeof item.why === "string" ? item.why.slice(0, 500) : null,
			openedAt: lane?.createdAt ?? seed.openedAt,
		},
		footprint: lane?.footprint ?? seed.footprint,
	};
};

/** Caches the repo's path and default branch (writable contexts only). */
export const ensureRepoMeta = async (
	x: ExtCtx,
	d: Db,
	repoId: string,
): Promise<void> => {
	if (getMeta(d, "repo_path") !== null || repoId === "") return;
	const info = await attempt(() => x.caps.repo.info({ id: repoId }));
	if (info === null) return;
	d.tx(() => {
		setMeta(d, "repo_path", info.path);
		setMeta(d, "default_branch", info.defaultBranch);
	});
};

/** The text environment from meta and the installation config (`origin`). */
export const textEnv = (x: ExtCtx, d: Db): TextEnv => {
	const config = (x.config ?? {}) as { origin?: unknown };
	const origin = typeof config.origin === "string" &&
			/^https:\/\/[^\s/]+$/.test(config.origin.replace(/\/+$/, ""))
		? config.origin.replace(/\/+$/, "")
		: null;
	return {
		origin,
		trunk: getMeta(d, "default_branch") ?? "main",
		repoPath: getMeta(d, "repo_path"),
	};
};

/**
 * Project roots of the graph at trunk commit `sha` (cached per sha). Read-only
 * callers pass `fetch: false` and get the cache only.
 */
export const rootsAt = async (
	x: ExtCtx,
	d: Db,
	repoId: string,
	sha: string,
): Promise<ProjectRoot[]> => {
	const cached = getRoots(d, sha);
	if (cached !== null) return cached;
	const graph = await attempt(() =>
		x.caps.repo.projectGraph({ id: repoId }, sha)
	);
	if (graph === null) return [];
	const roots = graph.projects.map((p) => ({ name: p.name, root: p.root }));
	d.tx(() => putRoots(d, sha, roots, x.caps.clock.now()));
	return getRoots(d, sha) ?? [];
};
