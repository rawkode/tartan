// HTTP handlers of identity and setup (WP2). The security middleware has
// already applied the route policy (host, setup gating, authentication, CSRF);
// these handlers do the rest.
//
// `createIdentityRoutes(options)` builds the handlers; the exports below are
// the production ones `src/router.ts` mounts. Tests build their own with a
// mock IdP's fetch.

import {
	type AgentCreatedResponse,
	AgentCreateRequestSchema,
	type AgentDto,
	BulkAgentsRequestSchema,
	COOKIE,
	denied,
	FORGE_DO_NAME,
	fromRpcError,
	IdpConfigRequestSchema,
	IdpRegisterRequestSchema,
	invalid,
	type InviteCreated,
	InviteCreateRequestSchema,
	notFound,
	PackChoiceRequestSchema,
	PatCreateRequestSchema,
	rateLimited,
	SetupNameRequestSchema,
	tartanError,
	unauthenticated,
	UnlockRequestSchema,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { clearCookie, cookieOf, hostCookie } from "../http/cookies.ts";
import {
	forgeIdentity,
	forgetPrincipalTokens,
	forgetToken,
	invalidateSetupInfo,
	isolateKeyring,
	setupInfo,
} from "../http/isolate.ts";
import {
	clientIpHash,
	errorPage,
	json,
	noContent,
	readJson,
	safeReturnTo,
} from "../http/respond.ts";
import { AVATAR_HEADERS, avatarSvg } from "./avatar.ts";
import { originCheck } from "./checks.ts";
import { randomSecret, sha256Hex } from "./crypto.ts";
import { SEAL } from "./idp.ts";
import type { Keyring } from "./keyring.ts";
import {
	type AuthorizationServer,
	authorizationUrl,
	exchangeCode,
	type IdTokenClaims,
	pkcePair,
	randomNonce,
	randomState,
	type RelyingParty,
} from "./oidc.ts";
import { IDENTITY_TTL, RATE_LIMITS, rateKey } from "./policy.ts";
import { devToolsEnabled } from "./principals.ts";
import { setupSecretHash } from "./setup.ts";
import { createGuardedFetch, type FetchLike } from "./ssrf.ts";
import type { IdpLoginConfig } from "./types.ts";

const DAY = 86_400_000;
const LOGIN_COOKIE_HASH_CHARS = 24;
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export type IdentityRoutesOptions = {
	/** The base fetch behind the SSRF guard for the token exchange (tests: a mock IdP). */
	readonly fetch?: FetchLike;
	readonly now?: () => number;
	/** `/-/auth/login`'s bound on its ForgeDO reads and writes (tests shorten it). */
	readonly loginDeadlineMs?: number;
};

/**
 * `/-/auth/login` answers within this long: its reads and writes go to
 * ForgeDO one after another, and a busy ForgeDO held the route for more
 * than 30 s with no answer (agent smoke). It now fails with 503 "try
 * again" instead.
 */
export const LOGIN_DEADLINE_MS = 15_000;

const withinDeadline = <T>(
	work: Promise<T>,
	ms: number,
	what: string,
): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					tartanError(
						"unavailable",
						`${what}: the forge did not answer within ${
							Math.round(ms / 1000)
						} s; try again`,
					),
				),
			ms,
		);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
};

const forgeTree = (env: Env) => env.FORGE.getByName(FORGE_DO_NAME).tree();

/** The canonical origin, or this request's origin before step 5. */
const canonicalOf = async (env: Env, url: URL): Promise<string> =>
	(await setupInfo(env)).canonicalOrigin ?? url.origin;

const requireAuth = (auth: AuthContext | null): AuthContext => {
	if (auth === null) throw unauthenticated();
	return auth;
};

/** Creating tokens, agents and invites is for a signed-in human in the browser. */
const requireSessionUser = (auth: AuthContext | null): AuthContext => {
	const a = requireAuth(auth);
	if (a.via !== "session" || a.kind !== "user") {
		throw denied("scopes", "use a browser session for this");
	}
	return a;
};

const restId = (c: RouteContext): string | null => {
	const rest = c.params.rest;
	return rest === undefined || rest === "" ? null : rest;
};

