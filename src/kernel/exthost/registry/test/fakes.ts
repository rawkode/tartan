// Local fakes for WP7a's Deno unit tests (`@tartan/testkit` has no DO SQL
// fake yet): a `SqlStorage` + `transactionSync` over `node:sqlite`, a tree
// internal API backed by a minimal `nodes` table (WP3's DDL subset, so the
// registry's `REFERENCES nodes(id)` holds), and recording forge events.
// Test-only: imported by `*.test.ts` files, never by runtime code.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { BuiltinPackage, EffectiveRole, Envelope } from "@tartan/contract";
import { createUlid, parseManifest, pathPrefixes } from "@tartan/contract";
import type {
	ForgeEventsInternal,
	ForgeInternals,
	IdentityInternal,
	Migration,
	NodeRow,
	TreeInternal,
} from "@tartan/contract/kernel.ts";
import { COMMON_DDL } from "@tartan/contract/kernel.ts";
import type { RegistryDeps } from "../module.ts";

type Row = Record<string, SQLInputValue>;

const splitStatements = (query: string): string[] =>
	query.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter((s) => s !== "");

export type FakeDb = {
	readonly db: DatabaseSync;
	readonly sql: SqlStorage;
	readonly storage: DurableObjectStorage;
	migrate(migrations: readonly Migration[]): void;
};

