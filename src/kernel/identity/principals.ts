// Principals, sessions, tokens, agents and invites (WP2).
//
// Sessions and tokens are stored as SHA-256 only. A token is
// `tpat_`/`tagt_` + 43 base64url chars (256 bits); its lookup returns the
// `AuthContext` the HTTP layer caches for at most 60 s per isolate, so a
// revocation takes effect within 60 s everywhere (at once on the revoking
// isolate). Invites are single-use: the transaction that binds an
// `(issuer, sub)` marks the invite used, so a second login with the same
// code finds nothing. Identities are never linked by email.

import {
	type AgentCreateRequest,
	AgentCreateRequestSchema,
	type AgentDto,
	agentId as agentPrincipalId,
	conflict,
	denied,
	ID_PREFIX,
	invalid,
	type InviteCreateRequest,
	InviteCreateRequestSchema,
	notFound,
	rateLimited,
	type Role,
	RoleSchema,
	SHA256_HEX_RE,
	TOKEN_PREFIX,
	type TokenScope,
	TokenScopeSchema,
	userId,
} from "@tartan/contract";
import type {
	AuthContext,
	PrincipalRow,
	TokenRow,
} from "@tartan/contract/kernel.ts";
import { handleFrom } from "./codes.ts";
import type { IdentityContext } from "./context.ts";
import { randomSecret, sha256Hex } from "./crypto.ts";
import { appendPrincipalCreated } from "./events.ts";
import { parseInput } from "./input.ts";
import {
	DEFAULT_AGENT_SCOPES,
	IDENTITY_TTL,
	RATE_LIMITS,
	rateKey,
} from "./policy.ts";
import { asRole, parseScopes } from "./store.ts";
import type { InviteDto, TokenDto } from "./types.ts";

const DAY = 86_400_000;

/** Dev tools (bulk agents, swarm, reset) need both flags. */
export const devToolsEnabled = (
	env: { readonly TARTAN_STAGE?: string; readonly TARTAN_DEV_TOOLS?: string },
): boolean =>
	/^dev/.test(env.TARTAN_STAGE ?? "") && env.TARTAN_DEV_TOOLS === "1";

export type LoginIdentity = {
	issuer: string;
	sub: string;
	handle: string;
	display: string;
	email?: string;
	emailVerified: boolean;
};

const isActive = (p: PrincipalRow | null): p is PrincipalRow =>
	p !== null && p.disabled_at === null;

/** A signed-in human in the browser: unrestricted bounds. */
export const sessionAuth = (
	p: PrincipalRow,
	expiresAt: number,
): AuthContext => ({
	principal: p.id,
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: p.is_admin === 1,
	expiresAt,
});

/** A PAT or agent token: its scopes, node, lane pin and role ceiling bound the caller. */
export const tokenAuth = (t: TokenRow, p: PrincipalRow): AuthContext => {
	const scopes = parseScopes(t.scopes_json);
	return {
		principal: p.id,
		kind: p.kind === "agent" ? "agent" : "user",
		via: t.kind === "pat" ? "pat" : "agent-token",
		tokenId: t.id,
		scopes,
		nodeId: t.node_id,
		laneId: t.lane_id,
		maxRole: asRole(t.max_role),
		// A token acts as an admin only for an admin user AND with the `admin` scope.
		isAdmin: p.kind === "user" && p.is_admin === 1 && scopes.includes("admin"),
		expiresAt: t.expires_at,
	};
};

const checkScopes = (scopes: unknown): TokenScope[] => {
	if (!Array.isArray(scopes) || scopes.length === 0) {
		throw invalid("a token needs at least one scope");
	}
	return [...new Set(scopes.map((s) => parseInput(TokenScopeSchema, s)))];
};

