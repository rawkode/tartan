// ForgeDO `identity` module (WP2, migrations 100–199): setup state, the IdP,
// principals, identities, sessions, tokens, invites and keys. The facade is the
// contract's `IdentityFacade` plus WP2's own additions (`types.ts`).
//
// Sibling modules are reached through their synchronous internals inside
// one `transactionSync` (WP6's `events.auditSync`/`appendSync`, WP3's
// `tree.nodeByPathSync`/`nodeSync`/`effectiveRoleSync`); WP3's root-node and
// grant writes go through `TreeFacade` (`TreePort`).

import {
	invalid,
	type LaneSelfTestResult,
	SHA256_HEX_RE,
} from "@tartan/contract";
import {
	type DoModule,
	type ForgeInternals,
	type IdentityInternal,
	type LoginTxnRow,
	MIGRATION_RANGES,
	type ModuleDeps,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { runEnvironmentChecks } from "./checks.ts";
import {
	consoleLog,
	type IdentityContext,
	type IdentityLog,
	type TreePort,
} from "./context.ts";
import { createIdp } from "./idp.ts";
import { createKeyring, generateRootSecret, type Keyring } from "./keyring.ts";
import { IDENTITY_TTL } from "./policy.ts";
import { createPrincipals } from "./principals.ts";
import { IDENTITY_MIGRATIONS } from "./schema.ts";
import { createSetup } from "./setup.ts";
import { createGuardedFetch, type FetchLike } from "./ssrf.ts";
import { createIdentityStore, type IdentityStore } from "./store.ts";
import type { IdentityKernelFacade } from "./types.ts";

/** DO storage key of the local key that seals the first-boot root key. */
export const LOCAL_KEY = "identity:local-key";

/**
 * WP3's tree facade on this same ForgeDO, called after identity's own
 * transaction (`TreePort`).
 */
export const forgeTreePort = (
	deps: Pick<ModuleDeps<Env>, "env" | "ctx">,
): TreePort => {
	const tree = () => deps.env.FORGE.get(deps.ctx.id).tree();
	return {
		createRoot: async (input) => ({ id: (await tree().createRoot(input)).id }),
		grant: async (by, nodeId, principal, role) => {
			await tree().grant(by, nodeId, principal, role);
		},
	};
};

/**
 * The first-boot root key: with `TARTAN_SECRET` absent, ForgeDO
 * generates 32 random bytes once and stores them sealed under a DO-local key
 * (kept in the DO's key-value storage, apart from the SQL tables).
 */
const createRootKeySource = (
	storage: DurableObjectStorage,
	store: IdentityStore,
	env: Env,
): () => Promise<string | null> => {
	let pending: Promise<string> | null = null;
	const load = async (): Promise<string> => {
		let local = await storage.get<string>(LOCAL_KEY);
		if (typeof local !== "string") {
			local = generateRootSecret();
			await storage.put(LOCAL_KEY, local);
		}
		const localKeyring = await createKeyring(local);
		const stored = store.meta("root_key_fallback_sealed");
		if (stored !== null) {
			return await localKeyring.open("root-key", "fallback", stored);
		}
		const root = generateRootSecret();
		const sealed = await localKeyring.seal("root-key", "fallback", root);
		const winner = storage.transactionSync(() => {
			const again = store.meta("root_key_fallback_sealed");
			if (again !== null) return again;
			store.setMeta("root_key_fallback_sealed", sealed);
			return sealed;
		});
		return winner === sealed
			? root
			: await localKeyring.open("root-key", "fallback", winner);
	};
	return () => {
		if (env.TARTAN_SECRET) return Promise.resolve(null);
		pending ??= load().catch((error) => {
			pending = null;
			throw error;
		});
		return pending;
	};
};

const LOGIN_PURPOSES = new Set(["login", "bootstrap", "recover"]);

const checkLoginTxn = (row: LoginTxnRow, now: number): void => {
	const problems = [
		!SHA256_HEX_RE.test(row.state_hash) && "state_hash",
		!SHA256_HEX_RE.test(row.binding_hash) && "binding_hash",
		!LOGIN_PURPOSES.has(row.purpose) && "purpose",
		!/^v1\./.test(row.verifier_sealed) && "verifier_sealed",
		(typeof row.nonce !== "string" || row.nonce.length < 16 ||
			row.nonce.length > 256) && "nonce",
		(typeof row.return_to !== "string" || !row.return_to.startsWith("/") ||
			row.return_to.startsWith("//") || row.return_to.length > 2048) &&
		"return_to",
		(!Number.isSafeInteger(row.expires_at) || row.expires_at <= now ||
			row.expires_at > now + IDENTITY_TTL.loginTxnMs + 60_000) &&
		"expires_at",
		row.invite_hash !== null && !SHA256_HEX_RE.test(row.invite_hash) &&
		"invite_hash",
	].filter((p): p is string => typeof p === "string");
	if (problems.length > 0) {
		throw invalid(`bad login transaction: ${problems.join(", ")}`);
	}
};

/**
 * Every facade method answers with a promise: a synchronous throw (a check
 * before the first await, a refused transaction) becomes a rejection, as it
 * would over RPC.
 */
const rejectingFacade = <T extends object>(facade: T): T =>
	Object.fromEntries(
		Object.entries(facade).map(([name, method]) => [
			name,
			(...args: unknown[]) => {
				try {
					return Promise.resolve(
						(method as (...a: unknown[]) => unknown)(...args),
					);
				} catch (error) {
					return Promise.reject(error);
				}
			},
		]),
	) as T;

export type IdentityModuleOptions = {
	/** The base fetch behind the SSRF guard (tests: a mock IdP). */
	readonly fetch?: FetchLike;
	/** WP3's tree writes (tests: a fake). */
	readonly tree?: (deps: ModuleDeps<Env, ForgeInternals>) => TreePort;
	readonly log?: IdentityLog;
};

export const createIdentityModule = (
	options: IdentityModuleOptions = {},
): DoModule<IdentityKernelFacade, IdentityInternal, Env, ForgeInternals> => ({
	name: "identity",
	range: MIGRATION_RANGES.forge.identity,
	migrations: IDENTITY_MIGRATIONS,
	create: (deps) => {
		const store = createIdentityStore(deps.sql);
		const rootKey = createRootKeySource(deps.storage, store, deps.env);
		let keyringPending: Promise<Keyring> | null = null;
		const keyring = (): Promise<Keyring> => {
			keyringPending ??= (async () => {
				const root = deps.env.TARTAN_SECRET ?? await rootKey();
				if (!root) throw invalid("no root key");
				return await createKeyring(root, deps.env.TARTAN_SECRET_PREVIOUS);
			})().catch((error) => {
				keyringPending = null;
				throw error;
			});
			return keyringPending;
		};
		const c: IdentityContext = {
			env: deps.env,
			storage: deps.storage,
			store,
			modules: deps.modules,
			clock: deps.clock,
			ids: deps.ids,
			fetch: createGuardedFetch(options.fetch),
			tree: (options.tree ?? forgeTreePort)(deps),
			log: options.log ?? consoleLog,
			keyring,
			rootKey,
			tx: (fn) => deps.storage.transactionSync(fn),
		};
		const setup = createSetup(c);
		const idp = createIdp(c, setup);
		const principals = createPrincipals(c);

		const putLoginTxn = (row: LoginTxnRow): Promise<void> => {
			const at = c.clock.now();
			checkLoginTxn(row, at);
			c.tx(() => {
				store.sql.exec("DELETE FROM login_txn WHERE expires_at <= ?", at);
				store.sql.exec(
					"INSERT INTO login_txn (state_hash, binding_hash, purpose, verifier_sealed, nonce, return_to, expires_at, invite_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					row.state_hash,
					row.binding_hash,
					row.purpose,
					row.verifier_sealed,
					row.nonce,
					row.return_to,
					row.expires_at,
					row.invite_hash,
				);
			});
			return Promise.resolve();
		};

		/** Single use and browser-bound: only the matching binding deletes it. */
		const consumeLoginTxn = (
			stateHash: string,
			bindingHash: string,
		): Promise<LoginTxnRow | null> =>
			Promise.resolve(
				store.sql.exec<LoginTxnRow>(
					"DELETE FROM login_txn WHERE state_hash = ? AND binding_hash = ? AND expires_at > ? RETURNING *",
					stateHash,
					bindingHash,
					c.clock.now(),
				).toArray()[0] ?? null,
			);

		const facade: IdentityKernelFacade = {
			setupState: () => Promise.resolve(setup.setupState()),
			ensureBootstrapCode: setup.ensureBootstrapCode,
			unlock: setup.unlock,
			environmentChecks: () => runEnvironmentChecks(deps.env, deps.ids.ulid()),
			configureIdp: idp.configureIdp,
			registerIdp: idp.registerIdp,
			deregisterIdp: idp.deregisterIdp,
			putLoginTxn,
			consumeLoginTxn,
			claimOwner: setup.claimOwner,
			loginIdentity: principals.loginIdentity,
			createSession: principals.createSession,
			session: principals.session,
			deleteSession: principals.deleteSession,
			token: principals.token,
			createPat: principals.createPat,
			createAgent: principals.createAgent,
			bulkMintAgents: principals.bulkMintAgents,
			revokeToken: principals.revokeToken,
			principal: principals.principal,
			principalByHandle: principals.principalByHandle,
			isOwner: (principal) => Promise.resolve(principals.isOwner(principal)),
			// WP5b's post-claim lane-repo self-test (display only).
			lastLaneSelfTest: () => {
				const raw = store.meta("lane_selftest_json");
				try {
					return Promise.resolve(
						raw === null ? null : JSON.parse(raw) as LaneSelfTestResult,
					);
				} catch {
					return Promise.resolve(null);
				}
			},
			recordLaneSelfTest: (result) => {
				store.setMeta("lane_selftest_json", JSON.stringify(result));
				return Promise.resolve();
			},
			createInvite: principals.createInvite,
			jwks: idp.jwks,
			rateLimit: principals.rateLimit,
			// WP2-internal additions.
			setupSession: setup.setupSession,
			// An origin change moves a DCR client to the new redirect URI.
			setName: async (input, session) => {
				const before = store.meta("canonical_origin");
				const state = await setup.setName(input, session);
				if (before !== null && state.canonicalOrigin !== before) {
					await idp.reregisterForOrigin();
				}
				return state;
			},
			idp: idp.idp,
			rootKey,
			refreshIdp: idp.refreshIdp,
			listTokens: principals.listTokens,
			listAgents: principals.listAgents,
			disableAgent: principals.disableAgent,
			listInvites: principals.listInvites,
			revokeInvite: principals.revokeInvite,
		};
		return {
			facade: rejectingFacade(facade),
			internal: {
				principalSync: (id) => store.principal(id),
				isOwner: principals.isOwner,
			},
		};
	},
});

/** The module ForgeDO composes (`src/do/forge.ts`). */
export const identityModule = createIdentityModule();
