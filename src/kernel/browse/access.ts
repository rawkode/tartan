// Who may read what in the browse routes (WP3):
//
// - A node is looked up by its exact path; a moved path answers 301; a node
//   the caller may not even see (`read-metadata`) is 404, like a missing one.
// - A repo read needs `read`. Below Reporter as a member (anonymous,
//   roleless, Guest, or a token that does not cover the repo) the caller is in
//   the **public view**: only refs outside the hidden namespaces, and commits
//   reachable from their tips (the first-parent history of each visible tip,
//   bounded), exactly what the gateway's public view would serve.
// - Every ref resolves to a SHA through RepoDO (`resolveRef`, the read
//   context), never through the binding (K15); the SHA must name a commit.

import {
	type EffectiveRole,
	isHiddenRef,
	isIdOf,
	isSha,
	type NodeDto,
	notFound,
	type Permission,
	ROLE,
	scopesAllow,
	trunkRef,
} from "@tartan/contract";
import {
	actorBoundsOf,
	type AuthContext,
	isRepoStoreError,
	type ReadContext,
	type ResolvedSha,
} from "@tartan/contract/kernel.ts";
import {
	type AccessFacts,
	accessFacts,
	decide,
	memberRole,
} from "../tree/authz.ts";
import type { BrowseDeps, BrowseRepo, BrowseTree } from "./deps.ts";
import { hasControlChars } from "./reader.ts";

/** Visible tips whose first-parent history the public view walks. */
export const PUBLIC_TIPS_MAX = 4;
/** Commits per visible tip the public view checks reachability against. */
export const PUBLIC_HISTORY_MAX = 1000;

export type NodeLookup =
	| {
		readonly kind: "node";
		readonly node: NodeDto;
		readonly facts: AccessFacts;
	}
	| { readonly kind: "moved"; readonly to: string };

/** The node at exactly `path` that `auth` may see, a 301, or 404. */
export const lookupNode = async (
	tree: BrowseTree,
	auth: AuthContext | null,
	path: string,
): Promise<NodeLookup> => {
	const resolved = await tree.resolvePath(path);
	if (resolved === null || resolved.rest !== "") {
		throw notFound(`nothing at ${path}`);
	}
	if (resolved.redirectTo !== undefined) {
		return { kind: "moved", to: resolved.redirectTo };
	}
	const facts = await accessFacts(tree, auth, resolved.node);
	try {
		decide(auth, resolved.node, facts, "read-metadata");
	} catch {
		throw notFound(`nothing at ${path}`);
	}
	return { kind: "node", node: resolved.node, facts };
};

/** `perm` at a looked-up node (403/401 when the caller may see it but not do this). */
export const requirePerm = (
	auth: AuthContext | null,
	node: NodeDto,
	facts: AccessFacts,
	perm: Permission,
): EffectiveRole => decide(auth, node, facts, perm);

export type RepoView = {
	readonly node: NodeDto;
	readonly role: EffectiveRole;
	/** The public view: no member reads. */
	readonly publicView: boolean;
	readonly repo: BrowseRepo;
};

/** A repo the caller may `read`, with its view. */
export const repoView = async (
	deps: BrowseDeps,
	auth: AuthContext | null,
	path: string,
): Promise<RepoView | { readonly moved: string }> => {
	const found = await lookupNode(deps.tree(), auth, path);
	if (found.kind === "moved") return { moved: found.to };
	if (found.node.kind !== "repo") throw notFound(`${path} is not a repo`);
	const role = decide(auth, found.node, found.facts, "read");
	const readable = auth === null ||
		scopesAllow(actorBoundsOf(auth).scopes, "read");
	const member = readable ? memberRole(auth, found.node, found.facts) : 0;
	return {
		node: found.node,
		role,
		publicView: member < ROLE.reporter,
		repo: deps.repo(found.node.id),
	};
};

// ---------------------------------------------------------------------------
// Refs → commits (K15)
// ---------------------------------------------------------------------------