const methodNotAllowed = (allow: readonly string[]): Response =>
	json(
		{ error: "invalid", reason: "method", message: "method not allowed" },
		405,
		{ allow: allow.join(", ") },
	);

/** A node path → its id through WP3's `TreeFacade.resolvePath`. */
const nodeIdOf = async (env: Env, path: string): Promise<string> => {
	const resolved = await forgeTree(env).resolvePath(path);
	if (resolved === null || resolved.rest !== "") {
		throw notFound(`no node at ${path}`);
	}
	return resolved.node.id;
};

/** The ID-token claims Tartan keeps (`username_claim` names the handle). */
export const identityOf = (
	claims: IdTokenClaims,
	usernameClaim: string,
) => {
	const str = (v: unknown): string | undefined =>
		typeof v === "string" && v !== "" ? v : undefined;
	const handle = str(claims[usernameClaim]) ?? str(claims.preferred_username) ??
		str(claims.email) ?? claims.sub;
	const email = str(claims.email);
	return {
		issuer: claims.iss,
		sub: claims.sub,
		handle,
		display: str(claims.name) ?? handle,
		...(email !== undefined ? { email } : {}),
		emailVerified: claims.email_verified === true,
	};
};

/** The relying party of the stored IdP row: secret unsealed, private key imported non-extractable. */
export const relyingPartyOf = async (
	idp: IdpLoginConfig,
	keyring: Keyring,
	env: Env,
): Promise<RelyingParty> => {
	const clientSecret = idp.client_secret_sealed !== null
		? await keyring.open(...SEAL.clientSecret, idp.client_secret_sealed)
		: idp.source === "env"
		? env.OIDC_CLIENT_SECRET
		: undefined;
	let privateKey: RelyingParty["privateKey"];
	if (idp.client_auth === "private_key_jwt" && idp.client_key !== null) {
		const jwk = JSON.parse(
			await keyring.open(
				...SEAL.key(idp.client_key.kid),
				idp.client_key.private_jwk_sealed,
			),
		) as JsonWebKey;
		privateKey = {
			kid: idp.client_key.kid,
			key: await crypto.subtle.importKey(
				"jwk",
				jwk,
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["sign"],
			),
		};
	}
	return {
		clientId: idp.client_id,
		clientAuth: idp.client_auth,
		idTokenAlg: idp.id_token_alg,
		...(clientSecret ? { clientSecret } : {}),
		...(privateKey ? { privateKey } : {}),
	};
};

