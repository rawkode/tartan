// The setup state machine (WP2): `fresh` → `unlocked` (a setup token or a logs
// claim code proved control of the account) → `idp` (an IdP is configured) →
// `done` (the first owner claimed the forge). Recovery keeps `done`.
//
// The deployed `TARTAN_SETUP_TOKEN` is single-use. The claim records its
// SHA-256 in `consumed_setup_secrets`, and a consumed value is refused by
// every endpoint forever; recovery needs a NEW value (consumed when it
// unlocks) or a single-use logs code. Unlock attempts are limited per IP
// hash (5 / 10 min) under a global ceiling (50 / 10 min), so one address
// exhausting its budget does not lock out another.

import {
	conflict,
	invalid,
	rateLimited,
	RESERVED_ROOT_SLUGS,
	SetupNameRequestSchema,
	type SetupStateDto,
	SYS_KERNEL,
	type TartanError,
	tartanError,
	unauthenticated,
	userId,
} from "@tartan/contract";
import type { SessionRow } from "@tartan/contract/kernel.ts";
import { generateClaimCode, handleFrom, normalizeSetupInput } from "./codes.ts";
import type { IdentityContext } from "./context.ts";
import { randomSecret, secretsEqual, sha256Hex } from "./crypto.ts";
import { appendPrincipalCreated } from "./events.ts";
import { parseInput } from "./input.ts";
import { IDENTITY_TTL, RATE_LIMITS, rateKey } from "./policy.ts";
import type { SetNameInput, SetupSessionInfo } from "./types.ts";

/** The hash under which a setup token or claim code is stored and consumed. */
export const setupSecretHash = (value: string): Promise<string> =>
	sha256Hex(normalizeSetupInput(value));

const setupDenied = (text: string): TartanError =>
	tartanError("denied", text, { reason: "setup" });

/** The owner's root slug: the handle, unless it is a reserved root slug. */
export const rootSlugFor = (handle: string): string =>
	(RESERVED_ROOT_SLUGS as readonly string[]).includes(handle)
		? `${handle}-home`
		: handle;

export type ClaimIdentity = {
	issuer: string;
	sub: string;
	handle: string;
	display: string;
	email?: string;
};