export type Resolver = {
	/** The commit a ref, lane id or SHA names in this view; `not_found` otherwise. */
	commit(ref: string): Promise<ResolvedSha>;
	/** The default branch's ref name. */
	readonly defaultRef: string;
};

const REF_MAX = 1024;

/** What `createResolver` reads of a view (the MCP read tools pass their own). */
export type ResolverView = Pick<RepoView, "node" | "publicView"> & {
	readonly repo: Pick<BrowseRepo, "resolveRef" | "readContext">;
};

/** The SHA reads `createResolver` needs: a commit exists, first-parent history. */
export type ResolverReads = {
	commit(sha: ResolvedSha): Promise<unknown>;
	log(
		sha: ResolvedSha,
		options?: { readonly limit?: number },
	): Promise<readonly { readonly hash: string }[]>;
};

export const createResolver = (
	view: ResolverView,
	reads: ResolverReads,
): Resolver => {
	const defaultRef = trunkRef(view.node.defaultBranch ?? "main");
	let context: Promise<ReadContext> | null = null;
	/** Visible tips (trunk first) and the histories read so far. */
	let walk: {
		readonly tips: string[];
		readonly seen: Set<string>;
	} | null = null;

	const readContext = (): Promise<ReadContext> => {
		context ??= view.repo.readContext("anon");
		return context;
	};

	/**
	 * Reachable from a visible tip: the tips themselves (and tips held in the
	 * last 10 minutes), then each tip's first-parent history, trunk
	 * first, one bounded `log` at a time until the SHA turns up.
	 */
	const reachable = async (sha: string): Promise<boolean> => {
		if (walk === null) {
			const ctx = await readContext();
			const trunk = await view.repo.resolveRef(defaultRef);
			walk = {
				tips: [
					...(trunk !== null && ctx.visibleTips.includes(trunk) ? [trunk] : []),
					...ctx.visibleTips.filter((t) => t !== trunk),
				].filter(isSha).slice(0, PUBLIC_TIPS_MAX),
				seen: new Set([...ctx.visibleTips, ...ctx.recentTips]),
			};
		}
		while (!walk.seen.has(sha) && walk.tips.length > 0) {
			const tip = walk.tips.shift() as ResolvedSha;
			for (const c of await reads.log(tip, { limit: PUBLIC_HISTORY_MAX })) {
				walk.seen.add(c.hash);
			}
		}
		return walk.seen.has(sha);
	};

	const toSha = async (ref: string): Promise<string | null> => {
		if (isSha(ref)) {
			if (!view.publicView) return ref;
			return await reachable(ref) ? ref : null;
		}
		if (view.publicView) {
			if (
				isIdOf("lane", ref) || isHiddenRef(ref) || ref === "refs/heads/lanes"
			) {
				return null;
			}
			const sha = await view.repo.resolveRef(ref);
			if (sha === null) return null;
			const ctx = await readContext();
			return ctx.visibleTips.includes(sha) ? sha : null;
		}
		return await view.repo.resolveRef(ref);
	};

	return {
		defaultRef,
		commit: async (raw) => {
			const ref = raw.trim();
			if (
				ref === "" || ref.length > REF_MAX || hasControlChars(ref)
			) {
				throw notFound(`unknown ref ${raw}`);
			}
			const sha = await toSha(ref);
			if (sha === null || !isSha(sha)) throw notFound(`unknown ref ${ref}`);
			// A caller-named SHA of a blob or tree is no commit: the binding
			// answers `INTERNAL_ERROR`/`INVALID_INPUT` for it, never a ref.
			const commit = await reads.commit(sha as ResolvedSha).catch((error) => {
				if (
					isSha(ref) &&
					isRepoStoreError(error, "INTERNAL_ERROR", "INVALID_INPUT")
				) {
					return null;
				}
				throw error;
			});
			if (commit === null) throw notFound(`no commit ${sha}`);
			return sha as ResolvedSha;
		},
	};
};
