// Authorization across the hierarchy (WP3). `createAuthorize(env)` returns
// `authorize(auth, {node, laneId?}, perm)`, the check every route owner
// (WP3–WP11) runs before acting on a node:
//
// 1. the grants role at the node (max over the node and its ancestors; the
//    forge Owner synthesized at Owner on every root; an agent also counts
//    its owner user's grants) from ForgeDO's tree in one RPC;
// 2. `internal` visibility gives every signed-in caller Reporter;
// 3. the credential bounds (`boundRole`: token ceiling, node subtree, lane
//    pin) and the token scopes (`scopesAllow`; sessions are unrestricted);
// 4. `public` visibility gives anyone `read` and `read-metadata` (the public
//    view: no member reads such as hidden refs, see `memberRole`).
//
// The answer is the role when it reaches `PERMISSION_MIN_ROLE[perm]`;
// otherwise `unauthenticated` (anonymous), `denied("scopes")`,
// `denied("scope")` (a target outside the token's node) or `denied("role")`.
// `decide` and `memberRole` are pure (property tests, caps); `createNodeAccess`
// also returns the member role, so the browse routes decide the public view
// without a second RPC.

import {
	boundRole,
	denied,
	type EffectiveRole,
	FORGE_DO_NAME,
	isWithinPath,
	type NodeDto,
	type Permission,
	PERMISSION_MIN_ROLE,
	ROLE,
	scopesAllow,
	type TokenScope,
	unauthenticated,
} from "@tartan/contract";
import { withRpc } from "../../do/dispose.ts";
import {
	actorBoundsOf,
	type AuthContext,
	type AuthorizeTarget,
	type CreateAuthorize,
	type TreeFacade,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";

/** What the grants say about a caller at a node. */
export type AccessFacts = {
	/** The grants role (owner synthesized, agent ∪ owner user; no bounds). */
	readonly granted: EffectiveRole;
	/** The node lies in the token's node subtree (true for sessions and unscoped tokens). */
	readonly withinTokenNode: boolean;
};

/**
 * The member role: grants, Reporter for signed-in callers on `internal`
 * nodes, then the credential bounds. 0 for anonymous callers. Below
 * Reporter on a public repo means the public view.
 */
export const memberRole = (
	auth: AuthContext | null,
	node: Pick<NodeDto, "visibility">,
	facts: AccessFacts,
	laneId?: string,
): EffectiveRole => {
	if (auth === null) return ROLE.none;
	const floor = node.visibility === "internal" ? ROLE.reporter : ROLE.none;
	return boundRole(
		Math.max(facts.granted, floor) as EffectiveRole,
		actorBoundsOf(auth),
		{ withinTokenNode: facts.withinTokenNode, laneId: laneId ?? null },
	);
};

const PUBLIC_PERMS: ReadonlySet<Permission> = new Set([
	"read-metadata",
	"read",
]);

/** `authorize`'s decision for known facts (pure). */
export const decide = (
	auth: AuthContext | null,
	node: Pick<NodeDto, "visibility" | "path">,
	facts: AccessFacts,
	perm: Permission,
	laneId?: string,
): EffectiveRole => {
	const need = PERMISSION_MIN_ROLE[perm];
	if (need === undefined) throw denied("role", `unknown permission ${perm}`);
	const bounds = auth === null ? null : actorBoundsOf(auth);
	const scoped = bounds === null || scopesAllow(bounds.scopes, perm);
	const member = scoped ? memberRole(auth, node, facts, laneId) : ROLE.none;
	const anyone = node.visibility === "public" && PUBLIC_PERMS.has(perm)
		? ROLE.reporter
		: ROLE.none;
	const role = Math.max(member, anyone) as EffectiveRole;
	if (role >= need) return role;
	if (auth === null || bounds === null) {
		throw unauthenticated(`sign in to ${perm} at ${node.path}`);
	}
	if (!scoped) {
		throw denied("scopes", `this token's scopes do not allow ${perm}`);
	}
	if (bounds.nodeId !== null && !facts.withinTokenNode) {
		throw denied("scope", `${node.path} is outside this token's node`);
	}
	throw denied("role", `${perm} needs a higher role at ${node.path}`);
};

/**
 * A member-role check outside the permission table (WP3's node management:
 * creating a group or repo needs Maintainer at the parent). No public path:
 * it is always a member action.
 */
export const decideRole = (
	auth: AuthContext | null,
	node: Pick<NodeDto, "visibility" | "path">,
	facts: AccessFacts,
	need: {
		readonly min: number;
		/** Any one of them (empty: none needed); sessions are unrestricted. */
		readonly scopes: readonly TokenScope[];
		readonly what: string;
	},
): EffectiveRole => {
	if (auth === null) throw unauthenticated(`sign in to ${need.what}`);
	const scopes = actorBoundsOf(auth).scopes;
	if (
		scopes !== null && need.scopes.length > 0 &&
		!need.scopes.some((s) => scopes.includes(s))
	) {
		throw denied("scopes", `this token's scopes do not allow ${need.what}`);
	}
	const role = memberRole(auth, node, facts);
	if (role >= need.min) return role;
	if (
		auth.via !== "session" && auth.nodeId !== null && !facts.withinTokenNode
	) {
		throw denied("scope", `${node.path} is outside this token's node`);
	}
	throw denied("role", `${need.what} needs a higher role at ${node.path}`);
};

/** The tree reads authorization needs (contract `TreeFacade` methods only). */
export type TreeReads = Pick<TreeFacade, "effectiveRole" | "node">;

/** The facts for `auth` at `node`: one RPC, two for a node-scoped token. */
export const accessFacts = async (
	tree: TreeReads,
	auth: AuthContext | null,
	node: Pick<NodeDto, "id" | "path">,
): Promise<AccessFacts> => {
	if (auth === null) return { granted: ROLE.none, withinTokenNode: true };
	const principals = auth.onBehalfOf
		? [auth.principal, auth.onBehalfOf]
		: [auth.principal];
	const tokenNode = auth.via === "session" ? null : auth.nodeId;
	const [granted, scope] = await Promise.all([
		tree.effectiveRole(principals, node.id),
		tokenNode === null || tokenNode === node.id
			? Promise.resolve(null)
			: tree.node(tokenNode),
	]);
	const withinTokenNode = tokenNode === null || tokenNode === node.id ||
		(scope !== null && isWithinPath(scope.path, node.path));
	return { granted, withinTokenNode };
};

export type NodeAccess = {
	/** `authorize`'s answer for `perm` (throws when it does not reach it). */
	readonly role: EffectiveRole;
	/** The member role for reads (0 when the scopes deny `read`): below Reporter = public view. */
	readonly member: EffectiveRole;
};

export type NodeAccessCheck = (
	auth: AuthContext | null,
	target: AuthorizeTarget,
	perm: Permission,
) => Promise<NodeAccess>;

export const createNodeAccessWith = (
	tree: () => TreeReads,
): NodeAccessCheck =>
async (auth, target, perm) => {
	const facts = await accessFacts(tree(), auth, target.node);
	const role = decide(auth, target.node, facts, perm, target.laneId);
	const readable = auth === null ||
		scopesAllow(actorBoundsOf(auth).scopes, "read");
	return {
		role,
		member: readable
			? memberRole(auth, target.node, facts, target.laneId)
			: ROLE.none,
	};
};

const forgeTree = (env: Env): TreeReads =>
	env.FORGE.getByName(FORGE_DO_NAME).tree() as unknown as TreeReads;

/** The forge's tree for one check, its stub disposed when the check settles. */
export const createNodeAccess =
	(env: Env): NodeAccessCheck => (auth, target, perm) =>
		withRpc(
			() => forgeTree(env),
			(tree) => createNodeAccessWith(() => tree)(auth, target, perm),
		);

export const createAuthorize: CreateAuthorize<Env> = (env) => {
	const access = createNodeAccess(env);
	return async (auth, target, perm) => (await access(auth, target, perm)).role;
};
