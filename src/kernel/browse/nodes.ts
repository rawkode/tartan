// The hierarchy API (WP3):
//
//   GET    /-/api/nodes?parent=<path>&cursor=   children the caller may see (roots without `parent`)
//   GET    /-/api/nodes/resolve?path=<path>      one node (301 when it moved)
//   POST   /-/api/nodes                          a group (`NodeCreateRequestSchema`; a root group: admins)
//   POST   /-/api/nodes/repos                    a repo: create, URL import or Owner import mode
//   POST   /-/api/nodes/move                     move or rename (`NodeMoveRequestSchema`)
//   POST   /-/api/nodes/archive                  archive (`{node}`)
//   GET    /-/api/nodes/grants?node=<path>       grants stored at the node
//   POST   /-/api/nodes/grants                   grant (`GrantRequestSchema`; Owner)
//   DELETE /-/api/nodes/grants?node=&principal=  revoke (Owner)
//   GET    /-/api/nodes/protected-refs?node=     protected-ref patterns in force
//
// Every action runs `authorize` (or the Maintainer check for creating
// nodes) with the caller's credential bounds before the tree facade, which
// re-checks the principal's grants. Agents never move, archive or grant.

import {
	denied,
	type GrantDto,
	GrantRequestSchema,
	type GrantsResponse,
	isWithinPath,
	NodeCreateRequestSchema,
	type NodeDto,
	NodeMoveRequestSchema,
	NodePathSchema,
	type NodeResolveResponse,
	type NodesResponse,
	notFound,
	RepoCreateRequestSchema,
	ROLE,
	tartanError,
} from "@tartan/contract";
import type { AuthContext, GrantRow } from "@tartan/contract/kernel.ts";
import { z } from "zod";
import type { RouteContext, RouteHandler } from "../../router.ts";
import {
	type AccessFacts,
	accessFacts,
	decide,
	decideRole,
} from "../tree/authz.ts";
import { lookupNode } from "./access.ts";
import { type BrowseDeps, browseDepsOf, type BrowseTree } from "./deps.ts";
import {
	failure,
	json,
	movedParam,
	noContent,
	optionalParam,
	param,
	readJson,
	requireAuth,
} from "./http.ts";
import type { BrowseDepsFor } from "./repo.ts";

const ArchiveRequestSchema = z.strictObject({ node: NodePathSchema });

const grantDto = (row: GrantRow): GrantDto => ({
	principal: row.principal_id,
	role: row.role,
	grantedBy: row.granted_by,
	expiresAt: row.expires_at,
	createdAt: row.created_at,
});

const refuseAgent = (auth: AuthContext, what: string): void => {
	if (auth.kind !== "user") throw denied("role", `agents cannot ${what}`);
};

/** Creating a node needs Maintainer+ at the parent and a write scope. */
const CREATE = {
	min: ROLE.maintainer,
	scopes: ["repo:write"] as const,
	what: "create nodes here",
};

/** Listing a node's grants needs a member's Reporter (never the public view). */
const MEMBERS = {
	min: ROLE.reporter,
	scopes: ["repo:read", "repo:write"] as const,
	what: "list grants",
};

/** A node by exact path for a write: a moved path resolves to the moved node (no 301 for a POST). */
const target = async (
	tree: BrowseTree,
	auth: AuthContext,
	path: string,
): Promise<{ node: NodeDto; facts: AccessFacts }> => {
	const found = await lookupNode(tree, auth, path);
	if (found.kind === "node") return found;
	const moved = await lookupNode(tree, auth, found.to);
	if (moved.kind !== "node") throw notFound(`nothing at ${path}`);
	return moved;
};

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Children the caller may see: those it may `read-metadata` (grants,
 * visibility), plus, for navigation, those holding something it may see
 * below (a grant below, or a public/internal node below) and the ancestors
 * of a token's node.
 */
