// The forge's one IdP (WP2): manual configuration, RFC 7591 registration from a
// pasted issuer, the RFC 7592 delete used by `deno task destroy`, the daily
// metadata refresh, and the client-auth JWKS for `private_key_jwt`.
//
// Secrets are sealed with the forge keyring before they are stored: the
// client secret as `(idp-secret, default)`, the DCR management credentials
// as `(idp-registration, default)`, private JWKs as `(key, <kid>)`.
// `OIDC_ISSUER` (+ `OIDC_CLIENT_ID`) pin the IdP (GitOps): manual entry must
// then name the same values and registration is refused.

import {
	conflict,
	IdpConfigRequestSchema,
	type IdpDeregisterResponse,
	IdpRegisterRequestSchema,
	invalid,
	notFound,
	SYS_KERNEL,
	tartanError,
} from "@tartan/contract";
import type { IdpRow } from "@tartan/contract/kernel.ts";
import type { IdentityContext } from "./context.ts";
import { constantTimeEqual, fromHex, sha256Hex } from "./crypto.ts";
import {
	deregisterClient,
	registerClient,
	type RegistrationManagement,
	registrationRequest,
} from "./dcr.ts";
import { parseInput } from "./input.ts";
import { type AuthorizationServer, discover } from "./oidc.ts";
import { DEFAULT_IDP_SCOPES, IDENTITY_TTL } from "./policy.ts";
import type { Setup } from "./setup.ts";
import type { IdpLoginConfig } from "./types.ts";

export const SEAL = {
	clientSecret: ["idp-secret", "default"],
	registration: ["idp-registration", "default"],
	key: (kid: string) => ["key", kid] as const,
	loginVerifier: (stateHash: string) => ["login-verifier", stateHash] as const,
} as const;

type IdpOptions = {
	readonly scopes?: string;
	readonly usernameClaim?: string;
	readonly allowedEmailDomains?: readonly string[];
	readonly jitProvisioning?: boolean;
};

const pinnedIdp = (
	env: IdentityContext["env"],
): { issuer: string; clientId: string | null } | null => {
	const issuer = (env.OIDC_ISSUER ?? "").trim();
	if (issuer === "") return null;
	const clientId = (env.OIDC_CLIENT_ID ?? "").trim();
	return { issuer, clientId: clientId === "" ? null : clientId };
};

