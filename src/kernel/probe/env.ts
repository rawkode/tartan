// Wiring RepoProbe to the Worker's bindings: RepoDO (core + probe facades)
// for upstream names, trunk positions, lane bases, ref resolution and the
// graph cache; `ARTIFACTS` for SHA reads (only under names RepoDO returned);
// R2 `BLOBS` for `diffs/`; the isolate's object cache and read bucket.

import { repoDoName } from "@tartan/contract";
import type { ProjectGraph } from "@tartan/contract";
import type { Env } from "../../env.ts";
import { isolateReadBucket } from "./bucket.ts";
import {
	type CacheLike,
	createObjectCache,
	type ObjectCache,
} from "./cache.ts";
import type { ProbeRepoPort, RepoProbeDeps } from "./probe.ts";
import { projectsMode } from "../projects/mode.ts";

/** RepoDO of `repoId` as RepoProbe's port. */
export const repoPort = (env: Env, repoId: string): ProbeRepoPort => {
	const stub = () => env.REPO.getByName(repoDoName(repoId));
	return {
		artifactsName: async (target) =>
			(await stub().core().upstream(target, "read")).artifactsName,
		trunkSeqs: (shas) => stub().core().trunkSeqs([...shas]),
		laneBase: async (laneId) =>
			(await stub().core().getLane(laneId))?.base ?? null,
		trunkTip: async () => (await stub().core().info()).trunkSha,
		resolveRef: (ref) => stub().core().resolveRef(ref),
		projects: (sha) => stub().probe().projects(sha),
		putProjects: (graph) => stub().probe().putProjects(graph),
		projectConfig: (sha) => stub().repoconfig().projectConfig(sha),
	};
};

const edgeCache = (): CacheLike | null => {
	try {
		return (globalThis as { caches?: { default?: CacheLike } }).caches
			?.default ??
			null;
	} catch {
		return null;
	}
};

let objectCache: ObjectCache | null = null;
const graphMemo = new Map<string, ProjectGraph>();

/** The isolate-wide object cache (isolate LRU → Cache API). */
export const isolateObjectCache = (): ObjectCache =>
	objectCache ??= createObjectCache({ edge: edgeCache() });

export const probeDepsFromEnv = (env: Env): RepoProbeDeps => ({
	repo: (repoId) => repoPort(env, repoId),
	store: { get: (name) => env.ARTIFACTS.get(name) },
	diffs: {
		get: (key) => env.BLOBS.get(key),
		put: (key, value) =>
			env.BLOBS.put(key, value, {
				httpMetadata: { contentType: "application/json" },
			}),
	},
	cache: isolateObjectCache(),
	bucket: isolateReadBucket,
	graphMemo,
	repoConfig: env.TARTAN_REPO_CONFIG === "on",
	projects: projectsMode(env),
});
