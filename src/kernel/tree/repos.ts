// Repo create and import (WP3; K11, [E A2]): the node and
// `artifacts_index(pending)` first (one transaction, so `UNIQUE(path)` and slug
// validation refuse a duplicate or a case variant before any Artifacts call),
// then `ARTIFACTS.create` or `.import` of `r-<repoUlid>` (lowercase), RepoDO
// `init`, and
//   - created: the genesis commit on the default branch;
//   - imported from a public URL: import mode at once ended by WP5a's
//     `importComplete` (refs from the advertisement, `trunk_commits` from the
//     first-parent chain, protection on);
//   - Owner import mode (`{mode: "push"}`): `import_state='importing'`, no
//     genesis; the Owner pushes history and calls `import-complete`.
// The last transaction marks the index row `live` ⇒ `node.created` +
// `repo.created`/`repo.imported` on the forge stream (RepoDO appends its own).
//
// A failure after the first transaction rolls back (the Artifacts repo is
// deleted, the node removed, the index row `deleted`). A ForgeDO restart in
// between leaves the `pending` row and its `tree` timer, which rolls it back
// after `CREATE_GRACE_MS` unless that create is still running here.
//
// The token `create`/`import` return is discarded unread (K11, U53).

import {
	denied,
	invalid,
	isValidRefName,
	type NodeDto,
	repoArtifactsName,
	type RepoImportSource,
	ROLE,
	SYS_KERNEL,
	tartanError,
	trunkRef,
	type Visibility,
} from "@tartan/contract";
import type { NodeRow } from "@tartan/contract/kernel.ts";
import { indexArtifactsSync } from "./artifacts.ts";
import { appendForge, audit, errorText, type TreeContext } from "./context.ts";
import {
	checkDescription,
	checkVisibility,
	insertNodeSync,
	nodeEventData,
	requireNode,
	requireRole,
} from "./nodes.ts";
import { checkSlug } from "./paths.ts";
import { indexRow, nodeById, nodeDto } from "./store.ts";

/** A `pending` create older than this, and not running here, is rolled back. */
export const CREATE_GRACE_MS = 15 * 60_000;
export const CREATE_TIMER_PREFIX = "tree:create:";
export const GENESIS_AUTHOR = {
	name: "Tartan",
	email: "kernel@tartan.invalid",
} as const;
export const GENESIS_MESSAGE = "Initial commit";

export type CreateRepoInput = {
	readonly parentId: string;
	readonly slug: string;
	readonly visibility?: Visibility;
	readonly description?: string;
	readonly defaultBranch?: string;
};

export type ImportRepoInput = {
	readonly parentId: string;
	readonly slug: string;
	readonly import: RepoImportSource;
	readonly visibility?: Visibility;
	readonly description?: string;
};

const BRANCH_MAX = 200;

/** A short branch name (`main`, `release/1.x`), never a full refname. */
export const checkBranch = (value: unknown): string => {
	if (value === undefined) return "main";
	if (
		typeof value !== "string" || value.length === 0 ||
		value.length > BRANCH_MAX || value.startsWith("refs/") ||
		!isValidRefName(trunkRef(value))
	) {
		throw tartanError("invalid", `invalid default branch: ${String(value)}`, {
			reason: "branch",
		});
	}
	return value;
};

/**
 * An import source URL: https (the schema checks it), no credentials, never
 * a capability path of this or any forge (K11).
 */
export const checkImportUrl = (raw: string): URL => {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw tartanError("invalid", "the import URL is not a URL", {
			reason: "import-url",
		});
	}
	if (url.protocol !== "https:") {
		throw tartanError("invalid", "imports are from https URLs", {
			reason: "import-url",
		});
	}
	if (url.username !== "" || url.password !== "") {
		throw tartanError("invalid", "an import URL carries no credentials", {
			reason: "import-url",
		});
	}
	if (url.pathname.includes("/-/cap/")) {
		throw tartanError("invalid", "a capability URL is not an import source", {
			reason: "import-url",
		});
	}
	return url;
};

/**
 * The URL `import()` pulls and `repo.imported.source` records: origin and
 * path only (no query, fragment or userinfo).
 */
export const redactedSource = (url: URL): string =>
	`${url.origin}${url.pathname}`;

const createTimerKey = (repoId: string): string =>
	`${CREATE_TIMER_PREFIX}${repoId}`;

export type RepoCreation = {
	createRepo(by: string, input: CreateRepoInput): Promise<NodeDto>;
	importRepo(by: string, input: ImportRepoInput): Promise<NodeDto>;
	/** After WP5a's `importComplete` (the route): the node's default branch ⇒ forge `repo.imported`. */
	importCompleted(
		by: string,
		repoId: string,
		defaultBranch: string,
	): NodeDto;
	/** The `tree:create:<id>` timer: roll back a stale `pending` create. */
	onCreateTimer(key: string): Promise<void>;
};