export const createPrincipals = (c: IdentityContext) => {
	const { store } = c;
	const now = () => c.clock.now();
	const audit = (
		entry: Parameters<IdentityContext["modules"]["events"]["auditSync"]>[0],
	): void => c.modules.events.auditSync(entry);

	const requireUser = (id: string): PrincipalRow => {
		const p = store.principal(id);
		if (!isActive(p) || p.kind !== "user") {
			throw denied("role", "only an active user may do this");
		}
		return p;
	};

	const isOwner = (principal: string): boolean =>
		store.meta("owner_principal") === principal;

	const tokenCreateLimit = (owner: string, at: number): void => {
		const r = c.tx(() =>
			store.hitRateLimit(
				rateKey.tokenCreate(owner),
				RATE_LIMITS.tokenCreatePerUser.limit,
				RATE_LIMITS.tokenCreatePerUser.windowMs,
				at,
			)
		);
		if (!r.ok) throw rateLimited("too many tokens created", r.retryAfterMs);
	};

	const newPrincipal = (
		fields:
			& Pick<PrincipalRow, "id" | "kind" | "handle" | "display">
			& Partial<PrincipalRow>,
		at: number,
	): PrincipalRow => ({
		email: null,
		email_verified: 0,
		owner_user_id: null,
		agent_tool: null,
		agent_model: null,
		is_admin: 0,
		disabled_at: null,
		...fields,
		created_at: at,
	});

	// -------------------------------------------------------------------------
	// Login
	// -------------------------------------------------------------------------

	const loginIdentity = async (
		identity: LoginIdentity,
		inviteHash: string | null,
	): Promise<{ principal: string } | null> => {
		const at = now();
		type Outcome =
			| { kind: "none" }
			| { kind: "existing"; principal: string }
			| {
				kind: "invited";
				principal: string;
				handle: string;
				nodeId: string;
				role: Role;
				by: string;
				relink: boolean;
			}
			| { kind: "jit"; principal: string };
		const outcome = c.tx((): Outcome => {
			const known = store.identityPrincipal(identity.issuer, identity.sub);
			if (known !== null) {
				if (!isActive(store.principal(known))) return { kind: "none" };
				store.touchIdentity(identity.issuer, identity.sub, at);
				audit({
					principal: known,
					action: "login",
					data: { issuer: identity.issuer },
				});
				return { kind: "existing", principal: known };
			}
			if (inviteHash !== null && SHA256_HEX_RE.test(inviteHash)) {
				const invite = store.inviteByHash(inviteHash);
				const claimed = invite !== null && store.sql.exec(
							"UPDATE invites SET used_at = ?, used_by_issuer = ?, used_by_sub = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
							at,
							identity.issuer,
							identity.sub,
							invite.id,
							at,
						).rowsWritten === 1;
				if (invite !== null && claimed) {
					if (invite.relink_principal !== null) {
						const target = store.principal(invite.relink_principal);
						if (!isActive(target) || target.kind !== "user") {
							throw conflict("the relink target is not an active user");
						}
						store.insertIdentity(identity.issuer, identity.sub, target.id, at);
						audit({
							principal: target.id,
							action: "invite.relink",
							target: invite.id,
							data: { issuer: identity.issuer },
						});
						return {
							kind: "invited",
							principal: target.id,
							handle: target.handle,
							nodeId: invite.node_id,
							role: asRole(invite.role),
							by: invite.created_by,
							relink: true,
						};
					}
					const principal = userId(c.ids.ulid());
					const handle = store.uniqueHandle(
						handleFrom(identity.handle, "user"),
					);
					store.insertPrincipal(newPrincipal({
						id: principal,
						kind: "user",
						handle,
						display: identity.display.slice(0, 200) || handle,
						email: identity.email ?? null,
						email_verified: identity.emailVerified ? 1 : 0,
					}, at));
					store.insertIdentity(identity.issuer, identity.sub, principal, at);
					audit({
						principal,
						action: "invite.accept",
						target: invite.id,
						data: {
							issuer: identity.issuer,
							node: invite.node_id,
							role: invite.role,
						},
					});
					appendPrincipalCreated(c, {
						principal,
						kind: "user",
						handle,
						node: invite.node_id,
						actor: { kind: "user", id: invite.created_by },
					});
					return {
						kind: "invited",
						principal,
						handle,
						nodeId: invite.node_id,
						role: asRole(invite.role),
						by: invite.created_by,
						relink: false,
					};
				}
			}
			const idp = store.idp();
			const domains: string[] = idp?.allowed_email_domains_json
				? JSON.parse(idp.allowed_email_domains_json)
				: [];
			const domain = identity.email?.split("@")[1]?.toLowerCase();
			if (
				idp !== null && idp.jit_provisioning === 1 && identity.emailVerified &&
				domain !== undefined && domains.includes(domain)
			) {
				const principal = userId(c.ids.ulid());
				const handle = store.uniqueHandle(handleFrom(identity.handle, "user"));
				store.insertPrincipal(newPrincipal({
					id: principal,
					kind: "user",
					handle,
					display: identity.display.slice(0, 200) || handle,
					email: identity.email ?? null,
					email_verified: 1,
				}, at));
				store.insertIdentity(identity.issuer, identity.sub, principal, at);
				audit({
					principal,
					action: "login.jit",
					data: { issuer: identity.issuer, domain },
				});
				return { kind: "jit", principal };
			}
			return { kind: "none" };
		});
		if (outcome.kind === "none") return null;
		if (outcome.kind === "invited" && !outcome.relink) {
			// WP3 grants the invite's role at its node (after identity's own transaction).
			try {
				await c.tree.grant(
					outcome.by,
					outcome.nodeId,
					outcome.principal,
					outcome.role,
				);
			} catch (error) {
				c.log.error("[tartan] invite grant failed", {
					principal: outcome.principal,
					node: outcome.nodeId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return { principal: outcome.principal };
	};

	// -------------------------------------------------------------------------
	// Sessions
	// -------------------------------------------------------------------------

	const createSession = async (
		principal: string,
		idpSid: string | null,
	): Promise<{ cookie: string; expiresAt: number }> => {
		const cookie = randomSecret();
		const idHash = await sha256Hex(cookie);
		const at = now();
		const absolute = at + IDENTITY_TTL.sessionAbsoluteMs;
		c.tx(() => {
			const p = store.principal(principal);
			if (!isActive(p) || p.kind !== "user") {
				throw denied("role", "sessions are for active users");
			}
			// Expired sessions are purged as new ones are made (bounded per principal).
			store.sql.exec(
				"DELETE FROM sessions WHERE principal_id = ? AND (absolute_expires_at <= ? OR idle_expires_at <= ?)",
				principal,
				at,
				at,
			);
			store.insertSession({
				id_hash: idHash,
				principal_id: principal,
				kind: "user",
				idp_sid: idpSid,
				created_at: at,
				last_seen_at: at,
				idle_expires_at: Math.min(at + IDENTITY_TTL.sessionIdleMs, absolute),
				absolute_expires_at: absolute,
			});
		});
		return { cookie, expiresAt: absolute };
	};

	const session = (idHash: string): Promise<AuthContext | null> => {
		if (!SHA256_HEX_RE.test(idHash)) return Promise.resolve(null);
		const at = now();
		return Promise.resolve(c.tx(() => {
			const row = store.sessionRow(idHash);
			if (
				row === null || row.kind !== "user" || row.idle_expires_at <= at ||
				row.absolute_expires_at <= at
			) {
				return null;
			}
			const p = store.principal(row.principal_id);
			if (!isActive(p) || p.kind !== "user") return null;
			if (at - row.last_seen_at >= IDENTITY_TTL.sessionTouchMs) {
				store.sql.exec(
					"UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ?",
					at,
					Math.min(at + IDENTITY_TTL.sessionIdleMs, row.absolute_expires_at),
					idHash,
				);
			}
			return sessionAuth(p, row.absolute_expires_at);
		}));
	};

	const deleteSession = (idHash: string): Promise<void> => {
		c.tx(() => {
			const row = store.sessionRow(idHash);
			store.sql.exec("DELETE FROM sessions WHERE id_hash = ?", idHash);
			if (row !== null && row.kind === "user") {
				audit({ principal: row.principal_id, action: "logout" });
			}
		});
		return Promise.resolve();
	};

	// -------------------------------------------------------------------------
	// Tokens
	// -------------------------------------------------------------------------

	const token = (hash: string): Promise<AuthContext | null> => {
		if (!SHA256_HEX_RE.test(hash)) return Promise.resolve(null);
		const at = now();
		return Promise.resolve(c.tx(() => {
			const row = store.tokenByHash(hash);
			if (row === null || row.revoked_at !== null || row.expires_at <= at) {
				return null;
			}
			const p = store.principal(row.principal_id);
			if (!isActive(p)) return null;
			if (row.kind === "pat" && p.kind !== "user") return null;
			if (row.kind === "agent") {
				if (p.kind !== "agent" || p.owner_user_id === null) return null;
				if (!isActive(store.principal(p.owner_user_id))) return null;
			}
			if (
				row.last_used_at === null ||
				at - row.last_used_at >= IDENTITY_TTL.tokenTouchMs
			) {
				store.sql.exec(
					"UPDATE tokens SET last_used_at = ? WHERE id = ?",
					at,
					row.id,
				);
			}
			return tokenAuth(row, p);
		}));
	};

	const mint = async (kind: "pat" | "agent") => {
		const secret = `${TOKEN_PREFIX[kind]}${randomSecret()}`;
		return {
			secret,
			hash: await sha256Hex(secret),
			id: `${ID_PREFIX.token}${c.ids.ulid()}`,
		};
	};

	const createPat = async (
		owner: string,
		input: {
			name: string;
			scopes: TokenScope[];
			nodeId?: string;
			maxRole: Role;
			expiresAt: number;
		},
	): Promise<{ tokenId: string; token: string }> => {
		const at = now();
		requireUser(owner);
		const name = String(input.name ?? "").trim();
		if (name === "" || name.length > 80) {
			throw invalid("a token name is 1–80 chars");
		}
		const scopes = checkScopes(input.scopes);
		const maxRole = parseInput(RoleSchema, input.maxRole);
		if (
			!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= at ||
			input.expiresAt > at + IDENTITY_TTL.patMaxMs
		) {
			throw invalid("a PAT expires within one year");
		}
		if (
			input.nodeId !== undefined &&
			c.modules.tree.nodeSync(input.nodeId) === null
		) {
			throw notFound("no such node");
		}
		tokenCreateLimit(owner, at);
		const t = await mint("pat");
		c.tx(() => {
			store.insertToken({
				id: t.id,
				hash: t.hash,
				kind: "pat",
				principal_id: owner,
				name,
				scopes_json: JSON.stringify(scopes),
				node_id: input.nodeId ?? null,
				lane_id: null,
				max_role: maxRole,
				expires_at: input.expiresAt,
				last_used_at: null,
				revoked_at: null,
				created_by: owner,
				created_at: at,
			});
			audit({
				principal: owner,
				action: "token.create",
				target: t.id,
				data: {
					kind: "pat",
					scopes,
					nodeId: input.nodeId ?? null,
					expiresAt: input.expiresAt,
				},
			});
		});
		return { tokenId: t.id, token: t.secret };
	};

	const createAgent = async (
		owner: string,
		input: AgentCreateRequest,
	): Promise<{ principal: string; tokenId: string; token: string }> => {
		const at = now();
		requireUser(owner);
		const parsed = parseInput(AgentCreateRequestSchema, input);
		const node = c.modules.tree.nodeByPathSync(parsed.node);
		if (node === null) throw notFound(`no node at ${parsed.node}`);
		const scopes = parsed.scopes
			? checkScopes(parsed.scopes)
			: [...DEFAULT_AGENT_SCOPES];
		tokenCreateLimit(owner, at);
		const t = await mint("agent");
		const principal = agentPrincipalId(c.ids.ulid());
		c.tx(() => {
			if (store.principalByHandle(parsed.name) !== null) {
				throw conflict(`the handle ${parsed.name} is taken`);
			}
			store.insertPrincipal(newPrincipal({
				id: principal,
				kind: "agent",
				handle: parsed.name,
				display: parsed.name,
				owner_user_id: owner,
				agent_tool: parsed.tool,
				agent_model: parsed.model ?? null,
			}, at));
			store.insertToken({
				id: t.id,
				hash: t.hash,
				kind: "agent",
				principal_id: principal,
				name: parsed.name,
				scopes_json: JSON.stringify(scopes),
				node_id: node.id,
				lane_id: null,
				max_role: parsed.maxRole,
				expires_at: at + parsed.ttlDays * DAY,
				last_used_at: null,
				revoked_at: null,
				created_by: owner,
				created_at: at,
			});
			audit({
				principal: owner,
				action: "agent.create",
				target: principal,
				data: {
					handle: parsed.name,
					tool: parsed.tool,
					node: node.id,
					maxRole: parsed.maxRole,
				},
			});
			appendPrincipalCreated(c, {
				principal,
				kind: "agent",
				handle: parsed.name,
				node: node.id,
				actor: { kind: "user", id: owner },
			});
		});
		return { principal, tokenId: t.id, token: t.secret };
	};

	/** Dev-only: `TARTAN_STAGE ^dev` and `TARTAN_DEV_TOOLS=1`, an admin user. */
	const bulkMintAgents = async (
		owner: string,
		input: {
			count: number;
			prefix: string;
			nodeId: string;
			maxRole: Role;
			ttlMs: number;
		},
	): Promise<{ principal: string; token: string }[]> => {
		if (!devToolsEnabled(c.env)) throw notFound("not found");
		const p = requireUser(owner);
		if (p.is_admin !== 1) throw denied("role", "bulk agents need an admin");
		if (
			!Number.isInteger(input.count) || input.count < 1 || input.count > 1000
		) {
			throw invalid("count is 1–1000");
		}
		if (!/^[a-z0-9-]{1,20}$/.test(input.prefix)) throw invalid("bad prefix");
		if (
			!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 60_000 ||
			input.ttlMs > 7 * DAY
		) {
			throw invalid("ttl is 1 min to 7 days");
		}
		const maxRole = parseInput(RoleSchema, input.maxRole);
		if (c.modules.tree.nodeSync(input.nodeId) === null) {
			throw notFound("no such node");
		}
		const at = now();
		const minted = await Promise.all(
			Array.from({ length: input.count }, () => mint("agent")),
		);
		return c.tx(() => {
			const out = minted.map((t, i) => {
				const handle = `${input.prefix}-${i + 1}`;
				const existing = store.principalByHandle(handle);
				if (
					existing !== null &&
					(existing.kind !== "agent" || existing.owner_user_id !== owner)
				) {
					throw conflict(`the handle ${handle} is taken`);
				}
				const principal = existing?.id ?? agentPrincipalId(c.ids.ulid());
				if (existing === null) {
					store.insertPrincipal(newPrincipal({
						id: principal,
						kind: "agent",
						handle,
						display: handle,
						owner_user_id: owner,
						agent_tool: "other",
						agent_model: "sim",
					}, at));
				}
				store.insertToken({
					id: t.id,
					hash: t.hash,
					kind: "agent",
					principal_id: principal,
					name: handle,
					scopes_json: JSON.stringify(DEFAULT_AGENT_SCOPES),
					node_id: input.nodeId,
					lane_id: null,
					max_role: maxRole,
					expires_at: at + input.ttlMs,
					last_used_at: null,
					revoked_at: null,
					created_by: owner,
					created_at: at,
				});
				return { principal, token: t.secret };
			});
			audit({
				principal: owner,
				action: "agents.bulk",
				data: { count: input.count, prefix: input.prefix, node: input.nodeId },
			});
			return out;
		});
	};

	/**
	 * Admin power for one request: the caller's scope-aware
	 * `AuthContext.isAdmin` AND an active admin row. The row flag alone never
	 * grants it, so a leaked token without the `admin` scope stays a user.
	 */
	const actsAsAdmin = (by: string, asAdmin: boolean | undefined): boolean => {
		if (asAdmin !== true) return false;
		const actor = store.principal(by);
		return isActive(actor) && actor.is_admin === 1;
	};

	const revokeToken = (
		tokenId: string,
		by: string,
		asAdmin?: boolean,
	): Promise<void> => {
		const at = now();
		c.tx(() => {
			const row = store.tokenById(tokenId);
			if (row === null) throw notFound("no such token");
			const holder = store.principal(row.principal_id);
			const allowed = by === row.principal_id ||
				(holder !== null && holder.owner_user_id === by) ||
				actsAsAdmin(by, asAdmin);
			if (!allowed) throw denied("role", "not your token");
			store.sql.exec(
				"UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
				at,
				tokenId,
			);
			audit({ principal: by, action: "token.revoke", target: tokenId });
		});
		return Promise.resolve();
	};

	const tokenDto = (t: TokenRow): TokenDto => ({
		id: t.id,
		kind: t.kind,
		principal: t.principal_id,
		name: t.name,
		scopes: parseScopes(t.scopes_json),
		nodeId: t.node_id,
		laneId: t.lane_id,
		maxRole: asRole(t.max_role),
		expiresAt: t.expires_at,
		lastUsedAt: t.last_used_at,
		revokedAt: t.revoked_at,
		createdAt: t.created_at,
	});

	const listTokens = (principal: string): Promise<TokenDto[]> =>
		Promise.resolve(
			store.sql.exec<TokenRow>(
				"SELECT * FROM tokens WHERE principal_id = ? ORDER BY created_at DESC",
				principal,
			).toArray().map(tokenDto),
		);

	const listAgents = (owner: string): Promise<AgentDto[]> => {
		const agents = store.sql.exec<PrincipalRow>(
			"SELECT * FROM principals WHERE kind = 'agent' AND owner_user_id = ? ORDER BY created_at DESC",
			owner,
		).toArray();
		return Promise.resolve(agents.map((a): AgentDto => ({
			id: a.id,
			handle: a.handle,
			display: a.display,
			...(a.agent_tool !== null ? { tool: a.agent_tool } : {}),
			...(a.agent_model !== null ? { model: a.agent_model } : {}),
			ownerUserId: owner,
			createdAt: a.created_at,
			disabled: a.disabled_at !== null,
			tokens: store.sql.exec<TokenRow>(
				"SELECT * FROM tokens WHERE principal_id = ? ORDER BY created_at DESC",
				a.id,
			).toArray().map((t) => ({
				id: t.id,
				maxRole: asRole(t.max_role),
				expiresAt: t.expires_at,
				...(t.last_used_at !== null ? { lastUsedAt: t.last_used_at } : {}),
				revoked: t.revoked_at !== null,
			})),
		})));
	};

	const disableAgent = (
		agent: string,
		by: string,
		asAdmin?: boolean,
	): Promise<void> => {
		const at = now();
		c.tx(() => {
			const a = store.principal(agent);
			if (a === null || a.kind !== "agent") throw notFound("no such agent");
			if (a.owner_user_id !== by && !actsAsAdmin(by, asAdmin)) {
				throw denied("role", "not your agent");
			}
			store.sql.exec(
				"UPDATE principals SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ?",
				at,
				agent,
			);
			store.sql.exec(
				"UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE principal_id = ?",
				at,
				agent,
			);
			audit({ principal: by, action: "agent.disable", target: agent });
		});
		return Promise.resolve();
	};

	// -------------------------------------------------------------------------
	// Invites
	// -------------------------------------------------------------------------

	const createInvite = async (
		by: string,
		input: InviteCreateRequest,
	): Promise<{ inviteId: string; code: string }> => {
		const at = now();
		const actor = requireUser(by);
		const parsed = parseInput(InviteCreateRequestSchema, input);
		const node = c.modules.tree.nodeByPathSync(parsed.node);
		if (node === null) throw notFound(`no node at ${parsed.node}`);
		const role = isOwner(by)
			? 50
			: c.modules.tree.effectiveRoleSync([by], node.id, at);
		if (role < 40) {
			throw denied("role", "inviting needs Maintainer or above at the node");
		}
		if (parsed.relinkPrincipal !== undefined) {
			if (actor.is_admin !== 1) {
				throw denied("role", "relink invites are for admins");
			}
			const target = store.principal(parsed.relinkPrincipal);
			if (!isActive(target) || target.kind !== "user") {
				throw notFound("the relink target is not an active user");
			}
		}
		const code = randomSecret();
		const codeHash = await sha256Hex(code);
		const id = `${ID_PREFIX.invite}${c.ids.ulid()}`;
		c.tx(() => {
			store.sql.exec(
				"INSERT INTO invites (id, code_hash, node_id, role, note, relink_principal, created_by, created_at, expires_at, used_at, used_by_issuer, used_by_sub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
				id,
				codeHash,
				node.id,
				parsed.role,
				parsed.note ?? null,
				parsed.relinkPrincipal ?? null,
				by,
				at,
				at + IDENTITY_TTL.inviteMs,
			);
			audit({
				principal: by,
				action: "invite.create",
				target: id,
				data: {
					node: node.id,
					role: parsed.role,
					relink: parsed.relinkPrincipal ?? null,
				},
			});
		});
		return { inviteId: id, code };
	};

	const inviteDto = (r: {
		id: string;
		node_id: string;
		role: number;
		note: string | null;
		relink_principal: string | null;
		created_by: string;
		created_at: number;
		expires_at: number;
		used_at: number | null;
	}): InviteDto => ({
		id: r.id,
		nodeId: r.node_id,
		role: r.role as InviteDto["role"],
		note: r.note,
		relinkPrincipal: r.relink_principal,
		createdBy: r.created_by,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		usedAt: r.used_at,
	});

	const listInvites = (
		by: string,
		asAdmin?: boolean,
	): Promise<InviteDto[]> => {
		const admin = actsAsAdmin(by, asAdmin);
		const rows = admin
			? store.sql.exec<Parameters<typeof inviteDto>[0]>(
				"SELECT * FROM invites ORDER BY created_at DESC",
			).toArray()
			: store.sql.exec<Parameters<typeof inviteDto>[0]>(
				"SELECT * FROM invites WHERE created_by = ? ORDER BY created_at DESC",
				by,
			).toArray();
		return Promise.resolve(rows.map(inviteDto));
	};

	const revokeInvite = (
		inviteId: string,
		by: string,
		asAdmin?: boolean,
	): Promise<void> => {
		const at = now();
		c.tx(() => {
			const invite = store.invite(inviteId);
			if (invite === null) throw notFound("no such invite");
			if (invite.created_by !== by && !actsAsAdmin(by, asAdmin)) {
				throw denied("role", "not your invite");
			}
			store.sql.exec(
				"UPDATE invites SET expires_at = MIN(expires_at, ?) WHERE id = ? AND used_at IS NULL",
				at,
				inviteId,
			);
			audit({ principal: by, action: "invite.revoke", target: inviteId });
		});
		return Promise.resolve();
	};

	const principal = (id: string): Promise<PrincipalRow | null> =>
		Promise.resolve(store.principal(id));

	const principalByHandle = (handle: string): Promise<PrincipalRow | null> =>
		Promise.resolve(store.principalByHandle(handle));

	const rateLimit = (
		key: string,
		limit: number,
		windowMs: number,
	): Promise<{ ok: boolean; retryAfterMs?: number }> => {
		if (typeof key !== "string" || key.length === 0 || key.length > 200) {
			throw invalid("bad rate-limit key");
		}
		if (
			!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) ||
			windowMs < 1000
		) {
			throw invalid("bad rate limit");
		}
		const at = now();
		return Promise.resolve(
			c.tx(() => store.hitRateLimit(key, limit, windowMs, at)),
		);
	};

	return {
		loginIdentity,
		createSession,
		session,
		deleteSession,
		token,
		createPat,
		createAgent,
		bulkMintAgents,
		revokeToken,
		listTokens,
		listAgents,
		disableAgent,
		createInvite,
		listInvites,
		revokeInvite,
		principal,
		principalByHandle,
		rateLimit,
		isOwner,
	};
};
