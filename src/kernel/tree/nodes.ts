// The hierarchy (WP3): roots (users and groups share one
// root slug space), nested groups to any depth, path resolution with
// redirects, children pages, moves and renames (one `transactionSync` that
// rewrites the range-scanned subtree and records a redirect), archiving, and
// the reads of grants and protected-ref patterns. Repos are created by
// `repos.ts` on top of `insertNodeSync`.
//
// Every write checks the acting principal's grants role (defence in depth:
// the HTTP routes already ran `authorize` with the caller's credential
// bounds) and appends one forge event plus an audit row in its transaction.

import {
	denied,
	type EffectiveRole,
	invalid,
	isIdOf,
	isWithinPath,
	type NodeDto,
	notFound,
	principalKind,
	ROLE,
	SYS_KERNEL,
	tartanError,
	trunkRef,
	type Visibility,
	VisibilitySchema,
} from "@tartan/contract";
import type { NodeRow, ResolvedPath } from "@tartan/contract/kernel.ts";
import { appendForge, audit, type TreeContext } from "./context.ts";
import {
	ancestorPaths,
	checkSlug,
	childPath,
	isNodePath,
	rebase,
	splitNodePath,
} from "./paths.ts";
import {
	bumpVersion,
	deepestNode,
	first,
	jsonList,
	longestRedirect,
	nodeById,
	nodeByPath,
	nodeDto,
	rows,
	subtreeSize,
} from "./store.ts";

/** A subtree larger than this is not moved in one transaction. */
export const MOVE_SYNC_MAX = 5_000;
/** Children per page. */
export const CHILDREN_PAGE = 100;
/** `description` limit (as `NodeCreateRequestSchema`). */
export const DESCRIPTION_MAX = 500;
/** Redirect hops `resolvePath` follows. */
const REDIRECT_HOPS = 4;

export const requireNode = (c: TreeContext, id: string): NodeRow => {
	const node = nodeById(c.sql, id);
	if (node === null) throw notFound(`no node ${id}`);
	return node;
};

/** The grants role of `by` at `node` (the kernel: Owner). */
export const roleOf = (
	c: TreeContext,
	by: string,
	node: NodeRow,
): EffectiveRole =>
	by === SYS_KERNEL
		? ROLE.owner
		: c.roles.atPath([by], node.path, c.clock.now());

export const requireRole = (
	c: TreeContext,
	by: string,
	node: NodeRow,
	min: number,
	what: string,
): void => {
	if (roleOf(c, by, node) < min) {
		throw denied("role", `${what} needs a higher role at ${node.path}`);
	}
};

/** Agents never change the hierarchy's grants or shape above repo content. */
export const refuseAgent = (by: string, what: string): void => {
	if (principalKind(by) === "agent") {
		throw denied("role", `agents cannot ${what}`);
	}
};

export const checkVisibility = (value: unknown): Visibility => {
	if (value === undefined) return "private";
	const parsed = VisibilitySchema.safeParse(value);
	if (!parsed.success) {
		throw invalid("visibility is private, internal or public");
	}
	return parsed.data;
};

export const checkDescription = (value: unknown): string | null => {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length > DESCRIPTION_MAX) {
		throw invalid(`a description is at most ${DESCRIPTION_MAX} characters`);
	}
	return value;
};

/** Redirects whose old path a new node now occupies (or lies below) stop applying. */
const dropClaimedRedirects = (c: TreeContext, path: string): void => {
	c.sql.exec(
		"DELETE FROM redirects WHERE old_path = ?1 OR (old_path > ?1 || '/' AND old_path < ?1 || '0')",
		path,
	);
};

export type NewNode = {
	readonly id: string;
	readonly parent: NodeRow | null;
	readonly kind: NodeRow["kind"];
	readonly slug: string;
	readonly visibility: Visibility;
	readonly description: string | null;
	readonly artifactsName: string | null;
	readonly defaultBranch: string | null;
	readonly by: string;
};

/**
 * Inserts one node (inside the caller's transaction). The path must be free:
 * `UNIQUE(path)` also refuses a race, as `conflict`.
 */
