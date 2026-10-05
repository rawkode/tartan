// Synchronous SQL of the identity module (WP2). Raw SQL
// with the contract's row types; every function runs inside the caller's
// `transactionSync` when it is given one. ForgeDO's common `meta` and
// `rate_limits` tables (WP0) are read and written here only for identity's
// keys: `setup_state`, `forge_name`, `canonical_origin`, `owner_principal`,
// `root_key_fallback_sealed`, `recovery_banner_until`, and the `setup:*`,
// `login:*` and `tokens:*` rate-limit keys.

import { type Role, type TokenScope, TokenScopeSchema } from "@tartan/contract";
import type {
	ForgeMetaKey,
	IdpRow,
	InviteRow,
	KeyRow,
	PrincipalRow,
	SessionRow,
	SetupState,
	TokenRow,
} from "@tartan/contract/kernel.ts";

/** Row of the identity-owned `consumed_destroy_tokens` table (migration 101). */
export type ConsumedDestroyTokenRow = {
	hash: string;
	consumed_at: number;
	outcome: string;
};

export type RateLimitResult = { ok: boolean; retryAfterMs?: number };

export const createIdentityStore = (sql: SqlStorage) => {
	const first = <T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): T | null => sql.exec<T>(query, ...bindings).toArray()[0] ?? null;

	const meta = (k: ForgeMetaKey): string | null =>
		first<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v ?? null;

	const setMeta = (k: ForgeMetaKey, v: string): void => {
		sql.exec(
			"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
			k,
			v,
		);
	};

	const setupState = (): SetupState =>
		(meta("setup_state") as SetupState | null) ?? "fresh";

	/** A fixed window per key: `limit` hits per `windowMs`. */
	const hitRateLimit = (
		key: string,
		limit: number,
		windowMs: number,
		now: number,
	): RateLimitResult => {
		const row = first<{ window_start: number; count: number }>(
			"SELECT window_start, count FROM rate_limits WHERE key = ?",
			key,
		);
		if (row === null || now - row.window_start >= windowMs) {
			sql.exec(
				"INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 1",
				key,
				now,
			);
			return { ok: true };
		}
		if (row.count >= limit) {
			return { ok: false, retryAfterMs: row.window_start + windowMs - now };
		}
		sql.exec(
			"UPDATE rate_limits SET count = count + 1 WHERE key = ?",
			key,
		);
		return { ok: true };
	};

	const principal = (id: string): PrincipalRow | null =>
		first<PrincipalRow>("SELECT * FROM principals WHERE id = ?", id);

	const principalByHandle = (handle: string): PrincipalRow | null =>
		first<PrincipalRow>("SELECT * FROM principals WHERE handle = ?", handle);

	/** `base`, or `base-2`, `base-3`, … whichever is free (handles share one space). */
	const uniqueHandle = (base: string): string => {
		if (principalByHandle(base) === null) return base;
		for (let n = 2;; n++) {
			const candidate = `${base.slice(0, 60)}-${n}`;
			if (principalByHandle(candidate) === null) return candidate;
		}
	};

	const insertPrincipal = (row: PrincipalRow): void => {
		sql.exec(
			"INSERT INTO principals (id, kind, handle, display, email, email_verified, owner_user_id, agent_tool, agent_model, is_admin, created_at, disabled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			row.id,
			row.kind,
			row.handle,
			row.display,
			row.email,
			row.email_verified,
			row.owner_user_id,
			row.agent_tool,
			row.agent_model,
			row.is_admin,
			row.created_at,
			row.disabled_at,
		);
	};

	const identityPrincipal = (issuer: string, sub: string): string | null =>
		first<{ principal_id: string }>(
			"SELECT principal_id FROM identities WHERE issuer = ? AND sub = ?",
			issuer,
			sub,
		)?.principal_id ?? null;

	const insertIdentity = (
		issuer: string,
		sub: string,
		principalId: string,
		now: number,
	): void => {
		sql.exec(
			"INSERT INTO identities (issuer, sub, principal_id, last_login_at) VALUES (?, ?, ?, ?)",
			issuer,
			sub,
			principalId,
			now,
		);
	};

	const touchIdentity = (issuer: string, sub: string, now: number): void => {
		sql.exec(
			"UPDATE identities SET last_login_at = ? WHERE issuer = ? AND sub = ?",
			now,
			issuer,
			sub,
		);
	};

	const insertSession = (row: SessionRow): void => {
		sql.exec(
			"INSERT INTO sessions (id_hash, principal_id, kind, idp_sid, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			row.id_hash,
			row.principal_id,
			row.kind,
			row.idp_sid,
			row.created_at,
			row.last_seen_at,
			row.idle_expires_at,
			row.absolute_expires_at,
		);
	};

	const sessionRow = (idHash: string): SessionRow | null =>
		first<SessionRow>("SELECT * FROM sessions WHERE id_hash = ?", idHash);

	const idp = (): IdpRow | null =>
		first<IdpRow>("SELECT * FROM idp WHERE id = 'default'");

	const upsertIdp = (row: IdpRow): void => {
		sql.exec(
			`INSERT INTO idp (id, issuer, client_id, client_auth, id_token_alg, client_secret_sealed, registration_sealed, scopes, metadata_json, discovered_at, username_claim, allowed_email_domains_json, jit_provisioning, verify_id_token_signature, source, updated_at)
			 VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET issuer = excluded.issuer, client_id = excluded.client_id, client_auth = excluded.client_auth, id_token_alg = excluded.id_token_alg, client_secret_sealed = excluded.client_secret_sealed, registration_sealed = excluded.registration_sealed, scopes = excluded.scopes, metadata_json = excluded.metadata_json, discovered_at = excluded.discovered_at, username_claim = excluded.username_claim, allowed_email_domains_json = excluded.allowed_email_domains_json, jit_provisioning = excluded.jit_provisioning, verify_id_token_signature = excluded.verify_id_token_signature, source = excluded.source, updated_at = excluded.updated_at`,
			row.issuer,
			row.client_id,
			row.client_auth,
			row.id_token_alg,
			row.client_secret_sealed,
			row.registration_sealed,
			row.scopes,
			row.metadata_json,
			row.discovered_at,
			row.username_claim,
			row.allowed_email_domains_json,
			row.jit_provisioning,
			row.verify_id_token_signature,
			row.source,
			row.updated_at,
		);
	};

	const activeClientKey = (): KeyRow | null =>
		first<KeyRow>(
			"SELECT * FROM keys WHERE use = 'client-auth' AND state = 'active' ORDER BY created_at DESC LIMIT 1",
		);

	const insertToken = (row: TokenRow): void => {
		sql.exec(
			"INSERT INTO tokens (id, hash, kind, principal_id, name, scopes_json, node_id, lane_id, max_role, expires_at, last_used_at, revoked_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			row.id,
			row.hash,
			row.kind,
			row.principal_id,
			row.name,
			row.scopes_json,
			row.node_id,
			row.lane_id,
			row.max_role,
			row.expires_at,
			row.last_used_at,
			row.revoked_at,
			row.created_by,
			row.created_at,
		);
	};

	const tokenById = (id: string): TokenRow | null =>
		first<TokenRow>("SELECT * FROM tokens WHERE id = ?", id);

	const tokenByHash = (hash: string): TokenRow | null =>
		first<TokenRow>("SELECT * FROM tokens WHERE hash = ?", hash);

	const invite = (id: string): InviteRow | null =>
		first<InviteRow>("SELECT * FROM invites WHERE id = ?", id);

	const inviteByHash = (codeHash: string): InviteRow | null =>
		first<InviteRow>("SELECT * FROM invites WHERE code_hash = ?", codeHash);

	return {
		sql,
		first,
		meta,
		setMeta,
		setupState,
		hitRateLimit,
		principal,
		principalByHandle,
		uniqueHandle,
		insertPrincipal,
		identityPrincipal,
		insertIdentity,
		touchIdentity,
		insertSession,
		sessionRow,
		idp,
		upsertIdp,
		activeClientKey,
		insertToken,
		tokenById,
		tokenByHash,
		invite,
		inviteByHash,
	};
};

export type IdentityStore = ReturnType<typeof createIdentityStore>;

const TOKEN_SCOPES: ReadonlySet<string> = new Set(TokenScopeSchema.options);

/** `tokens.scopes_json` → the known scopes it lists. */
export const parseScopes = (json: string): TokenScope[] => {
	const value: unknown = JSON.parse(json);
	return Array.isArray(value)
		? value.filter((s): s is TokenScope =>
			typeof s === "string" && TOKEN_SCOPES.has(s)
		)
		: [];
};

export const asRole = (value: number): Role => value as Role;