export const createFakeDb = (): FakeDb => {
	const db = new DatabaseSync(":memory:");
	const exec = (query: string, ...bindings: unknown[]) => {
		const statements = splitStatements(query);
		let rows: Row[] = [];
		for (const statement of statements) {
			rows = db.prepare(statement).all(
				...(bindings as SQLInputValue[]),
			) as Row[];
		}
		const copy = rows.map((r) => ({ ...r }));
		return {
			toArray: () => copy,
			one: () => {
				if (copy.length !== 1) {
					throw new Error(`expected one row, got ${copy.length}`);
				}
				return copy[0];
			},
			[Symbol.iterator]: () => copy[Symbol.iterator](),
			raw: () => copy.map((r) => Object.values(r))[Symbol.iterator](),
			columnNames: copy[0] ? Object.keys(copy[0]) : [],
			rowsRead: copy.length,
			rowsWritten: 0,
		};
	};
	const sql = { exec, databaseSize: 0 } as unknown as SqlStorage;
	let depth = 0;
	const transactionSync = <T>(fn: () => T): T => {
		const name = `tx${depth}`;
		db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
		depth += 1;
		try {
			const out = fn();
			depth -= 1;
			db.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
			return out;
		} catch (error) {
			depth -= 1;
			db.exec(
				depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`,
			);
			throw error;
		}
	};
	const storage = { sql, transactionSync } as unknown as DurableObjectStorage;
	db.exec(COMMON_DDL.meta);
	return {
		db,
		sql,
		storage,
		migrate: (migrations) => {
			for (const m of migrations) {
				for (const s of splitStatements(m.sql)) db.exec(s);
			}
		},
	};
};

/** WP3's `nodes` columns the registry and the fakes need. */
const NODES_DDL =
	`CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL, slug TEXT NOT NULL, path TEXT NOT NULL UNIQUE, depth INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private', artifacts_name TEXT UNIQUE, default_branch TEXT,
  description TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER)`;

export type FakeTree = TreeInternal & {
	/** Creates `path` (and missing parents as groups); the last segment gets `kind`. */
	add(path: string, kind?: "user" | "group" | "repo"): NodeRow;
	grant(path: string, principal: string, role: EffectiveRole): void;
	node(path: string): NodeRow;
};

const ulid = createUlid();

export const createFakeTree = (fake: FakeDb, owner?: string): FakeTree => {
	fake.db.exec(NODES_DDL);
	const grants = new Map<string, Map<string, EffectiveRole>>();
	const byPath = (path: string): NodeRow | null =>
		(fake.db.prepare("SELECT * FROM nodes WHERE path = ?").get(path) as
			| NodeRow
			| undefined) ?? null;
	const byId = (id: string): NodeRow | null =>
		(fake.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
			| NodeRow
			| undefined) ?? null;
	const add = (path: string, kind: "user" | "group" | "repo" = "group") => {
		const prefixes = pathPrefixes(path);
		let parent: NodeRow | null = null;
		for (const [i, p] of prefixes.entries()) {
			const existing = byPath(p);
			if (existing !== null) {
				parent = existing;
				continue;
			}
			const id = ulid();
			const k = i === prefixes.length - 1 ? kind : "group";
			fake.db.prepare(
				`INSERT INTO nodes (id, parent_id, kind, slug, path, depth, artifacts_name, default_branch, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'u_test', 0)`,
			).run(
				id,
				parent?.id ?? null,
				k,
				p.split("/").pop()!,
				p,
				i,
				k === "repo" ? `r-${id}` : null,
				k === "repo" ? "main" : null,
			);
			parent = byPath(p);
		}
		return parent!;
	};
	return {
		add,
		node: (path) => {
			const n = byPath(path);
			if (n === null) throw new Error(`no node ${path}`);
			return n;
		},
		grant: (path, principal, role) => {
			const id = byPath(path)!.id;
			const m = grants.get(id) ?? new Map();
			m.set(principal, role);
			grants.set(id, m);
		},
		nodeSync: byId,
		nodeByPathSync: byPath,
		ancestorPathsSync: (nodeId) => {
			const n = byId(nodeId);
			return n === null ? [] : pathPrefixes(n.path);
		},
		effectiveRoleSync: (principals, nodeId) => {
			const n = byId(nodeId);
			if (n === null) return 0;
			let role = 0;
			for (const p of pathPrefixes(n.path)) {
				const row = byPath(p)!;
				if (
					row.depth === 0 && owner !== undefined && principals.includes(owner)
				) {
					role = 50;
				}
				for (const principal of principals) {
					role = Math.max(role, grants.get(row.id)?.get(principal) ?? 0);
				}
			}
			return role as EffectiveRole;
		},
		isWithinSync: (root, nodeId) => {
			const r = byId(root);
			const n = byId(nodeId);
			return r !== null && n !== null &&
				(n.path === r.path || n.path.startsWith(`${r.path}/`));
		},
		// Contract additions the registry never calls.
		holdsRoleWithinSync: () => {
			throw new Error("not used by the registry");
		},
		createRootSync: () => {
			throw new Error("not used by the registry");
		},
		grantSync: () => {
			throw new Error("not used by the registry");
		},
	};
};

export type RecordedEvent = Parameters<ForgeEventsInternal["appendSync"]>[0];

export type FakeEvents = ForgeEventsInternal & {
	readonly events: RecordedEvent[];
	readonly audits: Parameters<ForgeEventsInternal["auditSync"]>[0][];
};

export const createFakeEvents = (): FakeEvents => {
	const events: RecordedEvent[] = [];
	const audits: Parameters<ForgeEventsInternal["auditSync"]>[0][] = [];
	return {
		events,
		audits,
		appendSync: (event) => {
			events.push(event);
			return { id: ulid(), seq: events.length };
		},
		auditSync: (entry) => {
			audits.push(entry);
		},
	};
};

export type RegistryFixture = {
	readonly db: FakeDb;
	readonly tree: FakeTree;
	readonly events: FakeEvents;
	readonly deps: RegistryDeps;
	now: number;
};

/** Deps for `createRegistry` over the fakes; `now` advances 1 ms per read. */
export const registryFixture = (
	migrations: readonly Migration[],
	owner = "u_owner",
): RegistryFixture => {
	const db = createFakeDb();
	const tree = createFakeTree(db, owner);
	const events = createFakeEvents();
	db.migrate(migrations);
	const identity: IdentityInternal = {
		principalSync: () => null,
		isOwner: (p) => p === owner,
	};
	const fixture: RegistryFixture = {
		db,
		tree,
		events,
		now: 1_000,
		deps: undefined as unknown as RegistryDeps,
	};
	const modules: ForgeInternals = {
		identity,
		tree,
		registry: undefined as never,
		events,
		slots: {},
	};
	const ids = createUlid({ now: () => fixture.now });
	(fixture as { deps: RegistryDeps }).deps = {
		sql: db.sql,
		storage: db.storage,
		ctx: {} as DurableObjectState,
		env: {} as RegistryDeps["env"],
		modules,
		timers: { schedule: () => {}, cancel: () => {}, get: () => null },
		clock: { now: () => (fixture.now += 1) },
		ids: { ulid: ids },
	};
	return fixture;
};

/** A bundled package built from a manifest literal (defaults applied). */
export const bundled = (
	manifest: Record<string, unknown>,
	protocol?: string,
): BuiltinPackage => {
	const parsed = parseManifest(manifest);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return { manifest: parsed.manifest, module: {}, migrations: [], protocol };
};

/** A minimal valid manifest (`tartan.<name>` builtin) with overrides. */
export const manifest = (
	id: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	schema: 1,
	id,
	name: id,
	version: "0.1.0",
	api: "tartan:ext@0.1.0",
	runtime: "builtin",
	entry: { builtin: id },
	storage: { scope: "repo" },
	permissions: {},
	...extra,
});

export type { Envelope };