export const createIdentityRoutes = (options: IdentityRoutesOptions = {}) => {
	const fetchFn = createGuardedFetch(options.fetch);
	const now = options.now ?? (() => Date.now());

	// -------------------------------------------------------------------------
	// /-/setup/*: POST only; the wizard page itself is the SPA.
	// -------------------------------------------------------------------------

	const setupCookieOf = (req: Request): string =>
		cookieOf(req, COOKIE.setup) ?? "";

	const unlockWith = async (
		c: RouteContext,
		purpose: "bootstrap" | "recover",
	): Promise<Response> => {
		const body = await readJson(c.req, UnlockRequestSchema);
		const result = await forgeIdentity(c.env).unlock({
			token: body.token,
			purpose,
			ipHash: await clientIpHash(c.req),
		});
		invalidateSetupInfo();
		return json(
			{ ok: true, purpose, expiresAt: result.expiresAt },
			200,
			{
				"set-cookie": hostCookie(
					COOKIE.setup,
					result.sessionCookie,
					(result.expiresAt - now()) / 1000,
				),
			},
		);
	};

	const handleSetupApi: RouteHandler = async (c) => {
		if (c.req.method !== "POST") return methodNotAllowed(["POST"]);
		const identity = forgeIdentity(c.env);
		const session = setupCookieOf(c.req);
		switch (c.params.rest ?? "") {
			case "status": {
				const [state, held] = await Promise.all([
					identity.setupState(),
					session === "" ? null : identity.setupSession(session),
				]);
				return json({ ...state, session: held });
			}
			case "code": {
				const limit = await identity.rateLimit(
					rateKey.setupCode(await clientIpHash(c.req)),
					RATE_LIMITS.setupCodePerIp.limit,
					RATE_LIMITS.setupCodePerIp.windowMs,
				);
				if (!limit.ok) {
					throw rateLimited("too many code requests", limit.retryAfterMs);
				}
				return json(await identity.ensureBootstrapCode());
			}
			case "unlock":
				return await unlockWith(c, "bootstrap");
			case "recover":
				return await unlockWith(c, "recover");
			case "checks": {
				if ((await identity.setupSession(session)) === null) {
					throw unauthenticated("a setup session is required: unlock first");
				}
				const checks = await identity.environmentChecks();
				return json({ checks: [...checks, originCheck(c.url.origin)] });
			}
			case "name": {
				const body = await readJson(c.req, SetupNameRequestSchema);
				const state = await identity.setName(body, session);
				invalidateSetupInfo();
				return json(state);
			}
			case "idp/register": {
				const body = await readJson(c.req, IdpRegisterRequestSchema);
				try {
					return json(await identity.registerIdp(body, session));
				} catch (error) {
					const e = fromRpcError(error);
					if (e.code !== "unavailable") throw e;
					// The wizard falls back to manual entry with this redirect URI.
					throw tartanError("unavailable", e.text, {
						reason: "dcr",
						details: {
							fallback: "manual",
							redirectUri: `${await canonicalOf(c.env, c.url)}/-/auth/callback`,
						},
					});
				}
			}
			case "idp": {
				const body = await readJson(c.req, IdpConfigRequestSchema);
				await identity.configureIdp(body, session);
				return json({ ok: true });
			}
			case "pack": {
				// Step 8 is the owner's, after the claim, through `/-/api/installations` (WP7a).
				await readJson(c.req, PackChoiceRequestSchema);
				throw invalid("choose the pack after signing in (Admin → Extensions)");
			}
			default:
				throw notFound("no such setup step");
		}
	};

	// -------------------------------------------------------------------------
	// OIDC relying party
	// -------------------------------------------------------------------------

	const loginCookieName = (stateHash: string) =>
		`${COOKIE.loginPrefix}${stateHash.slice(0, LOGIN_COOKIE_HASH_CHARS)}`;

	const loginDeadline = options.loginDeadlineMs ?? LOGIN_DEADLINE_MS;
	const handleLogin: RouteHandler = (c) =>
		withinDeadline(Promise.resolve(startLogin(c)), loginDeadline, "sign-in");

	const startLogin = async (c: RouteContext): Promise<Response> => {
		const { env, url, req } = c;
		const info = await setupInfo(env);
		// The redirect URI is on the canonical origin, so the login cookie must be too.
		if (info.canonicalOrigin !== null && url.origin !== info.canonicalOrigin) {
			return new Response(null, {
				status: 302,
				headers: {
					location: `${info.canonicalOrigin}${url.pathname}${url.search}`,
				},
			});
		}
		const canonical = info.canonicalOrigin ?? url.origin;
		const identity = forgeIdentity(env);
		const limit = await identity.rateLimit(
			rateKey.loginIp(await clientIpHash(req)),
			RATE_LIMITS.loginPerIp.limit,
			RATE_LIMITS.loginPerIp.windowMs,
		);
		if (!limit.ok) {
			throw rateLimited("too many sign-in attempts", limit.retryAfterMs);
		}

		let purpose: "login" | "bootstrap" | "recover" = "login";
		const wanted = url.searchParams.get("purpose");
		if (info.state !== "done" || wanted === "recover") {
			const session = await identity.setupSession(
				cookieOf(req, COOKIE.setup) ?? "",
			);
			if (session === null) {
				throw denied(
					"scopes",
					"unlock setup first: this sign-in needs a setup session",
				);
			}
			purpose = session.purpose;
		}
		const idp = await identity.idp();
		if (idp === null) {
			throw tartanError("unavailable", "no IdP is configured yet");
		}
		const invite = url.searchParams.get("invite");
		if (invite !== null && !INVITE_CODE_RE.test(invite)) {
			throw invalid("bad invite code");
		}

		const state = randomState();
		const nonce = randomNonce();
		const binding = randomSecret();
		const pkce = await pkcePair();
		const [stateHash, bindingHash, inviteHash, keyring] = await Promise.all([
			sha256Hex(state),
			sha256Hex(binding),
			invite === null ? Promise.resolve(null) : sha256Hex(invite),
			isolateKeyring(env),
		]);
		await identity.putLoginTxn({
			state_hash: stateHash,
			binding_hash: bindingHash,
			purpose,
			verifier_sealed: await keyring.seal(
				...SEAL.loginVerifier(stateHash),
				pkce.verifier,
			),
			nonce,
			return_to: safeReturnTo(url.searchParams.get("return_to")),
			expires_at: now() + IDENTITY_TTL.loginTxnMs,
			invite_hash: inviteHash,
		});
		const location = authorizationUrl(
			JSON.parse(idp.metadata_json) as AuthorizationServer,
			{
				clientId: idp.client_id,
				redirectUri: `${canonical}/-/auth/callback`,
				scope: idp.scopes,
				state,
				nonce,
				codeChallenge: pkce.challenge,
			},
		);
		return new Response(null, {
			status: 302,
			headers: {
				location: location.href,
				"set-cookie": hostCookie(
					loginCookieName(stateHash),
					binding,
					IDENTITY_TTL.loginTxnMs / 1000,
				),
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	};

	const handleCallback: RouteHandler = async (c) => {
		const { env, url, req } = c;
		const cleared: string[] = [];
		const fail = (status: number, title: string, message: string) => {
			const headers = new Headers();
			for (const cookie of cleared) headers.append("set-cookie", cookie);
			return errorPage(status, title, message, headers);
		};
		const state = url.searchParams.get("state");
		if (state === null || state.length > 512) {
			return fail(400, "Sign-in failed", "The sign-in response has no state.");
		}
		const stateHash = await sha256Hex(state);
		const cookieName = loginCookieName(stateHash);
		cleared.push(clearCookie(cookieName));
		const binding = cookieOf(req, cookieName);
		if (binding === null) {
			return fail(
				400,
				"Sign-in expired",
				"This sign-in was started in another browser or has expired. Start again.",
			);
		}
		const identity = forgeIdentity(env);
		const txn = await identity.consumeLoginTxn(
			stateHash,
			await sha256Hex(binding),
		);
		if (txn === null) {
			return fail(
				400,
				"Sign-in expired",
				"This sign-in was already used or has expired. Start again.",
			);
		}
		try {
			const idp = await identity.idp();
			if (idp === null) {
				throw tartanError("unavailable", "no IdP is configured");
			}
			const keyring = await isolateKeyring(env);
			const canonical = await canonicalOf(env, url);
			const claims = await exchangeCode({
				as: JSON.parse(idp.metadata_json) as AuthorizationServer,
				rp: await relyingPartyOf(idp, keyring, env),
				callback: url,
				redirectUri: `${canonical}/-/auth/callback`,
				state,
				codeVerifier: await keyring.open(
					...SEAL.loginVerifier(stateHash),
					txn.verifier_sealed,
				),
				nonce: txn.nonce,
				verifySignature: idp.verify_id_token_signature === 1,
				fetch: fetchFn,
			});
			if (claims.iss !== idp.issuer) {
				throw invalid("the ID token's issuer is not the IdP's");
			}
			const who = identityOf(claims, idp.username_claim);
			let principal: string | null = null;
			if (txn.purpose === "bootstrap") {
				const session = await identity.setupSession(
					cookieOf(req, COOKIE.setup) ?? "",
				);
				if (session?.purpose !== "bootstrap") {
					throw denied("scopes", "the setup session has expired: unlock again");
				}
				const tokenHash = env.TARTAN_SETUP_TOKEN
					? await setupSecretHash(env.TARTAN_SETUP_TOKEN)
					: null;
				try {
					principal = (await identity.claimOwner(
						{
							issuer: who.issuer,
							sub: who.sub,
							handle: who.handle,
							display: who.display,
							...(who.email !== undefined ? { email: who.email } : {}),
						},
						tokenHash,
					)).principal;
				} catch (error) {
					const e = fromRpcError(error);
					// The claim stands; WP3 could not create the root node (logged by ForgeDO).
					if (e.code !== "unavailable" || e.reason !== "owner-root") throw e;
					principal = (await identity.loginIdentity(who, null))?.principal ??
						null;
				}
				invalidateSetupInfo();
				cleared.push(clearCookie(COOKIE.setup));
			} else {
				principal =
					(await identity.loginIdentity(who, txn.invite_hash))?.principal ??
						null;
				if (txn.purpose === "recover") cleared.push(clearCookie(COOKIE.setup));
			}
			if (principal === null) {
				return fail(
					403,
					"No account here yet",
					"You signed in, but this forge has no account for you. Ask the owner for an invite link.",
				);
			}
			const sid = typeof claims.sid === "string" ? claims.sid : null;
			const session = await identity.createSession(principal, sid);
			const headers = new Headers({
				location: txn.return_to,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
			for (const cookie of cleared) headers.append("set-cookie", cookie);
			headers.append(
				"set-cookie",
				hostCookie(
					COOKIE.session,
					session.cookie,
					(session.expiresAt - now()) / 1000,
				),
			);
			return new Response(null, { status: 303, headers });
		} catch (error) {
			const e = fromRpcError(error);
			if (e.code === "internal") {
				console.error("[tartan] login callback failed", e.message);
				return fail(
					500,
					"Sign-in failed",
					"Something went wrong. Start again.",
				);
			}
			return fail(e.code === "denied" ? 403 : 400, "Sign-in failed", e.text);
		}
	};

	const handleLogout: RouteHandler = async (c) => {
		const cookie = cookieOf(c.req, COOKIE.session);
		const identity = forgeIdentity(c.env);
		if (cookie !== null && cookie !== "") {
			await identity.deleteSession(await sha256Hex(cookie));
		}
		const idp = await identity.idp();
		const end = idp === null
			? undefined
			: (JSON.parse(idp.metadata_json) as AuthorizationServer)
				.end_session_endpoint;
		const endSessionUrl = typeof end === "string" && idp !== null
			? `${end}${end.includes("?") ? "&" : "?"}client_id=${
				encodeURIComponent(idp.client_id)
			}`
			: undefined;
		return json(
			{ ok: true, ...(endSessionUrl ? { endSessionUrl } : {}) },
			200,
			{ "set-cookie": clearCookie(COOKIE.session) },
		);
	};

	const handleJwks: RouteHandler = async (c) =>
		json(await forgeIdentity(c.env).jwks(), 200, {
			"cache-control": "public, max-age=300",
		});

	/** `deno task destroy`: 404 unless `TARTAN_DESTROY_TOKEN` is set. */
	const handleIdpDeregister: RouteHandler = async (c) => {
		if (!c.env.TARTAN_DESTROY_TOKEN) throw notFound("not found");
		const m = /^Bearer\s+(\S+)$/i.exec(
			c.req.headers.get("authorization") ?? "",
		);
		if (m === null) {
			throw tartanError("denied", "the destroy token is required", {
				reason: "destroy-token",
			});
		}
		return json(
			await forgeIdentity(c.env).deregisterIdp(await sha256Hex(m[1])),
		);
	};

	const handleAvatar: RouteHandler = async (c) => {
		const id = c.params.principal ?? "";
		const p = await forgeIdentity(c.env).principal(id);
		if (p === null) throw notFound("no such principal");
		return new Response(avatarSvg(p.id, p.display || p.handle), {
			headers: AVATAR_HEADERS,
		});
	};

	const handleMe: RouteHandler = async (c) => {
		if (c.auth === null) return json({ principal: null });
		const identity = forgeIdentity(c.env);
		const [p, state] = await Promise.all([
			identity.principal(c.auth.principal),
			identity.setupState(),
		]);
		if (p === null) throw unauthenticated();
		return json({
			principal: {
				id: p.id,
				kind: p.kind,
				handle: p.handle,
				display: p.display,
				...(p.email !== null ? { email: p.email } : {}),
				avatar: `/-/avatar/${p.id}`,
			},
			auth: {
				via: c.auth.via,
				isAdmin: c.auth.isAdmin,
				scopes: c.auth.scopes,
				nodeId: c.auth.nodeId,
				laneId: c.auth.laneId,
				maxRole: c.auth.maxRole,
				...(c.auth.tokenId ? { tokenId: c.auth.tokenId } : {}),
				...(c.auth.expiresAt ? { expiresAt: c.auth.expiresAt } : {}),
			},
			forge: {
				...(state.forgeName ? { name: state.forgeName } : {}),
				rootKeyFallback: state.rootKeyFallback,
				...(state.recoveryBannerUntil
					? { recoveryBannerUntil: state.recoveryBannerUntil }
					: {}),
				devTools: devToolsEnabled(c.env),
			},
		});
	};

	// -------------------------------------------------------------------------
	// Tokens, agents, invites
	// -------------------------------------------------------------------------

	const handleTokens: RouteHandler = async (c) => {
		const auth = requireAuth(c.auth);
		const identity = forgeIdentity(c.env);
		const id = restId(c);
		if (c.req.method === "GET" && id === null) {
			const tokens = await identity.listTokens(auth.principal);
			return json({ tokens: tokens.filter((t) => t.kind === "pat") });
		}
		if (c.req.method === "POST" && id === null) {
			const user = requireSessionUser(c.auth);
			const body = await readJson(c.req, PatCreateRequestSchema);
			const expiresAt = now() + body.expiresInDays * DAY;
			const created = await identity.createPat(user.principal, {
				name: body.name,
				scopes: body.scopes,
				...(body.node !== undefined
					? { nodeId: await nodeIdOf(c.env, body.node) }
					: {}),
				maxRole: body.maxRole ?? 50,
				expiresAt,
			});
			return json({ ...created, expiresAt }, 201);
		}
		if (c.req.method === "DELETE" && id !== null) {
			await identity.revokeToken(id, auth.principal, auth.isAdmin);
			forgetToken(id);
			return noContent();
		}
		return methodNotAllowed(id === null ? ["GET", "POST"] : ["DELETE"]);
	};

	const snippets = (canonical: string, node: string) => {
		const mcp = `${canonical}/-/mcp/${node}`;
		return {
			claudeCode:
				`claude mcp add --transport http tartan ${mcp} --header "Authorization: Bearer $TARTAN_TOKEN"`,
			codex:
				`[mcp_servers.tartan]\nurl = "${mcp}"\nbearer_token_env_var = "TARTAN_TOKEN"`,
			gitCredential:
				`git config --global credential.${canonical}.helper '!f() { echo username=agent; echo "password=$TARTAN_TOKEN"; }; f'`,
		};
	};

	const handleAgents: RouteHandler = async (c) => {
		const auth = requireAuth(c.auth);
		const identity = forgeIdentity(c.env);
		const id = restId(c);
		if (c.req.method === "GET" && id === null) {
			return json({ agents: await identity.listAgents(auth.principal) });
		}
		if (c.req.method === "POST" && id === null) {
			const user = requireSessionUser(c.auth);
			const body = await readJson(c.req, AgentCreateRequestSchema);
			const created = await identity.createAgent(user.principal, body);
			const at = now();
			const agent: AgentDto = {
				id: created.principal,
				handle: body.name,
				display: body.name,
				tool: body.tool,
				...(body.model !== undefined ? { model: body.model } : {}),
				ownerUserId: user.principal,
				createdAt: at,
				disabled: false,
				tokens: [{
					id: created.tokenId,
					nodePath: body.node,
					maxRole: body.maxRole,
					expiresAt: at + body.ttlDays * DAY,
					revoked: false,
				}],
			};
			const response: AgentCreatedResponse = {
				agent,
				token: created.token,
				snippets: snippets(await canonicalOf(c.env, c.url), body.node),
			};
			return json(response, 201);
		}
		if (c.req.method === "DELETE" && id !== null) {
			await identity.disableAgent(id, auth.principal, auth.isAdmin);
			forgetPrincipalTokens(id);
			return noContent();
		}
		return methodNotAllowed(id === null ? ["GET", "POST"] : ["DELETE"]);
	};

	/** Dev-only: 404 unless `TARTAN_STAGE ^dev` and `TARTAN_DEV_TOOLS=1`. */
	const handleAgentsBulk: RouteHandler = async (c) => {
		if (!devToolsEnabled(c.env)) throw notFound("not found");
		const user = requireSessionUser(c.auth);
		if (!user.isAdmin) throw denied("role", "bulk agents need an admin");
		const body = await readJson(c.req, BulkAgentsRequestSchema);
		const agents = await forgeIdentity(c.env).bulkMintAgents(user.principal, {
			count: body.count,
			prefix: body.prefix,
			nodeId: await nodeIdOf(c.env, body.node),
			maxRole: body.maxRole,
			ttlMs: body.ttlDays * DAY,
		});
		return json({ agents }, 201);
	};

	const handleInvites: RouteHandler = async (c) => {
		const auth = requireAuth(c.auth);
		const identity = forgeIdentity(c.env);
		const id = restId(c);
		if (c.req.method === "GET" && id === null) {
			return json({
				invites: await identity.listInvites(auth.principal, auth.isAdmin),
			});
		}
		if (c.req.method === "POST" && id === null) {
			const user = requireSessionUser(c.auth);
			const body = await readJson(c.req, InviteCreateRequestSchema);
			const created = await identity.createInvite(user.principal, body);
			const response: InviteCreated = {
				inviteId: created.inviteId,
				url: `${await canonicalOf(c.env, c.url)}/-/invite/${created.code}`,
				expiresAt: now() + IDENTITY_TTL.inviteMs,
			};
			return json(response, 201);
		}
		if (c.req.method === "DELETE" && id !== null) {
			await identity.revokeInvite(id, auth.principal, auth.isAdmin);
			return noContent();
		}
		return methodNotAllowed(id === null ? ["GET", "POST"] : ["DELETE"]);
	};

	return {
		handleSetupApi,
		handleLogin,
		handleCallback,
		handleLogout,
		handleJwks,
		handleIdpDeregister,
		handleAvatar,
		handleMe,
		handleTokens,
		handleAgents,
		handleAgentsBulk,
		handleInvites,
	};
};

export type IdentityRoutes = ReturnType<typeof createIdentityRoutes>;

const routes = createIdentityRoutes();

/** `POST|PUT|PATCH|DELETE /-/setup[/*]`: status, code, unlock, recover, checks, name, IdP. GET is the SPA wizard. */
export const handleSetupApi: RouteHandler = routes.handleSetupApi;

/** `GET /-/auth/login?return_to=…[&invite=…][&purpose=recover]`. */
export const handleLogin: RouteHandler = routes.handleLogin;

/** `GET /-/auth/callback?code&state[&iss]`. */
export const handleCallback: RouteHandler = routes.handleCallback;

/** `POST /-/auth/logout` (same-origin). */
export const handleLogout: RouteHandler = routes.handleLogout;

/** `GET /-/auth/jwks.json`: public keys for `private_key_jwt`. */
export const handleJwks: RouteHandler = routes.handleJwks;

/**
 * `POST /-/admin/idp/deregister`: RFC 7592 deletion of this stage's DCR
 * client, authorized once by `TARTAN_DESTROY_TOKEN` (`Authorization:
 * Bearer`); 404 when it is unset.
 */
export const handleIdpDeregister: RouteHandler = routes.handleIdpDeregister;

/** `GET /-/avatar/<principal>`: a kernel-drawn avatar. */
export const handleAvatar: RouteHandler = routes.handleAvatar;

/** `GET /-/api/me`: the signed-in principal for the SPA. */
export const handleMe: RouteHandler = routes.handleMe;

/** `/-/api/tokens[/<id>]`: PAT create, list, revoke. */
export const handleTokens: RouteHandler = routes.handleTokens;

/** `/-/api/agents[/<id>]`: agent principals and `tagt_` tokens. */
export const handleAgents: RouteHandler = routes.handleAgents;

/** `POST /-/api/agents/bulk`: dev-only bulk mint; 404 unless `TARTAN_STAGE ^dev` and `TARTAN_DEV_TOOLS=1`. */
export const handleAgentsBulk: RouteHandler = routes.handleAgentsBulk;

/** `/-/api/invites[/<id>]`: single-use invite links. */
export const handleInvites: RouteHandler = routes.handleInvites;
