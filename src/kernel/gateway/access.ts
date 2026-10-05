// Who may do what on a canonical git URL (WP4): the repo the path names, the
// caller's credential-bounded role on it, and the upload-pack view (member or
// public) or the receive-pack gate. 401 comes first for anonymous callers that
// need credentials, so stock git asks for them before it sends a pack [E A3].
//
// The role is computed here, not by `authorize`, because the public view
// must tell a granted Reporter from a reader that only public
// visibility admits: grants come from WP3's `effectiveRole` (grants and
// owners only), `internal` visibility adds Reporter for any signed-in
// caller, and `boundRole` applies the token's ceiling, node subtree and
// lane pin exactly as RepoDO's write credential does.

import {
	boundRole,
	type EffectiveRole,
	isWithinPath,
	type NodeDto,
	ROLE,
} from "@tartan/contract";
import { actorBoundsOf, type AuthContext } from "@tartan/contract/kernel.ts";
import type { GatewayTree, GitRequest, GitService } from "./types.ts";
import { mayReceivePack, memberView } from "./policy.ts";
import { gitText, unauthorized } from "./respond.ts";

export type RepoAccess = {
	readonly kind: "ok";
	readonly node: NodeDto;
	/** The repo id is its node's ULID (`r-<id>`, `repo:<id>`). */
	readonly repoId: string;
	/** Credential-bounded; for receive-pack at the token's lane pin. */
	readonly role: EffectiveRole;
	/** Upload-pack only: which view the caller gets. */
	readonly view: "member" | "public";
};

export type AccessResult = RepoAccess | {
	readonly kind: "response";
	readonly response: Response;
};

const respond = (response: Response): AccessResult => ({
	kind: "response",
	response,
});

/**
 * The caller's role on `node`: grants (and the user an agent acts for),
 * Reporter for any signed-in caller on an `internal` repo, then the
 * credential bounds at `laneId` (a lane-pinned token is Reporter at most on
 * anything but its lane).
 */
export const roleOf = async (
	tree: GatewayTree,
	auth: AuthContext,
	node: NodeDto,
	laneId: string | null,
): Promise<EffectiveRole> => {
	const principals = auth.onBehalfOf
		? [auth.principal, auth.onBehalfOf]
		: [auth.principal];
	let granted = await tree.effectiveRole(principals, node.id);
	if (node.visibility === "internal" && granted < ROLE.reporter) {
		granted = ROLE.reporter;
	}
	const bounds = actorBoundsOf(auth);
	let within = true;
	if (bounds.nodeId !== null && bounds.nodeId !== node.id) {
		const root = await tree.node(bounds.nodeId);
		within = root !== null && isWithinPath(root.path, node.path);
	}
	return boundRole(granted, bounds, { withinTokenNode: within, laneId });
};

/** 401 for anonymous callers, 404 otherwise: a missing repo and an unreadable one look the same. */
const missing = (auth: AuthContext | null): AccessResult =>
	respond(
		auth === null ? unauthorized() : gitText(404, "repository not found"),
	);

/** The access decision on a resolved repo node. */
const decide = async (
	tree: GatewayTree,
	auth: AuthContext | null,
	node: NodeDto,
	service: GitService,
): Promise<AccessResult> => {
	const role = auth === null ? ROLE.none : await roleOf(
		tree,
		auth,
		node,
		service === "git-receive-pack" ? auth.laneId : null,
	);
	if (service === "git-upload-pack") {
		if (memberView(auth, role)) {
			return { kind: "ok", node, repoId: node.id, role, view: "member" };
		}
		if (node.visibility === "public") {
			return { kind: "ok", node, repoId: node.id, role, view: "public" };
		}
		if (auth === null) return respond(unauthorized());
		return role >= ROLE.guest
			? respond(gitText(403, "this credential cannot read this repository"))
			: missing(auth);
	}
	const caller = auth as AuthContext;
	if (!mayReceivePack(caller, role)) {
		return role === ROLE.none && node.visibility !== "public"
			? missing(caller)
			: respond(
				gitText(
					403,
					"pushing needs Developer+ and a token with the lanes or repo:write scope",
				),
			);
	}
	if (node.archived) {
		return respond(gitText(403, "this repository is archived (read-only)"));
	}
	return { kind: "ok", node, repoId: node.id, role, view: "member" };
};

/** A plain 404: a lane remote that does not exist for this caller. */
export const laneNotFound = (): Response =>
	gitText(404, "lane remote not found");

/**
 * The access decision on a lane remote: no public
 * view on any repo visibility. Upload-pack needs the member view of the
 * repo (Reporter+ with a token that reads code); receive-pack needs
 * Developer+ at the URL's lane (a token pinned to another lane is Reporter
 * at most here) and the `lanes` or `repo:write` scope. Anonymous callers
 * were answered 401 before; roleless ones get 404.
 */
const decideLane = async (
	tree: GatewayTree,
	auth: AuthContext,
	node: NodeDto,
	service: GitService,
	laneId: string,
): Promise<AccessResult> => {
	const role = await roleOf(
		tree,
		auth,
		node,
		service === "git-receive-pack" ? laneId : null,
	);
	if (role === ROLE.none) return respond(laneNotFound());
	if (service === "git-upload-pack") {
		return memberView(auth, role)
			? { kind: "ok", node, repoId: node.id, role, view: "member" }
			: respond(gitText(403, "this credential cannot read this lane"));
	}
	if (!mayReceivePack(auth, role)) {
		return respond(
			gitText(
				403,
				"pushing a lane needs Developer+ and a token with the lanes or repo:write scope (a lane-pinned token pushes only its own lane)",
			),
		);
	}
	if (node.archived) {
		return respond(gitText(403, "this repository is archived (read-only)"));
	}
	return { kind: "ok", node, repoId: node.id, role, view: "member" };
};

/**
 * Resolves the repo of a canonical URL (or, with `r.laneId`, of a lane
 * remote) and decides access for `service`. A redirected path gets 301 to
 * the same URL under the new path (the client follows the initial
 * redirect), but only for a caller the target would admit: anyone else gets
 * the answer of a missing repo, so the new path of a moved private repo
 * never leaks. Lane remotes answer every anonymous request 401 first and
 * have no public view; whether the lane itself exists is decided by the
 * lane handlers (RepoDO).
 */
export const resolveAccess = async (
	tree: GatewayTree,
	r: GitRequest,
	service: GitService,
): Promise<AccessResult> => {
	const { auth } = r;
	const lane = r.laneId;
	if ((service === "git-receive-pack" || lane !== undefined) && auth === null) {
		return respond(unauthorized());
	}
	const resolved = await tree.resolvePath(r.repoPath);
	if (
		resolved === null || resolved.rest !== "" || resolved.node.kind !== "repo"
	) {
		return lane === undefined ? missing(auth) : respond(laneNotFound());
	}
	const decision = lane === undefined
		? await decide(tree, auth, resolved.node, service)
		: await decideLane(
			tree,
			auth as AuthContext,
			resolved.node,
			service,
			lane,
		);
	if (resolved.redirectTo === undefined) return decision;
	if (decision.kind !== "ok") {
		return lane === undefined ? missing(auth) : respond(laneNotFound());
	}
	const tail = r.url.pathname.slice(1 + r.repoPath.length);
	return respond(
		new Response(null, {
			status: 301,
			headers: {
				location: `/${resolved.redirectTo}${tail}${r.url.search}`,
				"cache-control": "no-store",
			},
		}),
	);
};