export const insertNodeSync = (c: TreeContext, n: NewNode): NodeRow => {
	const path = childPath(n.parent?.path ?? null, n.slug);
	if (!isNodePath(path)) throw invalid("the node path is too long");
	if (nodeByPath(c.sql, path) !== null) {
		throw tartanError("conflict", `${path} already exists`, {
			reason: "path-taken",
		});
	}
	const row: NodeRow = {
		id: n.id,
		parent_id: n.parent?.id ?? null,
		kind: n.kind,
		slug: n.slug,
		path,
		depth: n.parent === null ? 0 : n.parent.depth + 1,
		visibility: n.visibility,
		artifacts_name: n.artifactsName,
		default_branch: n.defaultBranch,
		description: n.description,
		created_by: n.by,
		created_at: c.clock.now(),
		archived_at: null,
	};
	c.sql.exec(
		`INSERT INTO nodes (id, parent_id, kind, slug, path, depth, visibility, artifacts_name,
		   default_branch, description, created_by, created_at, archived_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		row.id,
		row.parent_id,
		row.kind,
		row.slug,
		row.path,
		row.depth,
		row.visibility,
		row.artifacts_name,
		row.default_branch,
		row.description,
		row.created_by,
		row.created_at,
	);
	dropClaimedRedirects(c, path);
	bumpVersion(c.sql, "hierarchy_version");
	return row;
};

export const nodeEventData = (node: NodeRow, oldPath?: string) => ({
	nodeId: node.id,
	kind: node.kind,
	path: node.path,
	...(oldPath !== undefined ? { oldPath } : {}),
});

// ---------------------------------------------------------------------------
// Roots and groups
// ---------------------------------------------------------------------------

export type RootInput = {
	readonly kind: "user" | "group";
	readonly slug: string;
	readonly owner: string;
	readonly visibility?: Visibility;
	readonly description?: string;
};

/**
 * A root namespace with its owner's stored Owner grant (inside the caller's
 * transaction, so WP2's claim can be one transaction with it). Idempotent
 * for the same kind and owner; any other node at that slug is `conflict`
 * (`UNIQUE(path)` dedupes roots).
 */
export const createRootSync = (c: TreeContext, input: RootInput): NodeRow => {
	if (input.kind !== "user" && input.kind !== "group") {
		throw invalid("a root is a user or a group");
	}
	const slug = checkSlug(input.slug, { root: true });
	if (!isIdOf("user", input.owner)) {
		throw invalid("a root's owner is a user principal");
	}
	// The identity module owns principal existence (WP2 creates the owner
	// right before its root); a disabled user gets no new namespace.
	const owner = c.identity().principalSync(input.owner);
	if (owner !== null && owner.disabled_at !== null) {
		throw notFound(`no active user ${input.owner}`);
	}
	const existing = nodeByPath(c.sql, slug);
	if (existing !== null) {
		const ownerGrant = first<{ role: number }>(
			c.sql,
			"SELECT role FROM grants WHERE node_id = ? AND principal_id = ?",
			existing.id,
			input.owner,
		);
		if (existing.kind === input.kind && ownerGrant?.role === ROLE.owner) {
			return existing;
		}
		throw tartanError("conflict", `${slug} is already taken`, {
			reason: "path-taken",
		});
	}
	const row = insertNodeSync(c, {
		id: c.ids.ulid(),
		parent: null,
		kind: input.kind,
		slug,
		visibility: checkVisibility(input.visibility),
		description: checkDescription(input.description),
		artifactsName: null,
		defaultBranch: null,
		by: input.owner,
	});
	upsertGrant(c, row, input.owner, ROLE.owner, null, input.owner);
	appendForge(c, {
		type: "node.created",
		by: input.owner,
		node: row.id,
		data: nodeEventData(row),
	});
	audit(c, {
		principal: input.owner,
		action: "node.create",
		target: row.path,
		data: { nodeId: row.id, kind: row.kind },
	});
	return row;
};

export type GroupInput = {
	readonly parentId: string;
	readonly kind: "group";
	readonly slug: string;
	readonly visibility?: Visibility;
	readonly description?: string;
};

/** A group below `parentId`: Maintainer+ at the parent. */
export const createGroupSync = (
	c: TreeContext,
	by: string,
	input: GroupInput,
): NodeRow => {
	if (input.kind !== "group") throw invalid("createNode creates groups");
	const parent = requireNode(c, input.parentId);
	if (parent.kind === "repo") throw invalid("a repo has no child nodes");
	const slug = checkSlug(input.slug, { root: false });
	requireRole(c, by, parent, ROLE.maintainer, "creating a group");
	const row = insertNodeSync(c, {
		id: c.ids.ulid(),
		parent,
		kind: "group",
		slug,
		visibility: checkVisibility(input.visibility),
		description: checkDescription(input.description),
		artifactsName: null,
		defaultBranch: null,
		by,
	});
	appendForge(c, {
		type: "node.created",
		by,
		node: row.id,
		data: nodeEventData(row),
	});
	audit(c, {
		principal: by,
		action: "node.create",
		target: row.path,
		data: { nodeId: row.id, kind: row.kind },
	});
	return row;
};

// ---------------------------------------------------------------------------
// Resolution and listing
// ---------------------------------------------------------------------------

const joinRest = (...parts: readonly string[]): string =>
	parts.filter((p) => p !== "").join("/");

/**
 * The longest existing node prefix of `path` (after splitting on `/-/` and
 * dropping `.git`), then redirects: a redirect longer than the node match
 * wins and resolves to the moved node's current path (`redirectTo`, the new
 * full path, for a 301).
 */
export const resolvePathSync = (
	c: TreeContext,
	path: string,
): ResolvedPath | null => {
	const { nodePath, rest } = splitNodePath(path);
	let current = nodePath;
	let redirected = false;
	for (let hop = 0; hop <= REDIRECT_HOPS; hop++) {
		if (!isNodePath(current)) return null;
		const prefixes = ancestorPaths(current);
		const node = deepestNode(c.sql, prefixes);
		const redirect = longestRedirect(c.sql, prefixes);
		if (
			redirect !== null &&
			(node === null || redirect.old_path.length > node.path.length)
		) {
			const target = nodeById(c.sql, redirect.node_id);
			if (target !== null && hop < REDIRECT_HOPS) {
				current = rebase(current, redirect.old_path, target.path);
				redirected = true;
				continue;
			}
		}
		if (node === null) return null;
		const remainder = current.slice(node.path.length).replace(/^\//, "");
		return {
			node: nodeDto(node),
			rest: joinRest(remainder, rest),
			...(redirected ? { redirectTo: joinRest(current, rest) } : {}),
		};
	}
	return null;
};

/** One page of children by slug (`nodeId` null: the roots). */
export const childrenSync = (
	c: TreeContext,
	nodeId: string | null,
	cursor?: string,
	limit = CHILDREN_PAGE,
): { nodes: NodeRow[]; cursor?: string } => {
	const size = Math.min(Math.max(1, Math.floor(limit)), CHILDREN_PAGE);
	const after = cursor ?? "";
	const page = nodeId === null
		? rows<NodeRow>(
			c.sql,
			"SELECT * FROM nodes WHERE parent_id IS NULL AND slug > ? ORDER BY slug LIMIT ?",
			after,
			size + 1,
		)
		: rows<NodeRow>(
			c.sql,
			"SELECT * FROM nodes WHERE parent_id = ? AND slug > ? ORDER BY slug LIMIT ?",
			nodeId,
			after,
			size + 1,
		);
	const nodes = page.slice(0, size);
	return page.length > size
		? { nodes, cursor: nodes[nodes.length - 1].slug }
		: { nodes };
};

// ---------------------------------------------------------------------------
// Moves, renames, archiving
// ---------------------------------------------------------------------------

export type MoveResult = {
	readonly node: NodeRow;
	readonly oldPath: string;
	/** Repos of the moved subtree (their RepoDO path caches are refreshed). */
	readonly repos: readonly NodeRow[];
};

/**
 * Moves and/or renames a node: Owner at the node, Maintainer+ at a new
 * parent. One transaction rewrites `path` and `depth` of the range-scanned
 * subtree, records `old path → node` (a 301 for every old path below it),
 * bumps both versions ⇒ `node.moved`. Users stay roots; nothing moves into
 * its own subtree or under a repo.
 */
export const moveNodeSync = (
	c: TreeContext,
	by: string,
	nodeId: string,
	to: { readonly parentId?: string; readonly slug?: string },
): MoveResult | { readonly node: NodeRow; readonly unchanged: true } => {
	refuseAgent(by, "move nodes");
	const node = requireNode(c, nodeId);
	if (to.parentId === undefined && to.slug === undefined) {
		throw invalid("a move needs a new parent or a new slug");
	}
	if (to.parentId !== undefined && node.kind === "user") {
		throw invalid("a user namespace stays at the root");
	}
	const parent = to.parentId !== undefined
		? requireNode(c, to.parentId)
		: node.parent_id === null
		? null
		: requireNode(c, node.parent_id);
	if (parent?.kind === "repo") throw invalid("a repo has no child nodes");
	if (parent !== null && isWithinPath(node.path, parent.path)) {
		throw invalid("a node cannot move into its own subtree");
	}
	const slug = checkSlug(to.slug ?? node.slug, { root: parent === null });
	const newPath = childPath(parent?.path ?? null, slug);
	if (newPath === node.path) return { node, unchanged: true };
	if (!isNodePath(newPath)) throw invalid("the node path is too long");
	requireRole(c, by, node, ROLE.owner, "moving or renaming a node");
	if (parent !== null && parent.id !== node.parent_id) {
		requireRole(c, by, parent, ROLE.maintainer, "moving a node here");
	}
	if (nodeByPath(c.sql, newPath) !== null) {
		throw tartanError("conflict", `${newPath} already exists`, {
			reason: "path-taken",
		});
	}
	if (subtreeSize(c.sql, node.path) > MOVE_SYNC_MAX) {
		throw tartanError(
			"conflict",
			`subtrees of more than ${MOVE_SYNC_MAX} nodes move in chunks, which this forge does not do yet`,
			{ reason: "subtree-too-large" },
		);
	}
	const oldPath = node.path;
	const depthDelta = (parent === null ? 0 : parent.depth + 1) - node.depth;
	c.sql.exec(
		`UPDATE nodes SET path = ?2 || substr(path, length(?1) + 1), depth = depth + ?3
		 WHERE path = ?1 OR (path > ?1 || '/' AND path < ?1 || '0')`,
		oldPath,
		newPath,
		depthDelta,
	);
	c.sql.exec(
		"UPDATE nodes SET parent_id = ?, slug = ? WHERE id = ?",
		parent?.id ?? null,
		slug,
		node.id,
	);
	dropClaimedRedirects(c, newPath);
	c.sql.exec(
		`INSERT INTO redirects (old_path, node_id, created_at) VALUES (?, ?, ?)
		 ON CONFLICT(old_path) DO UPDATE SET node_id = excluded.node_id, created_at = excluded.created_at`,
		oldPath,
		node.id,
		c.clock.now(),
	);
	bumpVersion(c.sql, "hierarchy_version");
	bumpVersion(c.sql, "authz_version");
	const moved = requireNode(c, node.id);
	appendForge(c, {
		type: "node.moved",
		by,
		node: moved.id,
		data: nodeEventData(moved, oldPath),
	});
	audit(c, {
		principal: by,
		action: "node.move",
		target: moved.path,
		data: { nodeId: moved.id, from: oldPath, to: moved.path },
	});
	const repos = rows<NodeRow>(
		c.sql,
		`SELECT n.* FROM nodes n JOIN artifacts_index a ON a.name = n.artifacts_name
		 WHERE n.kind = 'repo' AND a.state = 'live'
		   AND (n.path = ?1 OR (n.path > ?1 || '/' AND n.path < ?1 || '0'))
		 ORDER BY n.path`,
		moved.path,
	);
	return { node: moved, oldPath, repos };
};

/** Marks a node archived (Owner) ⇒ `node.archived`; idempotent. */
export const archiveNodeSync = (
	c: TreeContext,
	by: string,
	nodeId: string,
): void => {
	refuseAgent(by, "archive nodes");
	const node = requireNode(c, nodeId);
	requireRole(c, by, node, ROLE.owner, "archiving a node");
	if (node.archived_at !== null) return;
	c.sql.exec(
		"UPDATE nodes SET archived_at = ? WHERE id = ?",
		c.clock.now(),
		node.id,
	);
	bumpVersion(c.sql, "hierarchy_version");
	appendForge(c, {
		type: "node.archived",
		by,
		node: node.id,
		data: nodeEventData(node),
	});
	audit(c, {
		principal: by,
		action: "node.archive",
		target: node.path,
		data: { nodeId: node.id },
	});
};

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const upsertGrant = (
	c: TreeContext,
	node: NodeRow,
	principal: string,
	role: number,
	expiresAt: number | null,
	by: string,
): void => {
	c.sql.exec(
		`INSERT INTO grants (node_id, principal_id, role, granted_by, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(node_id, principal_id) DO UPDATE SET role = excluded.role,
		   granted_by = excluded.granted_by, expires_at = excluded.expires_at`,
		node.id,
		principal,
		role,
		by,
		expiresAt,
		c.clock.now(),
	);
	bumpVersion(c.sql, "authz_version");
};

const STORED_ROLES = new Set<number>([10, 20, 30, 40, 50]);

/**
 * Stores a grant (inside the caller's transaction). `by` needs Maintainer+
 * at the node and at least the role it grants (so invites from a Maintainer
 * work, and only an Owner grants Owner); the HTTP route itself requires
 * Owner. Agents never grant. Effective roles stay raise-only: a grant below
 * an inherited role changes nothing until the inherited one goes.
 */
export const grantSync = (
	c: TreeContext,
	by: string,
	nodeId: string,
	principal: string,
	role: number,
	expiresAt?: number,
): void => {
	refuseAgent(by, "change grants");
	const node = requireNode(c, nodeId);
	if (!STORED_ROLES.has(role)) throw invalid(`invalid role ${role}`);
	const kind = principalKind(principal);
	if (kind === null || kind === "system") {
		throw invalid(`cannot grant to ${principal}`);
	}
	if (kind === "user" || kind === "agent") {
		const row = c.identity().principalSync(principal);
		if (row === null || row.disabled_at !== null) {
			throw notFound(`no active principal ${principal}`);
		}
	}
	const now = c.clock.now();
	if (
		expiresAt !== undefined &&
		(!Number.isSafeInteger(expiresAt) || expiresAt <= now)
	) {
		throw invalid("a grant expires in the future");
	}
	requireRole(c, by, node, Math.max(ROLE.maintainer, role), "this grant");
	upsertGrant(c, node, principal, role, expiresAt ?? null, by);
	audit(c, {
		principal: by,
		action: "grant",
		target: node.path,
		data: { nodeId: node.id, principal, role, expiresAt: expiresAt ?? null },
	});
};

export const revokeSync = (
	c: TreeContext,
	by: string,
	nodeId: string,
	principal: string,
): void => {
	refuseAgent(by, "change grants");
	const node = requireNode(c, nodeId);
	const existing = first<{ role: number }>(
		c.sql,
		"SELECT role FROM grants WHERE node_id = ? AND principal_id = ?",
		node.id,
		principal,
	);
	if (existing === null) return;
	requireRole(
		c,
		by,
		node,
		Math.max(ROLE.maintainer, existing.role),
		"revoking this grant",
	);
	c.sql.exec(
		"DELETE FROM grants WHERE node_id = ? AND principal_id = ?",
		node.id,
		principal,
	);
	bumpVersion(c.sql, "authz_version");
	audit(c, {
		principal: by,
		action: "revoke",
		target: node.path,
		data: { nodeId: node.id, principal, role: existing.role },
	});
};

/**
 * Protected-ref patterns in force at a node: its own and its ancestors'
 * (inherited, monotonic), plus a repo's default branch, always.
 */
export const protectedRefsSync = (c: TreeContext, nodeId: string): string[] => {
	const node = requireNode(c, nodeId);
	const stored = rows<{ pattern: string }>(
		c.sql,
		`SELECT DISTINCT p.pattern FROM protected_refs p JOIN nodes n ON n.id = p.node_id
		 WHERE n.path IN (SELECT value FROM json_each(?)) ORDER BY p.pattern`,
		jsonList(ancestorPaths(node.path)),
	).map((r) => r.pattern);
	const own = node.kind === "repo"
		? [trunkRef(node.default_branch ?? "main")]
		: [];
	return [...new Set([...own, ...stored])];
};

/**
 * Every live repo by path (crons; `cursor` is the last path of the page).
 * `archived: false` leaves out archived repos and those below an archived
 * node, so a forge's per-tick sweeps do not grow with its archive.
 */
export const listReposSync = (
	c: TreeContext,
	options: {
		readonly cursor?: string;
		readonly limit?: number;
		readonly archived?: boolean;
	} = {},
): { repos: { id: string; path: string }[]; cursor?: string } => {
	const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1000);
	const page = rows<{ id: string; path: string }>(
		c.sql,
		`SELECT n.id AS id, n.path AS path FROM nodes n JOIN artifacts_index a ON a.name = n.artifacts_name
		 WHERE n.kind = 'repo' AND a.state = 'live' AND n.path > ?
		   AND (? = 1 OR NOT EXISTS (
		     SELECT 1 FROM nodes g WHERE g.archived_at IS NOT NULL
		       AND (g.path = n.path OR substr(n.path, 1, length(g.path) + 1) = g.path || '/')))
		 ORDER BY n.path LIMIT ?`,
		options.cursor ?? "",
		options.archived === false ? 0 : 1,
		limit + 1,
	);
	const repos = page.slice(0, limit);
	return page.length > limit
		? { repos, cursor: repos[repos.length - 1].path }
		: { repos };
};

export const dtoOf = (row: NodeRow): NodeDto => nodeDto(row);
