// What the WP7a HTTP handlers depend on, as narrow contract facades so tests
// run them against fakes. `depsFromEnv` binds them to the Worker: ForgeDO's
// `registry`, `tree` and `identity` facades, WP3's `authorize`, RepoDO `core`
// (repo info, ref resolution K15, lanes) and `events` (the log head of a
// render's cursor), `land` (advances and gate replays), RepoProbe (gate replay
// inputs) and the installation's ExtensionDO (WP7b) for render, action, gate
// and the admin reads. Every facade call opens its stub and disposes it when
// the call settles (`src/do/dispose.ts`); the method lists below are the only
// calls the handlers make.

import {
	extDoName,
	type ExtScope,
	FORGE_DO_NAME,
	repoDoName,
} from "@tartan/contract";
import type {
	Authorize,
	ExtensionHostApi,
	IdentityFacade,
	RegistryFacade,
	RepoCoreFacade,
	RepoEventsFacade,
	RepoLandFacade,
	RepoProbeApi,
} from "@tartan/contract/kernel.ts";
import { disposingFacade } from "../../../do/dispose.ts";
import type { Env } from "../../../env.ts";
import { loopback } from "../../../exports.ts";
import { createAuthorize } from "../../tree/authz.ts";
import type { TreeKernelFacade } from "../../tree/module.ts";

const REGISTRY_METHODS = [
	"packages",
	"publish",
	"install",
	"setMode",
	"uninstall",
	"installation",
	"inForce",
	"installed",
	"replaceProvider",
	"promote",
	"replayGate",
] as const satisfies readonly (keyof RegistryFacade)[];
const TREE_METHODS = [
	"resolvePath",
	"node",
	"listRepos",
	"childrenAccess",
] as const satisfies readonly (keyof TreeKernelFacade)[];
const IDENTITY_METHODS = [
	"principal",
] as const satisfies readonly (keyof IdentityFacade)[];
const REPO_METHODS = [
	"info",
	"resolveRef",
	"getLane",
] as const satisfies readonly (keyof RepoCoreFacade)[];
const EVENTS_METHODS = [
	"head",
] as const satisfies readonly (keyof RepoEventsFacade)[];
const LAND_METHODS = [
	"advances",
	"recordReplay",
	"replay",
] as const satisfies readonly (keyof RepoLandFacade)[];

export type RegistryApi = Pick<
	RegistryFacade,
	typeof REGISTRY_METHODS[number]
>;
export type TreeApi = Pick<TreeKernelFacade, typeof TREE_METHODS[number]>;
export type IdentityApi = Pick<IdentityFacade, typeof IDENTITY_METHODS[number]>;
export type RepoApi = Pick<RepoCoreFacade, typeof REPO_METHODS[number]>;
export type RepoEventsApi = Pick<
	RepoEventsFacade,
	typeof EVENTS_METHODS[number]
>;
export type LandApi = Pick<RepoLandFacade, typeof LAND_METHODS[number]>;
export type ProbeApi = Pick<RepoProbeApi, "addedLines" | "diffPaths">;
export type ExtHostApi = Pick<
	ExtensionHostApi,
	| "render"
	| "action"
	| "gate"
	| "console"
	| "deadLetters"
	| "breaker"
	| "resetBreaker"
	| "deleteData"
>;

/**
 * One operator log line: ids, codes and kernel-built messages only,
 * never ctx values, headers, payloads or extension text.
 */
export type ApiLogEntry = {
	readonly level: "warn" | "error";
	/** What happened, e.g. `slot.refused`, `uninstall.cleanup_failed`. */
	readonly event: string;
	readonly [field: string]: string | number | boolean | undefined;
};

export type ApiDeps = {
	readonly registry: () => RegistryApi;
	readonly tree: () => TreeApi;
	readonly identity: () => IdentityApi;
	readonly authorize: Authorize;
	readonly repo: (repoId: string) => RepoApi;
	/** RepoDO `events`: the log head a slot render's `cursor` carries. */
	readonly events: (repoId: string) => RepoEventsApi;
	readonly land: (repoId: string) => LandApi;
	/** RepoProbe (the Worker's own entrypoint): gate replay inputs. */
	readonly probe: () => ProbeApi;
	readonly ext: (installationId: string, scope: ExtScope) => ExtHostApi;
	/** R2 bucket for published package bundles (`ext/<id>/<version>/<sha256>/`). */
	readonly blobs: () => R2Bucket;
	/** Operator log (Workers Logs / `wrangler tail`). */
	readonly log: (entry: ApiLogEntry) => void;
};

/** The production log: one JSON line per entry. */
export const consoleLog = (entry: ApiLogEntry): void => {
	const line = JSON.stringify({ src: "tartan.exthost.api", ...entry });
	if (entry.level === "error") console.error(line);
	else console.warn(line);
};

/**
 * RepoProbe through the Worker's own exports. `cloudflare:workers` is
 * imported on first use, so the Deno tests of these handlers never load it.
 */
const probeOverExports = (): ProbeApi => {
	const probe = async (): Promise<ProbeApi> => {
		const { exports } = await import("cloudflare:workers");
		return loopback({ exports }).RepoProbe as unknown as ProbeApi;
	};
	return {
		addedLines: async (...args) => (await probe()).addedLines(...args),
		diffPaths: async (...args) => (await probe()).diffPaths(...args),
	};
};

export const depsFromEnv = (env: Env): ApiDeps => {
	const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
	const registry = disposingFacade(
		() => forge().registry() as unknown as RegistryApi,
		REGISTRY_METHODS,
	);
	const tree = disposingFacade(
		() => forge().tree() as unknown as TreeApi,
		TREE_METHODS,
	);
	const identity = disposingFacade(
		() => forge().identity() as unknown as IdentityApi,
		IDENTITY_METHODS,
	);
	return {
		registry: () => registry,
		tree: () => tree,
		identity: () => identity,
		authorize: createAuthorize(env),
		repo: (repoId) =>
			disposingFacade(
				() =>
					env.REPO.getByName(repoDoName(repoId)).core() as unknown as RepoApi,
				REPO_METHODS,
			),
		events: (repoId) =>
			disposingFacade(
				() =>
					env.REPO.getByName(repoDoName(repoId))
						.events() as unknown as RepoEventsApi,
				EVENTS_METHODS,
			),
		land: (repoId) =>
			disposingFacade(
				() =>
					env.REPO.getByName(repoDoName(repoId)).land() as unknown as LandApi,
				LAND_METHODS,
			),
		probe: () => probeOverExports(),
		ext: (installationId, scope) =>
			env.EXT.getByName(
				extDoName(installationId, scope),
			) as unknown as ExtHostApi,
		blobs: () => env.BLOBS,
		log: consoleLog,
	};
};