export const createRepoCreation = (c: TreeContext): RepoCreation => {
	/** Creates running in this ForgeDO instance (the timer never rolls them back). */
	const running = new Set<string>();

	const begin = (
		by: string,
		input: {
			readonly parentId: string;
			readonly slug: string;
			readonly visibility?: Visibility;
			readonly description?: string;
			readonly defaultBranch: string;
		},
	): NodeRow =>
		c.tx(() => {
			const parent = requireNode(c, input.parentId);
			if (parent.kind === "repo") throw invalid("a repo has no child nodes");
			const slug = checkSlug(input.slug, { root: false });
			requireRole(c, by, parent, ROLE.maintainer, "creating a repo");
			const id = c.ids.ulid();
			const name = repoArtifactsName(id);
			const description = checkDescription(input.description);
			const node = insertNodeSync(c, {
				id,
				parent,
				kind: "repo",
				slug,
				visibility: checkVisibility(input.visibility),
				description,
				artifactsName: name,
				defaultBranch: input.defaultBranch,
				by,
			});
			const indexed = indexArtifactsSync(c, {
				name,
				kind: "repo",
				repoId: id,
				state: "pending",
			});
			if (!indexed.ok) throw invalid("the repo could not be indexed");
			c.timers.schedule(createTimerKey(id), c.clock.now() + CREATE_GRACE_MS);
			return node;
		});

	const finish = (
		by: string,
		repoId: string,
		event: "repo.created" | "repo.imported",
		source?: string,
	): NodeRow =>
		c.tx(() => {
			const node = requireNode(c, repoId);
			const name = node.artifacts_name as string;
			indexArtifactsSync(c, {
				name,
				kind: "repo",
				repoId,
				state: "live",
			});
			c.timers.cancel(createTimerKey(repoId));
			appendForge(c, {
				type: "node.created",
				by,
				node: node.id,
				data: nodeEventData(node),
			});
			appendForge(c, {
				type: event,
				by,
				node: node.id,
				data: {
					repoId,
					path: node.path,
					artifactsName: name,
					...(source !== undefined ? { source } : {}),
				},
			});
			audit(c, {
				principal: by,
				action: event === "repo.created" ? "repo.create" : "repo.import",
				target: node.path,
				data: {
					repoId,
					...(source !== undefined ? { source } : {}),
				},
			});
			return node;
		});

	/** Undo a create that did not finish: Artifacts repo, node, index row. */
	const rollback = async (
		repoId: string,
		name: string,
		cause: unknown,
	): Promise<void> => {
		try {
			await c.ports.artifacts.delete(name);
		} catch (error) {
			c.log("repo rollback: delete failed", {
				repoId,
				error: errorText(error),
			});
		}
		c.tx(() => {
			c.sql.exec("DELETE FROM grants WHERE node_id = ?", repoId);
			c.sql.exec("DELETE FROM protected_refs WHERE node_id = ?", repoId);
			c.sql.exec("DELETE FROM redirects WHERE node_id = ?", repoId);
			c.sql.exec(
				"DELETE FROM nodes WHERE id = ? AND kind = 'repo'",
				repoId,
			);
			indexArtifactsSync(c, {
				name,
				kind: "repo",
				repoId,
				state: "deleted",
			});
			c.timers.cancel(createTimerKey(repoId));
		});
		c.log("repo create rolled back", { repoId, error: errorText(cause) });
	};

	/** Runs `steps` after `begin`; rolls back on any failure. */
	const run = async (
		node: NodeRow,
		steps: () => Promise<{
			readonly event: "repo.created" | "repo.imported";
			readonly source?: string;
		}>,
		by: string,
	): Promise<NodeDto> => {
		const name = node.artifacts_name as string;
		running.add(node.id);
		try {
			const outcome = await steps();
			const done = finish(by, node.id, outcome.event, outcome.source);
			if (done.path !== node.path) refreshPath(done);
			return nodeDto(done);
		} catch (error) {
			await rollback(node.id, name, error);
			throw error;
		} finally {
			running.delete(node.id);
		}
	};

	/** A move during the create changed the path RepoDO cached at `init`. */
	const refreshPath = (node: NodeRow): void => {
		c.waitUntil(
			c.ports.repo(node.id).init({
				repoId: node.id,
				nodeId: node.id,
				path: node.path,
				defaultBranch: node.default_branch ?? "main",
			}).catch((error) =>
				c.log("repo path refresh failed", {
					repoId: node.id,
					error: errorText(error),
				})
			),
		);
	};

	const createRepo = async (
		by: string,
		input: CreateRepoInput,
	): Promise<NodeDto> => {
		const defaultBranch = checkBranch(input.defaultBranch);
		const node = begin(by, { ...input, defaultBranch });
		return await run(node, async () => {
			const name = node.artifacts_name as string;
			// The returned token is discarded unread (K11).
			await c.ports.artifacts.create(name, { setDefaultBranch: defaultBranch });
			await c.ports.repo(node.id).init({
				repoId: node.id,
				nodeId: node.id,
				path: node.path,
				defaultBranch,
			});
			await c.ports.genesis(node.id, {
				defaultBranch,
				message: GENESIS_MESSAGE,
				author: GENESIS_AUTHOR,
				title: node.slug,
			});
			return { event: "repo.created" };
		}, by);
	};

	const importFromUrl = async (
		by: string,
		input: ImportRepoInput,
		source: { readonly url: string; readonly branch?: string },
	): Promise<NodeDto> => {
		const url = checkImportUrl(source.url);
		const branch = source.branch === undefined
			? undefined
			: checkBranch(source.branch);
		const node = begin(by, { ...input, defaultBranch: branch ?? "main" });
		return await run(node, async () => {
			const name = node.artifacts_name as string;
			// The returned 24 h token is discarded unread (K11, U53).
			const imported = await c.ports.artifacts.import({
				source: { url: redactedSource(url), ...(branch ? { branch } : {}) },
				target: { name },
			});
			const defaultBranch = branch ??
				checkBranch(imported.defaultBranch || "main");
			if (defaultBranch !== node.default_branch) {
				c.tx(() =>
					c.sql.exec(
						"UPDATE nodes SET default_branch = ? WHERE id = ?",
						defaultBranch,
						node.id,
					)
				);
			}
			const repo = c.ports.repo(node.id);
			await repo.init({
				repoId: node.id,
				nodeId: node.id,
				path: node.path,
				defaultBranch,
				importState: "importing",
			});
			const source = redactedSource(url);
			await repo.importComplete(SYS_KERNEL, { defaultBranch }, source);
			return { event: "repo.imported", source };
		}, by);
	};

	const importByPush = async (
		by: string,
		input: ImportRepoInput,
	): Promise<NodeDto> => {
		if (!c.identity().isOwner(by)) {
			throw denied("role", "import mode is for the forge Owner");
		}
		const node = begin(by, { ...input, defaultBranch: "main" });
		return await run(node, async () => {
			await c.ports.artifacts.create(node.artifacts_name as string, {
				setDefaultBranch: "main",
			});
			await c.ports.repo(node.id).init({
				repoId: node.id,
				nodeId: node.id,
				path: node.path,
				defaultBranch: "main",
				importState: "importing",
			});
			return { event: "repo.created", source: "import-mode" };
		}, by);
	};

	const importRepo = (by: string, input: ImportRepoInput): Promise<NodeDto> => {
		const source = input.import;
		if (source === null || typeof source !== "object") {
			return Promise.reject(invalid("import needs a source"));
		}
		if ("mode" in source) {
			return source.mode === "push"
				? importByPush(by, input)
				: Promise.reject(invalid("the import mode is push"));
		}
		return importFromUrl(by, input, source);
	};

	const importCompleted = (
		by: string,
		repoId: string,
		defaultBranch: string,
	): NodeDto =>
		c.tx(() => {
			const node = requireNode(c, repoId);
			if (node.kind !== "repo") throw invalid("not a repo");
			const branch = checkBranch(defaultBranch);
			c.sql.exec(
				"UPDATE nodes SET default_branch = ? WHERE id = ?",
				branch,
				repoId,
			);
			const updated = requireNode(c, repoId);
			appendForge(c, {
				type: "repo.imported",
				by,
				node: repoId,
				data: {
					repoId,
					path: updated.path,
					artifactsName: updated.artifacts_name as string,
					source: "import-mode",
				},
			});
			return nodeDto(updated);
		});

	const onCreateTimer = async (key: string): Promise<void> => {
		const repoId = key.slice(CREATE_TIMER_PREFIX.length);
		if (running.has(repoId)) {
			c.timers.schedule(key, c.clock.now() + CREATE_GRACE_MS);
			return;
		}
		const name = nodeById(c.sql, repoId)?.artifacts_name ??
			(() => {
				try {
					return repoArtifactsName(repoId);
				} catch {
					return null;
				}
			})();
		if (name === null) return;
		if (indexRow(c.sql, name)?.state !== "pending") return;
		await rollback(repoId, name, new Error("create did not finish"));
	};

	return { createRepo, importRepo, importCompleted, onCreateTimer };
};
