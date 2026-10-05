// Typed SQL over the `tree` tables (WP3): row reads, the
// `NodeRow → NodeDto` mapper, `meta` version bumps and the hierarchy queries
// (ancestors as one JSON-array parameter, subtrees as range scans, never
// LIKE).

import type { NodeDto } from "@tartan/contract";
import type {
	ArtifactsIndexRow,
	ForgeMetaKey,
	GrantRow,
	NodeRow,
	RedirectRow,
} from "@tartan/contract/kernel.ts";

type Row = Record<string, SqlStorageValue>;

export const rows = <T extends Row>(
	sql: SqlStorage,
	query: string,
	...bindings: SqlStorageValue[]
): T[] => sql.exec<T>(query, ...bindings).toArray();

export const first = <T extends Row>(
	sql: SqlStorage,
	query: string,
	...bindings: SqlStorageValue[]
): T | null => rows<T>(sql, query, ...bindings)[0] ?? null;

export const count = (
	sql: SqlStorage,
	query: string,
	...bindings: SqlStorageValue[]
): number => first<{ n: number }>(sql, query, ...bindings)?.n ?? 0;

/** One JSON array parameter for `json_each(?)` (≤ 100 bound parameters). */
export const jsonList = (values: readonly string[]): string =>
	JSON.stringify(values);

export const nodeDto = (row: NodeRow): NodeDto => ({
	id: row.id,
	parentId: row.parent_id,
	kind: row.kind,
	slug: row.slug,
	path: row.path,
	depth: row.depth,
	visibility: row.visibility,
	...(row.description !== null ? { description: row.description } : {}),
	...(row.kind === "repo"
		? { defaultBranch: row.default_branch ?? "main" }
		: {}),
	archived: row.archived_at !== null,
	createdAt: row.created_at,
});

export const nodeById = (sql: SqlStorage, id: string): NodeRow | null =>
	first<NodeRow>(sql, "SELECT * FROM nodes WHERE id = ?", id);

export const nodeByPath = (sql: SqlStorage, path: string): NodeRow | null =>
	first<NodeRow>(sql, "SELECT * FROM nodes WHERE path = ?", path);

/** The deepest existing node among `paths` (ancestor-or-self prefixes). */
export const deepestNode = (
	sql: SqlStorage,
	paths: readonly string[],
): NodeRow | null =>
	first<NodeRow>(
		sql,
		"SELECT * FROM nodes WHERE path IN (SELECT value FROM json_each(?)) ORDER BY depth DESC LIMIT 1",
		jsonList(paths),
	);

/** The longest redirect among `paths`. */
export const longestRedirect = (
	sql: SqlStorage,
	paths: readonly string[],
): RedirectRow | null =>
	first<RedirectRow>(
		sql,
		"SELECT * FROM redirects WHERE old_path IN (SELECT value FROM json_each(?)) ORDER BY length(old_path) DESC LIMIT 1",
		jsonList(paths),
	);

/** `path` and everything below it (range scan: `'0'` is the code point after `/`). */
export const subtreeRows = (sql: SqlStorage, path: string): NodeRow[] =>
	rows<NodeRow>(
		sql,
		"SELECT * FROM nodes WHERE path = ?1 OR (path > ?1 || '/' AND path < ?1 || '0') ORDER BY path",
		path,
	);

export const subtreeSize = (sql: SqlStorage, path: string): number =>
	count(
		sql,
		"SELECT COUNT(*) AS n FROM nodes WHERE path = ?1 OR (path > ?1 || '/' AND path < ?1 || '0')",
		path,
	);

export const grantRows = (sql: SqlStorage, nodeId: string): GrantRow[] =>
	rows<GrantRow>(
		sql,
		"SELECT * FROM grants WHERE node_id = ? ORDER BY role DESC, principal_id",
		nodeId,
	);

export const indexRow = (
	sql: SqlStorage,
	name: string,
): ArtifactsIndexRow | null =>
	first<ArtifactsIndexRow>(
		sql,
		"SELECT * FROM artifacts_index WHERE name = ?",
		name,
	);

export const getMeta = (sql: SqlStorage, key: ForgeMetaKey): string | null =>
	first<{ v: string }>(sql, "SELECT v FROM meta WHERE k = ?", key)?.v ?? null;

/** `authz_version` / `hierarchy_version`: bumped on every grant or path change. */
export const bumpVersion = (
	sql: SqlStorage,
	key: "authz_version" | "hierarchy_version",
): void => {
	sql.exec(
		"INSERT INTO meta (k, v) VALUES (?, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)",
		key,
	);
};
