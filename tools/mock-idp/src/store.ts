// State of the e2e mock IdP, in the SQLite storage of its one Durable Object
// (`IdpState`, instance `default`): registered clients, pending authorization
// requests, authorization codes and rate-limit windows. Every method is
// synchronous; callers group them in `tx` (one DO transaction). Bearer values
// (request ids, codes, registration tokens) are stored as SHA-256 hex only.

/** The part of `SqlStorage` the store uses (a `node:sqlite` fake in tests). */
export type SqlLike = {
	exec(
		query: string,
		...bindings: (string | number | null)[]
	): { toArray(): Record<string, unknown>[] };
};

export type StorageLike = {
	readonly sql: SqlLike;
	transactionSync<T>(fn: () => T): T;
};

export type ClientRow = {
	readonly id: string;
	readonly redirectUri: string;
	readonly name: string | null;
	readonly tokenHash: string;
	readonly createdAt: number;
	/** Set once the client redeemed a code; such a client is never evicted. */
	readonly lastUsedAt: number | null;
};

export type PendingRequest = {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly state: string;
	readonly nonce: string;
	readonly challenge: string;
	readonly scope: string;
	readonly expiresAt: number;
};

export type CodeRow = {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly challenge: string;
	readonly nonce: string;
	readonly sub: string;
	readonly authTime: number;
	readonly scope: string;
	readonly expiresAt: number;
};

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS clients (
		id TEXT PRIMARY KEY,
		redirect_uri TEXT NOT NULL,
		name TEXT,
		token_hash TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS requests (
		id_hash TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		redirect_uri TEXT NOT NULL,
		state TEXT NOT NULL,
		nonce TEXT NOT NULL,
		challenge TEXT NOT NULL,
		scope TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS codes (
		code_hash TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		redirect_uri TEXT NOT NULL,
		challenge TEXT NOT NULL,
		nonce TEXT NOT NULL,
		sub TEXT NOT NULL,
		auth_time INTEGER NOT NULL,
		scope TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS rate (
		key TEXT PRIMARY KEY,
		window_start INTEGER NOT NULL,
		count INTEGER NOT NULL
	)`,
];

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const optNum = (v: unknown): number | null => (v === null ? null : Number(v));

const clientOf = (r: Record<string, unknown>): ClientRow => ({
	id: str(r.id),
	redirectUri: str(r.redirect_uri),
	name: r.name === null ? null : str(r.name),
	tokenHash: str(r.token_hash),
	createdAt: num(r.created_at),
	lastUsedAt: optNum(r.last_used_at),
});

export const createStore = (storage: StorageLike) => {
	const sql = storage.sql;
	for (const statement of SCHEMA) sql.exec(statement);

	const rows = (query: string, ...bindings: (string | number | null)[]) =>
		sql.exec(query, ...bindings).toArray();

	const purgeExpired = (now: number): void => {
		sql.exec("DELETE FROM requests WHERE expires_at <= ?", now);
		sql.exec("DELETE FROM codes WHERE expires_at <= ?", now);
	};

	const clients = (): ClientRow[] =>
		rows("SELECT * FROM clients ORDER BY created_at, id").map(clientOf);

	const client = (id: string): ClientRow | null => {
		const found = rows("SELECT * FROM clients WHERE id = ?", id);
		return found.length === 0 ? null : clientOf(found[0]);
	};

	const insertClient = (row: ClientRow): void => {
		sql.exec(
			"INSERT INTO clients (id, redirect_uri, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
			row.id,
			row.redirectUri,
			row.name,
			row.tokenHash,
			row.createdAt,
			row.lastUsedAt,
		);
	};

	const deleteClient = (id: string): void => {
		sql.exec("DELETE FROM clients WHERE id = ?", id);
		sql.exec("DELETE FROM requests WHERE client_id = ?", id);
		sql.exec("DELETE FROM codes WHERE client_id = ?", id);
	};

	const markClientUsed = (id: string, at: number): void => {
		sql.exec("UPDATE clients SET last_used_at = ? WHERE id = ?", at, id);
	};

	const putRequest = (idHash: string, r: PendingRequest): void => {
		sql.exec(
			"INSERT INTO requests (id_hash, client_id, redirect_uri, state, nonce, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			idHash,
			r.clientId,
			r.redirectUri,
			r.state,
			r.nonce,
			r.challenge,
			r.scope,
			r.expiresAt,
		);
	};

	/** Returns and deletes the pending request (single use). */
	const takeRequest = (idHash: string, now: number): PendingRequest | null => {
		const found = rows("SELECT * FROM requests WHERE id_hash = ?", idHash);
		sql.exec("DELETE FROM requests WHERE id_hash = ?", idHash);
		if (found.length === 0) return null;
		const r = found[0];
		const request: PendingRequest = {
			clientId: str(r.client_id),
			redirectUri: str(r.redirect_uri),
			state: str(r.state),
			nonce: str(r.nonce),
			challenge: str(r.challenge),
			scope: str(r.scope),
			expiresAt: num(r.expires_at),
		};
		return request.expiresAt > now ? request : null;
	};

	const putCode = (codeHash: string, c: CodeRow): void => {
		sql.exec(
			"INSERT INTO codes (code_hash, client_id, redirect_uri, challenge, nonce, sub, auth_time, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			codeHash,
			c.clientId,
			c.redirectUri,
			c.challenge,
			c.nonce,
			c.sub,
			c.authTime,
			c.scope,
			c.expiresAt,
		);
	};

	/** Returns and deletes the code, whatever happens next (single use). */
	const takeCode = (codeHash: string, now: number): CodeRow | null => {
		const found = rows("SELECT * FROM codes WHERE code_hash = ?", codeHash);
		sql.exec("DELETE FROM codes WHERE code_hash = ?", codeHash);
		if (found.length === 0) return null;
		const r = found[0];
		const code: CodeRow = {
			clientId: str(r.client_id),
			redirectUri: str(r.redirect_uri),
			challenge: str(r.challenge),
			nonce: str(r.nonce),
			sub: str(r.sub),
			authTime: num(r.auth_time),
			scope: str(r.scope),
			expiresAt: num(r.expires_at),
		};
		return code.expiresAt > now ? code : null;
	};

	/**
	 * Fixed-window counter: counts one hit and returns the count in the
	 * current window (a hit that starts a new window counts 1).
	 */
	const hit = (key: string, windowMs: number, now: number): number => {
		const found = rows(
			"SELECT window_start, count FROM rate WHERE key = ?",
			key,
		);
		if (found.length === 0 || num(found[0].window_start) + windowMs <= now) {
			sql.exec(
				"INSERT OR REPLACE INTO rate (key, window_start, count) VALUES (?, ?, 1)",
				key,
				now,
			);
			return 1;
		}
		const count = num(found[0].count) + 1;
		sql.exec("UPDATE rate SET count = ? WHERE key = ?", count, key);
		return count;
	};

	/** Hits in the current window without counting one. */
	const peek = (key: string, windowMs: number, now: number): number => {
		const found = rows(
			"SELECT window_start, count FROM rate WHERE key = ?",
			key,
		);
		return found.length === 0 || num(found[0].window_start) + windowMs <= now
			? 0
			: num(found[0].count);
	};

	return {
		tx: <T>(fn: () => T): T => storage.transactionSync(fn),
		purgeExpired,
		clients,
		client,
		insertClient,
		deleteClient,
		markClientUsed,
		putRequest,
		takeRequest,
		putCode,
		takeCode,
		hit,
		peek,
	};
};

export type Store = ReturnType<typeof createStore>;
