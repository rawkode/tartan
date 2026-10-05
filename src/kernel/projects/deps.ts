// What the projects API reaches (WP25 slice A′), as narrow ports so tests
// inject fakes: ForgeDO's tree (authorization) and registry (the
// `work@1`/`changes@1` providers in force), RepoDO's core (trunk tip, trunk
// commits) and probe cache, RepoProbe for graphs (detection is lazy on the
// first read of a commit), the Artifacts binding for README/AGENTS reads by
// SHA (K15), and the provider's ExtensionDO for the filtered lists, called
// as the viewer (the same port the MCP host uses).

import {
	type ActorBounds,
	extDoName,
	FORGE_DO_NAME,
	type InstallationInForce,
	type ProjectGraph,
	repoArtifactsName,
	repoDoName,
	type RepoInfo,
	type ToolContext,
} from "@tartan/contract";
import { disposingFacade, withRpc } from "../../do/dispose.ts";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";
import { openReads, type RepoReads } from "../browse/reader.ts";
import type { TreeReads } from "../tree/authz.ts";
import { type ProjectsMode, projectsMode } from "./mode.ts";

export type ProjectsRepoPort = {
	info(): Promise<RepoInfo>;
	trunkSeqs(shas: string[]): Promise<Record<string, number>>;
};

export type ProjectsDeps = {
	readonly mode: ProjectsMode;
	tree(): TreeReads;
	repo(repoId: string): ProjectsRepoPort;
	/** RepoDO `probe().projects(sha)`: the cached graph at a commit, or null. */
	cachedGraph(repoId: string, sha: string): Promise<ProjectGraph | null>;
	/** RepoProbe `projectGraph`: the graph at a commit, detected on a miss. */
	graph(repoId: string, sha: string): Promise<ProjectGraph>;
	/** SHA-only reads of the canonical repo (closed by the caller). */
	reads(repoId: string): Promise<RepoReads>;
	/** The nearest enforce provider of an interface at a node (WP7a). */
	provider(iface: string, nodeId: string): Promise<InstallationInForce | null>;
	/** An interface tool on the provider's ExtensionDO, as the viewer. */
	callTool(
		provider: InstallationInForce,
		repoId: string,
		name: string,
		args: unknown,
		ctx: ToolContext,
		bounds: ActorBounds,
	): Promise<unknown>;
	/** Admission of an uncached graph request (`?sha=`) for a principal. */
	admit(principal: string): boolean;
};

/** Uncached graph requests per principal and minute. */
export const UNCACHED_GRAPHS_PER_MINUTE = 10;

/** A fixed-window counter per key (isolate state; best effort across isolates). */
export const createAdmission = (
	perMinute: number,
	now: () => number = Date.now,
): (key: string) => boolean => {
	const windows = new Map<string, { start: number; count: number }>();
	return (key) => {
		const at = now();
		const w = windows.get(key);
		if (w === undefined || at - w.start >= 60_000) {
			if (windows.size >= 10_000) windows.clear();
			windows.set(key, { start: at, count: 1 });
			return true;
		}
		if (w.count >= perMinute) return false;
		w.count++;
		return true;
	};
};

const isolateAdmission = createAdmission(UNCACHED_GRAPHS_PER_MINUTE);

export const projectsDepsOf = (
	env: Env,
	ctx: { readonly exports: unknown },
): ProjectsDeps => {
	const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
	const repoDo = (repoId: string) => env.REPO.getByName(repoDoName(repoId));
	// Each facade call opens its stub and disposes it when it settles.
	const tree = disposingFacade(
		() => forge().tree() as unknown as TreeReads,
		["node", "effectiveRole"],
	);
	return {
		mode: projectsMode(env),
		tree: () => tree,
		repo: (repoId) =>
			disposingFacade(
				() => repoDo(repoId).core() as unknown as ProjectsRepoPort,
				["info", "trunkSeqs"],
			),
		cachedGraph: (repoId, sha) =>
			withRpc(
				() => repoDo(repoId).probe(),
				(probe) => probe.projects(sha) as Promise<ProjectGraph | null>,
			),
		graph: (repoId, sha) =>
			loopback(ctx).RepoProbe.projectGraph(repoId, sha) as Promise<
				ProjectGraph
			>,
		reads: (repoId) => openReads(env.ARTIFACTS, repoArtifactsName(repoId)),
		provider: (iface, nodeId) =>
			withRpc(
				() => forge().registry(),
				(registry) =>
					registry.provider(iface, nodeId) as Promise<
						InstallationInForce | null
					>,
			),
		callTool: (provider, repoId, name, args, toolCtx, bounds) =>
			env.EXT.getByName(
				extDoName(
					provider.installation.id,
					provider.installation.storageScope === "repo"
						? { kind: "repo", repoId }
						: { kind: "node" },
				),
			).callTool(name, args, toolCtx, bounds) as Promise<unknown>,
		admit: isolateAdmission,
	};
};