export const createSetup = (c: IdentityContext) => {
	const { store } = c;
	const now = () => c.clock.now();

	const setupState = (): SetupStateDto => {
		const forgeName = store.meta("forge_name");
		const canonicalOrigin = store.meta("canonical_origin");
		const banner = Number(store.meta("recovery_banner_until") ?? "0");
		return {
			state: store.setupState(),
			...(forgeName !== null ? { forgeName } : {}),
			...(canonicalOrigin !== null ? { canonicalOrigin } : {}),
			...(banner > now() ? { recoveryBannerUntil: banner } : {}),
			rootKeyFallback: !c.env.TARTAN_SECRET,
		};
	};

	const setupSessionRow = async (
		cookie: string,
	): Promise<SessionRow | null> => {
		if (typeof cookie !== "string" || cookie.length < 16) return null;
		const row = store.sessionRow(await sha256Hex(cookie));
		return row !== null && row.kind === "setup" &&
				row.absolute_expires_at > now()
			? row
			: null;
	};

	const requireSetupSession = async (cookie: string): Promise<SessionRow> => {
		const row = await setupSessionRow(cookie);
		if (row === null) {
			throw unauthenticated("a setup session is required: unlock first");
		}
		return row;
	};

	const setupSession = async (
		cookie: string,
	): Promise<SetupSessionInfo | null> => {
		const row = await setupSessionRow(cookie);
		return row === null ? null : {
			purpose: store.setupState() === "done" ? "recover" : "bootstrap",
			expiresAt: row.absolute_expires_at,
		};
	};

	const validLogsCode = (purpose: "bootstrap" | "recover", at: number) =>
		store.first<{ x: number }>(
			"SELECT 1 AS x FROM setup_codes WHERE purpose = ? AND source = 'logs' AND used_at IS NULL AND expires_at > ?",
			purpose,
			at,
		) !== null;

	/**
	 * Without `TARTAN_SETUP_TOKEN`, a single-use claim code is
	 * generated (when no valid one exists) and written to Workers Logs only.
	 */
	const ensureBootstrapCode = async (): Promise<{ created: boolean }> => {
		if (c.env.TARTAN_SETUP_TOKEN) return { created: false };
		const at = now();
		if (store.setupState() === "done" || validLogsCode("bootstrap", at)) {
			return { created: false };
		}
		const code = generateClaimCode();
		const hash = await setupSecretHash(code);
		const created = c.tx(() => {
			if (store.setupState() === "done" || validLogsCode("bootstrap", at)) {
				return false;
			}
			store.sql.exec(
				"INSERT INTO setup_codes (code_hash, purpose, source, expires_at, used_at) VALUES (?, 'bootstrap', 'logs', ?, NULL)",
				hash,
				at + IDENTITY_TTL.bootstrapCodeMs,
			);
			return true;
		});
		if (created) {
			c.log.warn(
				`[tartan] setup code: ${code} (single use, valid 24 h; open /-/setup on this forge and enter it)`,
			);
		}
		return { created };
	};

	const unlock = async (
		input: { token: string; purpose: "bootstrap" | "recover"; ipHash: string },
	): Promise<{ sessionCookie: string; expiresAt: number }> => {
		if (!/^[0-9a-f]{16}$/.test(input.ipHash)) throw invalid("bad ipHash");
		if (input.purpose !== "bootstrap" && input.purpose !== "recover") {
			throw invalid("bad purpose");
		}
		const at = now();
		// Its own transaction: a refused attempt still counts.
		const rate = c.tx(() => {
			const ip = store.hitRateLimit(
				rateKey.setupIp(input.ipHash),
				RATE_LIMITS.setupPerIp.limit,
				RATE_LIMITS.setupPerIp.windowMs,
				at,
			);
			return ip.ok
				? store.hitRateLimit(
					rateKey.setupGlobal,
					RATE_LIMITS.setupGlobal.limit,
					RATE_LIMITS.setupGlobal.windowMs,
					at,
				)
				: ip;
		});
		if (!rate.ok) {
			throw rateLimited("too many setup attempts", rate.retryAfterMs);
		}
		const given = normalizeSetupInput(String(input.token ?? ""));
		const hash = await setupSecretHash(given);
		const deployed = c.env.TARTAN_SETUP_TOKEN;
		const isDeployed = deployed
			? await secretsEqual(given, normalizeSetupInput(deployed))
			: false;
		const cookie = randomSecret();
		const cookieHash = await sha256Hex(cookie);
		const expiresAt = at + IDENTITY_TTL.setupSessionMs;
		return c.tx(() => {
			const state = store.setupState();
			if (input.purpose === "bootstrap" && state === "done") {
				throw setupDenied(
					"setup is complete; recovery needs a new setup token",
				);
			}
			if (input.purpose === "recover" && state !== "done") {
				throw setupDenied(
					"the forge is not claimed yet: use setup, not recovery",
				);
			}
			const consumed = store.first<{ x: number }>(
				"SELECT 1 AS x FROM consumed_setup_secrets WHERE hash = ?",
				hash,
			);
			if (consumed !== null) {
				throw setupDenied("this setup secret was already used");
			}
			let source: "secret" | "logs";
			if (isDeployed) {
				source = "secret";
			} else {
				const used = store.sql.exec(
					"UPDATE setup_codes SET used_at = ? WHERE code_hash = ? AND purpose = ? AND source = 'logs' AND used_at IS NULL AND expires_at > ?",
					at,
					hash,
					input.purpose,
					at,
				).rowsWritten;
				if (used !== 1) throw setupDenied("invalid setup token or code");
				source = "logs";
			}
			if (input.purpose === "recover") {
				if (source === "secret") {
					store.sql.exec(
						"INSERT INTO consumed_setup_secrets (hash, purpose, consumed_at, consumed_by) VALUES (?, 'recover', ?, ?)",
						hash,
						at,
						SYS_KERNEL,
					);
				}
				store.setMeta(
					"recovery_banner_until",
					String(at + IDENTITY_TTL.recoveryBannerMs),
				);
			} else if (state === "fresh") {
				store.setMeta("setup_state", "unlocked");
			}
			store.sql.exec(
				"DELETE FROM sessions WHERE kind = 'setup' AND absolute_expires_at <= ?",
				at,
			);
			store.insertSession({
				id_hash: cookieHash,
				principal_id: SYS_KERNEL,
				kind: "setup",
				idp_sid: null,
				created_at: at,
				last_seen_at: at,
				idle_expires_at: expiresAt,
				absolute_expires_at: expiresAt,
			});
			c.modules.events.auditSync({
				principal: SYS_KERNEL,
				action: input.purpose === "recover" ? "setup.recover" : "setup.unlock",
				data: { source, ipHash: input.ipHash },
			});
			return { sessionCookie: cookie, expiresAt };
		});
	};

	/** Setup: forge name and canonical origin. */
	const setName = async (
		input: SetNameInput,
		session: string,
	): Promise<SetupStateDto> => {
		await requireSetupSession(session);
		const parsed = parseInput(SetupNameRequestSchema, input);
		const origin = new URL(parsed.canonicalOrigin).origin;
		c.tx(() => {
			store.setMeta("forge_name", parsed.forgeName);
			store.setMeta("canonical_origin", origin);
			c.modules.events.auditSync({
				principal: SYS_KERNEL,
				action: "setup.name",
				data: { forgeName: parsed.forgeName, canonicalOrigin: origin },
			});
		});
		return setupState();
	};

	/**
	 * The claim, one transaction for everything identity owns: the owner
	 * principal (admin) and identity, `owner_principal`, the consumed setup
	 * secret, every bootstrap code marked used, `setup_state = done`,
	 * the setup sessions deleted, the audit row. The root user node is WP3's
	 * (`TreeFacade.createRoot`) and is created right after; if that fails the
	 * claim stands and the error says so (`unavailable`, reason
	 * `owner-root`).
	 */
	const claimOwner = async (
		identity: ClaimIdentity,
		setupTokenHash: string | null,
	): Promise<{ principal: string; rootNodeId: string }> => {
		const deployed = c.env.TARTAN_SETUP_TOKEN;
		const deployedHash = deployed ? await setupSecretHash(deployed) : null;
		const consumed = [
			...new Set(
				[setupTokenHash, deployedHash].filter((h): h is string =>
					typeof h === "string" && /^[0-9a-f]{64}$/.test(h)
				),
			),
		];
		const principal = userId(c.ids.ulid());
		const at = now();
		const handle = c.tx(() => {
			if (store.setupState() === "done" || store.meta("owner_principal")) {
				throw conflict("the forge is already claimed");
			}
			if (store.idp() === null) throw invalid("configure the IdP first");
			if (store.identityPrincipal(identity.issuer, identity.sub) !== null) {
				throw conflict("this identity already belongs to a principal");
			}
			const handle = store.uniqueHandle(handleFrom(identity.handle, "owner"));
			store.insertPrincipal({
				id: principal,
				kind: "user",
				handle,
				display: identity.display.slice(0, 200) || handle,
				email: identity.email ?? null,
				email_verified: 0,
				owner_user_id: null,
				agent_tool: null,
				agent_model: null,
				is_admin: 1,
				created_at: at,
				disabled_at: null,
			});
			store.insertIdentity(identity.issuer, identity.sub, principal, at);
			store.setMeta("owner_principal", principal);
			for (const hash of consumed) {
				store.sql.exec(
					"INSERT OR IGNORE INTO consumed_setup_secrets (hash, purpose, consumed_at, consumed_by) VALUES (?, 'bootstrap', ?, ?)",
					hash,
					at,
					principal,
				);
			}
			store.sql.exec(
				"UPDATE setup_codes SET used_at = ? WHERE used_at IS NULL AND purpose = 'bootstrap'",
				at,
			);
			store.setMeta("setup_state", "done");
			store.sql.exec("DELETE FROM sessions WHERE kind = 'setup'");
			c.modules.events.auditSync({
				principal,
				action: "setup.claim",
				target: principal,
				data: { issuer: identity.issuer, handle },
			});
			return handle;
		});
		let rootNodeId: string;
		try {
			rootNodeId = (await c.tree.createRoot({
				kind: "user",
				slug: rootSlugFor(handle),
				owner: principal,
			})).id;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			c.log.error("[tartan] owner root node not created", {
				principal,
				message,
			});
			throw tartanError(
				"unavailable",
				`the forge is claimed, but the owner's root node was not created: ${message}`,
				{ reason: "owner-root", details: { principal } },
			);
		}
		c.tx(() =>
			appendPrincipalCreated(c, {
				principal,
				kind: "user",
				handle,
				node: rootNodeId,
			})
		);
		return { principal, rootNodeId };
	};

	return {
		setupState,
		setupSession,
		requireSetupSession,
		ensureBootstrapCode,
		unlock,
		setName,
		claimOwner,
	};
};

export type Setup = ReturnType<typeof createSetup>;
