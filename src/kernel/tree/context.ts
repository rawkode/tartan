// What every part of the ForgeDO `tree` module shares (WP3): the module
// deps, the ports it reaches outside ForgeDO through (Artifacts, RepoDO core,
// the genesis writer; tests pass fakes), the sibling internals (WP2 identity,
// WP6 forge events) and the one way to append a forge event and an audit row
// inside the caller's `transactionSync` (K3).

import {
	type Actor,
	type ActorKind,
	principalKind,
	SYS_KERNEL,
} from "@tartan/contract";
import type {
	Clock,
	ForgeEventsInternal,
	GenesisInput,
	IdentityInternal,
	Ids,
	ModuleTimersApi,
	RepoCoreFacade,
	RepoStore,
} from "@tartan/contract/kernel.ts";
import type { Roles } from "./roles.ts";

/** The RepoDO `core` calls repo creation makes (WP5a). */
export type RepoSetupPort = Pick<RepoCoreFacade, "init" | "importComplete">;

/**
 * The genesis commit of a created repo: `KernelGitJobs.genesis`'s
 * shape, with an optional README title (WP10's job may ignore it).
 */
export type GenesisPort = (
	repoId: string,
	input: GenesisInput & { readonly title?: string },
) => Promise<{ commit: string }>;

/** Everything `tree` reaches outside ForgeDO. */
export type TreePorts = {
	/** `env.ARTIFACTS`. */
	readonly artifacts: RepoStore;
	/** `env.REPO.getByName(repoDoName(id)).core()`. */
	repo(repoId: string): RepoSetupPort;
	readonly genesis: GenesisPort;
};

export type TreeLog = (message: string, data: Record<string, unknown>) => void;

export type TreeContext = {
	readonly sql: SqlStorage;
	/** `storage.transactionSync`. */
	tx<T>(closure: () => T): T;
	readonly clock: Clock;
	readonly ids: Ids;
	readonly roles: Roles;
	readonly timers: ModuleTimersApi;
	readonly ports: TreePorts;
	events(): ForgeEventsInternal;
	identity(): IdentityInternal;
	log: TreeLog;
	/** Detached work after a facade call returns (path-cache refreshes). */
	waitUntil(promise: Promise<unknown>): void;
};

const ACTOR_KINDS: Readonly<Record<string, ActorKind>> = {
	user: "user",
	agent: "agent",
	ext: "ext",
	system: "system",
};

/** The event actor of a principal id (`sys_kernel` for anything unknown). */
export const actorOf = (principal: string): Actor => {
	const kind = principalKind(principal);
	return kind === null
		? { kind: "system", id: SYS_KERNEL }
		: { kind: ACTOR_KINDS[kind], id: principal };
};

/** One forge-stream kernel event inside the caller's transaction (K3). */
export const appendForge = (
	c: TreeContext,
	event: {
		readonly type: string;
		readonly by: string;
		readonly node: string;
		readonly data: unknown;
	},
): void => {
	c.events().appendSync({
		type: event.type,
		actor: actorOf(event.by),
		node: event.node,
		data: event.data,
		idemKey: `tree:${c.ids.ulid()}:${event.type}:0`,
	});
};

export const audit = (
	c: TreeContext,
	entry: {
		readonly principal: string;
		readonly action: string;
		readonly target?: string;
		readonly data?: unknown;
	},
): void => {
	c.events().auditSync({
		principal: entry.principal,
		action: entry.action,
		...(entry.target !== undefined ? { target: entry.target } : {}),
		...(entry.data !== undefined ? { data: entry.data } : {}),
	});
};

export const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
