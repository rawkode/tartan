// What every part of the identity module receives (WP2). Built once per
// ForgeDO instance by `module.ts`.

import type { Role } from "@tartan/contract";
import type { Clock, ForgeInternals, Ids } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import type { Keyring } from "./keyring.ts";
import type { FetchLike } from "./ssrf.ts";
import type { IdentityStore } from "./store.ts";

/**
 * The tree operations identity needs from WP3 (consumed through
 * `TreeFacade`): the owner's root node at the claim and an invite's grant.
 * `TreeInternal` has no synchronous form of either yet, so they run after
 * identity's own transaction (a synchronous `createRootSync` and
 * `grantSync` would make the claim and the invite one transaction).
 */
export type TreePort = {
	createRoot(
		input: { kind: "user"; slug: string; owner: string },
	): Promise<{ readonly id: string }>;
	grant(
		by: string,
		nodeId: string,
		principal: string,
		role: Role,
	): Promise<void>;
};

export type IdentityLog = {
	/** Workers Logs line, e.g. the setup claim code. */
	readonly warn: (message: string) => void;
	readonly error: (message: string, data?: Record<string, unknown>) => void;
};

export const consoleLog: IdentityLog = {
	warn: (message) => console.warn(message),
	error: (message, data) =>
		console.error(message, data === undefined ? "" : JSON.stringify(data)),
};

export type IdentityContext = {
	readonly env: Env;
	readonly storage: DurableObjectStorage;
	readonly store: IdentityStore;
	readonly modules: ForgeInternals;
	readonly clock: Clock;
	readonly ids: Ids;
	/** Outbound fetch for discovery, DCR and RFC 7592 (the SSRF-guarded one). */
	readonly fetch: FetchLike;
	readonly tree: TreePort;
	readonly log: IdentityLog;
	/** The keyring of this forge's root (`TARTAN_SECRET` or the first-boot key). */
	readonly keyring: () => Promise<Keyring>;
	/** The first-boot root key, or null when `TARTAN_SECRET` is set. */
	readonly rootKey: () => Promise<string | null>;
	readonly tx: <T>(fn: () => T) => T;
};