const listChildren = async (
	deps: BrowseDeps,
	c: RouteContext,
): Promise<Response> => {
	const tree = deps.tree();
	const auth = c.auth;
	const parentPath = optionalParam(c.url, "parent");
	const cursor = optionalParam(c.url, "cursor", 64);
	let parentId: string | null = null;
	/** A parent the caller may not see is listed only for navigation (else 404). */
	let parentVisible = true;
	if (parentPath !== undefined) {
		const resolved = await tree.resolvePath(parentPath);
		if (resolved === null || resolved.rest !== "") {
			throw notFound(`nothing at ${parentPath}`);
		}
		if (resolved.redirectTo !== undefined) {
			return movedParam(c.url, "parent", resolved.redirectTo);
		}
		parentId = resolved.node.id;
		try {
			decide(
				auth,
				resolved.node,
				await accessFacts(tree, auth, resolved.node),
				"read-metadata",
			);
		} catch {
			parentVisible = false;
		}
	}
	const principals = auth === null
		? []
		: auth.onBehalfOf
		? [auth.principal, auth.onBehalfOf]
		: [auth.principal];
	const scopeNode = auth !== null && auth.via !== "session" &&
			auth.nodeId !== null
		? await tree.node(auth.nodeId)
		: null;
	const page = await tree.childrenAccess(parentId, principals, cursor);
	const nodes = page.nodes.filter((child) => {
		const inScope = scopeNode === null ||
			isWithinPath(scopeNode.path, child.node.path);
		const towardScope = scopeNode !== null &&
			isWithinPath(child.node.path, scopeNode.path);
		const facts: AccessFacts = {
			granted: child.granted,
			withinTokenNode: inScope,
		};
		try {
			decide(auth, child.node, facts, "read-metadata");
			return true;
		} catch {
			if (towardScope) return true;
			if (!inScope) return child.openBelow === "public";
			return (auth !== null && child.below) ||
				child.openBelow === "public" ||
				(auth !== null && child.openBelow === "internal");
		}
	}).map((child) => child.node);
	if (!parentVisible && nodes.length === 0 && page.cursor === undefined) {
		throw notFound(`nothing at ${parentPath}`);
	}
	return json(
		{
			nodes,
			...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
		} satisfies NodesResponse,
	);
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const createNodesHandler = (
	depsFor: BrowseDepsFor = (c) => browseDepsOf(c.env, c.ctx),
): RouteHandler =>
async (c) => {
	try {
		const deps = depsFor(c);
		const tree = deps.tree();
		const rest = c.params.rest ?? "";
		const method = c.req.method;

		if (rest === "" && method === "GET") return await listChildren(deps, c);

		if (rest === "resolve" && method === "GET") {
			const found = await lookupNode(tree, c.auth, param(c.url, "path"));
			if (found.kind === "moved") return movedParam(c.url, "path", found.to);
			return json({ node: found.node } satisfies NodeResolveResponse);
		}

		if (rest === "" && method === "POST") {
			const auth = requireAuth(c.auth);
			const body = await readJson(c.req, NodeCreateRequestSchema);
			if (body.parent === undefined) {
				if (auth.kind !== "user" || !auth.isAdmin) {
					throw denied("role", "root groups are created by admins");
				}
				const root = await tree.createRootNode({
					kind: "group",
					slug: body.slug,
					owner: auth.principal,
					...(body.visibility ? { visibility: body.visibility } : {}),
					...(body.description !== undefined
						? { description: body.description }
						: {}),
				});
				return json(root, 201);
			}
			const parent = await target(tree, auth, body.parent);
			decideRole(auth, parent.node, parent.facts, CREATE);
			const node = await tree.createNode(auth.principal, {
				parentId: parent.node.id,
				kind: "group",
				slug: body.slug,
				...(body.visibility ? { visibility: body.visibility } : {}),
				...(body.description !== undefined
					? { description: body.description }
					: {}),
			});
			return json(node, 201);
		}

		if (rest === "repos" && method === "POST") {
			const auth = requireAuth(c.auth);
			const body = await readJson(c.req, RepoCreateRequestSchema);
			if (body.sample) {
				throw tartanError(
					"invalid",
					"the bundled sample monorepo is not available on this forge yet",
					{ reason: "sample" },
				);
			}
			const parent = await target(tree, auth, body.parent);
			decideRole(auth, parent.node, parent.facts, CREATE);
			const common = {
				parentId: parent.node.id,
				slug: body.slug,
				...(body.visibility ? { visibility: body.visibility } : {}),
				...(body.description !== undefined
					? { description: body.description }
					: {}),
			};
			if (body.import !== undefined) {
				if ("mode" in body.import) {
					refuseAgent(auth, "use import mode");
				}
				return json(
					await tree.importRepo(auth.principal, {
						...common,
						import: body.import,
					}),
					201,
				);
			}
			return json(
				await tree.createRepo(auth.principal, {
					...common,
					...(body.defaultBranch !== undefined
						? { defaultBranch: body.defaultBranch }
						: {}),
				}),
				201,
			);
		}

		if (rest === "move" && method === "POST") {
			const auth = requireAuth(c.auth);
			refuseAgent(auth, "move nodes");
			const body = await readJson(c.req, NodeMoveRequestSchema);
			const node = await target(tree, auth, body.node);
			decide(auth, node.node, node.facts, "delete");
			let parentId: string | undefined;
			if (body.parent !== undefined) {
				const parent = await target(tree, auth, body.parent);
				decideRole(auth, parent.node, parent.facts, CREATE);
				parentId = parent.node.id;
			}
			return json(
				await tree.moveNode(auth.principal, node.node.id, {
					...(parentId !== undefined ? { parentId } : {}),
					...(body.slug !== undefined ? { slug: body.slug } : {}),
				}),
			);
		}

		if (rest === "archive" && method === "POST") {
			const auth = requireAuth(c.auth);
			refuseAgent(auth, "archive nodes");
			const body = await readJson(c.req, ArchiveRequestSchema);
			const node = await target(tree, auth, body.node);
			decide(auth, node.node, node.facts, "delete");
			await tree.archiveNode(auth.principal, node.node.id);
			return noContent();
		}

		if (rest === "grants") {
			if (method === "GET") {
				const found = await lookupNode(tree, c.auth, param(c.url, "node"));
				if (found.kind === "moved") return movedParam(c.url, "node", found.to);
				// Membership is for members: the public view never lists it.
				decideRole(c.auth, found.node, found.facts, MEMBERS);
				return json(
					{
						node: found.node.path,
						grants: (await tree.grants(found.node.id)).map(grantDto),
					} satisfies GrantsResponse,
				);
			}
			const auth = requireAuth(c.auth);
			refuseAgent(auth, "change grants");
			if (method === "POST") {
				const body = await readJson(c.req, GrantRequestSchema);
				const node = await target(tree, auth, body.node);
				decide(auth, node.node, node.facts, "grant");
				await tree.grant(
					auth.principal,
					node.node.id,
					body.principal,
					body.role,
					body.expiresAt,
				);
				return noContent();
			}
			if (method === "DELETE") {
				const node = await target(tree, auth, param(c.url, "node"));
				const principal = param(c.url, "principal", 64);
				decide(auth, node.node, node.facts, "grant");
				await tree.revoke(auth.principal, node.node.id, principal);
				return noContent();
			}
		}

		if (rest === "protected-refs" && method === "GET") {
			const found = await lookupNode(tree, c.auth, param(c.url, "node"));
			if (found.kind === "moved") return movedParam(c.url, "node", found.to);
			decide(c.auth, found.node, found.facts, "read");
			return json({ patterns: await tree.protectedRefs(found.node.id) });
		}

		throw notFound("no such nodes endpoint");
	} catch (error) {
		return failure(error);
	}
};