export const createIdp = (c: IdentityContext, setup: Setup) => {
	const { store } = c;
	const now = () => c.clock.now();

	const rowOf = (
		as: AuthorizationServer,
		fields: Pick<
			IdpRow,
			| "issuer"
			| "client_id"
			| "client_auth"
			| "id_token_alg"
			| "client_secret_sealed"
			| "registration_sealed"
			| "source"
		>,
		options: IdpOptions,
		at: number,
	): IdpRow => ({
		id: "default",
		...fields,
		scopes: options.scopes ?? DEFAULT_IDP_SCOPES,
		metadata_json: JSON.stringify(as),
		discovered_at: at,
		username_claim: options.usernameClaim ?? "preferred_username",
		allowed_email_domains_json: options.allowedEmailDomains
			? JSON.stringify(options.allowedEmailDomains.map((d) => d.toLowerCase()))
			: null,
		jit_provisioning: options.jitProvisioning ? 1 : 0,
		verify_id_token_signature: 1,
		updated_at: at,
	});

	/** Moves `unlocked` to `idp`; later states keep theirs. */
	const markIdpConfigured = (): void => {
		const state = store.setupState();
		if (state === "fresh" || state === "unlocked") {
			store.setMeta("setup_state", "idp");
		}
	};

	/** An active ES256 client-auth key for `private_key_jwt` (created once). */
	const ensureClientKey = async (): Promise<void> => {
		if (store.activeClientKey() !== null) return;
		const pair = await crypto.subtle.generateKey(
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign", "verify"],
		) as CryptoKeyPair;
		const kid = `k_${c.ids.ulid()}`;
		const [privateJwk, publicJwk] = await Promise.all([
			crypto.subtle.exportKey("jwk", pair.privateKey),
			crypto.subtle.exportKey("jwk", pair.publicKey),
		]);
		const sealed = await (await c.keyring()).seal(
			...SEAL.key(kid),
			JSON.stringify(privateJwk),
		);
		const at = now();
		c.tx(() => {
			if (store.activeClientKey() !== null) return;
			store.sql.exec(
				"INSERT INTO keys (kid, alg, use, private_jwk_sealed, public_jwk, state, created_at) VALUES (?, 'ES256', 'client-auth', ?, ?, 'active', ?)",
				kid,
				sealed,
				JSON.stringify({
					kty: publicJwk.kty,
					crv: publicJwk.crv,
					x: publicJwk.x,
					y: publicJwk.y,
					kid,
					alg: "ES256",
					use: "sig",
				}),
				at,
			);
		});
	};

	/** Manual entry: a client id, its auth method and maybe a secret. */
	const configureIdp = async (
		input: unknown,
		session: string,
	): Promise<void> => {
		await setup.requireSetupSession(session);
		const parsed = parseInput(IdpConfigRequestSchema, input);
		const pin = pinnedIdp(c.env);
		if (
			pin !== null &&
			(parsed.issuer !== pin.issuer ||
				(pin.clientId !== null && parsed.clientId !== pin.clientId))
		) {
			throw conflict("the IdP is pinned by OIDC_ISSUER / OIDC_CLIENT_ID");
		}
		const confidential = parsed.clientAuth === "client_secret_basic" ||
			parsed.clientAuth === "client_secret_post";
		const envSecret = pin !== null && Boolean(c.env.OIDC_CLIENT_SECRET);
		if (confidential && parsed.clientSecret === undefined && !envSecret) {
			throw invalid(`${parsed.clientAuth} needs the client secret`);
		}
		if (!confidential && parsed.clientSecret !== undefined) {
			throw invalid(`${parsed.clientAuth} takes no client secret`);
		}
		const as = await discover(parsed.issuer, c.fetch);
		const keyring = await c.keyring();
		const secretSealed = parsed.clientSecret !== undefined
			? await keyring.seal(...SEAL.clientSecret, parsed.clientSecret)
			: null;
		if (parsed.clientAuth === "private_key_jwt") await ensureClientKey();
		const at = now();
		c.tx(() => {
			store.upsertIdp(rowOf(
				as,
				{
					issuer: parsed.issuer,
					client_id: parsed.clientId,
					client_auth: parsed.clientAuth,
					id_token_alg: "RS256",
					client_secret_sealed: secretSealed,
					registration_sealed: null,
					source: pin !== null ? "env" : "wizard",
				},
				parsed,
				at,
			));
			markIdpConfigured();
			c.modules.events.auditSync({
				principal: SYS_KERNEL,
				action: "idp.configure",
				data: {
					issuer: parsed.issuer,
					clientId: parsed.clientId,
					clientAuth: parsed.clientAuth,
				},
			});
		});
	};

	/**
	 * Discovery, then RFC 7591 registration with this forge's redirect URI;
	 * stores what the response returned. Shared by the wizard step and the
	 * re-registration after an origin change.
	 */
	const register = async (
		issuer: string,
		options: IdpOptions,
		initialAccessToken: string | undefined,
		action: "idp.register" | "idp.reregister",
	): Promise<{ clientId: string }> => {
		const origin = store.meta("canonical_origin");
		if (origin === null) {
			throw invalid("set the forge name and canonical origin first");
		}
		const as = await discover(issuer, c.fetch);
		if (typeof as.registration_endpoint !== "string") {
			throw tartanError(
				"unavailable",
				"the IdP has no registration endpoint; register a client and enter its id",
				{ reason: "dcr" },
			);
		}
		const scope = options.scopes ?? DEFAULT_IDP_SCOPES;
		const client = await registerClient(
			as.registration_endpoint,
			registrationRequest({
				forgeName: store.meta("forge_name") ?? "Tartan",
				redirectUri: `${origin}/-/auth/callback`,
				scope,
			}),
			{
				fetch: c.fetch,
				now: now(),
				...(initialAccessToken ? { initialAccessToken } : {}),
			},
		);
		const keyring = await c.keyring();
		const secretSealed = client.clientSecret !== undefined
			? await keyring.seal(...SEAL.clientSecret, client.clientSecret)
			: null;
		const registrationSealed = client.management !== undefined
			? await keyring.seal(
				...SEAL.registration,
				JSON.stringify(client.management),
			)
			: null;
		const at = now();
		c.tx(() => {
			store.upsertIdp(rowOf(
				as,
				{
					issuer,
					client_id: client.clientId,
					client_auth: client.clientAuth,
					id_token_alg: client.idTokenAlg,
					client_secret_sealed: secretSealed,
					registration_sealed: registrationSealed,
					source: "dcr",
				},
				{ ...options, scopes: scope },
				at,
			));
			markIdpConfigured();
			c.modules.events.auditSync({
				principal: SYS_KERNEL,
				action,
				data: {
					issuer,
					clientId: client.clientId,
					clientAuth: client.clientAuth,
					idTokenAlg: client.idTokenAlg,
					redirectUri: `${origin}/-/auth/callback`,
					managed: client.management !== undefined,
				},
			});
		});
		return { clientId: client.clientId };
	};

	/** "Paste the issuer URL": discovery, then RFC 7591 registration. */
	const registerIdp = async (
		input: unknown,
		session: string,
	): Promise<{ clientId: string }> => {
		await setup.requireSetupSession(session);
		const parsed = parseInput(IdpRegisterRequestSchema, input);
		if (pinnedIdp(c.env) !== null) {
			throw conflict("the IdP is pinned by OIDC_ISSUER; registration is off");
		}
		return await register(
			parsed.issuer,
			parsed,
			parsed.initialAccessToken,
			"idp.register",
		);
	};

	/**
	 * After the canonical origin changed: a
	 * DCR-registered client is registered again with the new redirect URI and
	 * the old registration is deleted (RFC 7592, best effort). A manually
	 * entered client is left alone; the wizard asks the owner to add the new
	 * redirect URI at the IdP.
	 */
	const reregisterForOrigin = async (): Promise<
		{ clientId: string; previous: string } | null
	> => {
		const row = store.idp();
		if (row === null || row.source !== "dcr") return null;
		const domains = row.allowed_email_domains_json === null
			? undefined
			: JSON.parse(row.allowed_email_domains_json) as string[];
		const { clientId } = await register(
			row.issuer,
			{
				scopes: row.scopes,
				usernameClaim: row.username_claim,
				...(domains ? { allowedEmailDomains: domains } : {}),
				jitProvisioning: row.jit_provisioning === 1,
			},
			undefined,
			"idp.reregister",
		);
		if (row.registration_sealed !== null) {
			const old = JSON.parse(
				await (await c.keyring()).open(
					...SEAL.registration,
					row.registration_sealed,
				),
			) as RegistrationManagement;
			const outcome = await deregisterClient(old, c.fetch);
			if (!outcome.ok) {
				c.log.error("[tartan] the previous DCR client was not deleted", {
					clientId: row.client_id,
					reason: outcome.reason ?? "",
				});
			}
		}
		return { clientId, previous: row.client_id };
	};

	/**
	 * `POST /-/admin/idp/deregister`: authorized only by the one-time
	 * `TARTAN_DESTROY_TOKEN` (absent ⇒ `not_found`), accepted once, then the
	 * RFC 7592 DELETE of the stored registration.
	 */
	const deregisterIdp = async (
		destroyTokenHash: string,
	): Promise<IdpDeregisterResponse> => {
		const token = c.env.TARTAN_DESTROY_TOKEN;
		if (!token) throw notFound("not found");
		const expected = await sha256Hex(token);
		if (
			typeof destroyTokenHash !== "string" ||
			!/^[0-9a-f]{64}$/.test(destroyTokenHash) ||
			!constantTimeEqual(fromHex(destroyTokenHash), fromHex(expected))
		) {
			throw tartanError("denied", "wrong destroy token", {
				reason: "destroy-token",
			});
		}
		const at = now();
		const row = c.tx(() => {
			const used = store.first<{ x: number }>(
				"SELECT 1 AS x FROM consumed_destroy_tokens WHERE hash = ?",
				expected,
			);
			if (used !== null) {
				throw tartanError("denied", "this destroy token was already used", {
					reason: "destroy-token",
				});
			}
			store.sql.exec(
				"INSERT INTO consumed_destroy_tokens (hash, consumed_at, outcome) VALUES (?, ?, 'pending')",
				expected,
				at,
			);
			return store.idp();
		});
		const finish = (
			response: IdpDeregisterResponse,
		): IdpDeregisterResponse => {
			c.tx(() => {
				store.sql.exec(
					"UPDATE consumed_destroy_tokens SET outcome = ? WHERE hash = ?",
					response.deregistered ? "deregistered" : response.reason ?? "no",
					expected,
				);
				if (response.deregistered) {
					store.sql.exec(
						"UPDATE idp SET registration_sealed = NULL, updated_at = ? WHERE id = 'default'",
						now(),
					);
				}
				c.modules.events.auditSync({
					principal: SYS_KERNEL,
					action: "idp.deregister",
					data: { ...response },
				});
			});
			return response;
		};
		if (row === null) {
			return finish({
				clientId: "",
				deregistered: false,
				reason: "no IdP is configured",
			});
		}
		if (row.registration_sealed === null) {
			return finish({
				clientId: row.client_id,
				deregistered: false,
				reason: "the IdP client was not registered by DCR",
			});
		}
		const management = JSON.parse(
			await (await c.keyring()).open(
				...SEAL.registration,
				row.registration_sealed,
			),
		) as RegistrationManagement;
		const outcome = await deregisterClient(management, c.fetch);
		return finish({
			clientId: row.client_id,
			deregistered: outcome.ok,
			...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
		});
	};

	const idp = (): Promise<IdpLoginConfig | null> => {
		const row = store.idp();
		if (row === null) return Promise.resolve(null);
		const key = row.client_auth === "private_key_jwt"
			? store.activeClientKey()
			: null;
		return Promise.resolve({
			...row,
			client_key: key === null ? null : {
				kid: key.kid,
				alg: key.alg,
				private_jwk_sealed: key.private_jwk_sealed,
			},
		});
	};

	const refreshIdp = async (): Promise<{ refreshed: boolean }> => {
		const row = store.idp();
		if (row === null || now() - row.discovered_at < IDENTITY_TTL.idpRefreshMs) {
			return { refreshed: false };
		}
		const as = await discover(row.issuer, c.fetch);
		const at = now();
		c.tx(() => {
			store.sql.exec(
				"UPDATE idp SET metadata_json = ?, discovered_at = ?, updated_at = ? WHERE id = 'default' AND issuer = ?",
				JSON.stringify(as),
				at,
				at,
				row.issuer,
			);
		});
		return { refreshed: true };
	};

	const jwks = (): Promise<{ keys: unknown[] }> =>
		Promise.resolve({
			keys: store.sql.exec<{ public_jwk: string }>(
				"SELECT public_jwk FROM keys WHERE use = 'client-auth' AND state IN ('active', 'retiring') ORDER BY created_at",
			).toArray().map((r) => JSON.parse(r.public_jwk) as unknown),
		});

	return {
		configureIdp,
		registerIdp,
		reregisterForOrigin,
		deregisterIdp,
		idp,
		refreshIdp,
		jwks,
	};
};
