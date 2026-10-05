// The repository-config routes on the Worker's facades (`http.ts` holds the
// handlers and their checks). The router (WP0) maps:
//
//   /-/api/repos/:repoId/config[/<rest>]                    → handleRepoConfig
//   /-/api/repos/:repoId/lanes/:laneId/(config|policy-signoff) → handleRepoConfigLane
//   /-/api/nodes/:node/config-approvals[/:extId]            → handleConfigApprovals
//   /-/api/installations/:installation/repo-overrides       → handleRepoOverrides
//
// Every facade is a disposing view: no stub exists
// until a handler calls a method, which it does only after `requireAuth`, so
// an anonymous request wakes no Durable Object; each call disposes its stub
// when it settles.

import {
	FORGE_DO_NAME,
	type Lane,
	type NodeDto,
	repoDoName,
} from "@tartan/contract";
import type {
	RegistryFacade,
	RepoConfigFacade,
	RepoCoreFacade,
	TreeFacade,
} from "@tartan/contract/kernel.ts";
import { disposingFacade, withRpc } from "../../do/dispose.ts";
import type { Env } from "../../env.ts";
import type { RouteHandler } from "../../router.ts";
import { createNodeAccess } from "../tree/authz.ts";
import { createRepoConfigHttp, type RepoConfigHttpDeps } from "./http.ts";

const REPOCONFIG_METHODS = [
	"state",
	"evaluation",
	"preview",
	"previewOf",
	"signOff",
	"revokeSignOff",
	"apply",
	"reevaluate",
	"override",
] as const;

const REGISTRY_METHODS = [
	"repoConfigSchema",
	"repoConfigEffective",
	"requestConfigApproval",
	"revokeConfigApproval",
	"configApprovals",
	"setRepoOverrides",
	"installation",
] as const;

export const repoConfigHttpDeps = (env: Env): RepoConfigHttpDeps => {
	// Typed through the contract facades (the RPC stub types are too deep).
	const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
	const repo = (repoId: string) => env.REPO.getByName(repoDoName(repoId));
	return {
		node: (id: string) =>
			withRpc(
				() => forge().tree() as unknown as Pick<TreeFacade, "node">,
				(tree): Promise<NodeDto | null> => tree.node(id),
			),
		access: createNodeAccess(env),
		repoconfig: (repoId: string) =>
			disposingFacade(
				() => repo(repoId).repoconfig() as unknown as RepoConfigFacade,
				REPOCONFIG_METHODS,
			),
		lane: (repoId: string, laneId: string) =>
			withRpc(
				() => repo(repoId).core() as unknown as Pick<RepoCoreFacade, "getLane">,
				(core) => core.getLane(laneId) as Promise<Lane | null>,
			),
		registry: disposingFacade(
			() => forge().registry() as unknown as RegistryFacade,
			REGISTRY_METHODS,
		),
	};
};

export const handleRepoConfig: RouteHandler = ({ env, req, params, auth }) =>
	createRepoConfigHttp(repoConfigHttpDeps(env)).config(
		req,
		{ repoId: params.repoId ?? "", rest: params.rest },
		auth,
	);

export const handleRepoConfigLane: RouteHandler = (
	{ env, req, params, auth },
) =>
	createRepoConfigHttp(repoConfigHttpDeps(env)).lane(
		req,
		{
			repoId: params.repoId ?? "",
			laneId: params.laneId ?? "",
			what: params.what ?? "",
		},
		auth,
	);

export const handleConfigApprovals: RouteHandler = (
	{ env, req, params, auth },
) =>
	createRepoConfigHttp(repoConfigHttpDeps(env)).approvals(
		req,
		{ nodeId: params.node ?? "", extId: params.extId },
		auth,
	);

export const handleRepoOverrides: RouteHandler = (
	{ env, req, params, auth },
) =>
	createRepoConfigHttp(repoConfigHttpDeps(env)).repoOverrides(
		req,
		{ installationId: params.installation ?? "" },
		auth,
	);
