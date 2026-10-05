// What the hierarchy and browse routes reach (WP3), as narrow ports so tests
// inject fakes: ForgeDO's tree facade (contract methods plus WP3's
// extras), RepoDO `core` (refs resolved by SHA, K15; the read context of the
// public view; import completion), the Artifacts binding for SHA-only reads,
// and RepoProbe for diffs (WP8).

import { FORGE_DO_NAME, repoDoName } from "@tartan/contract";
import type {
	RepoCoreFacade,
	RepoProbeApi,
	RepoStore,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";
import type { TreeKernelFacade } from "../tree/module.ts";

export type BrowseTree = Pick<
	TreeKernelFacade,
	| "resolvePath"
	| "node"
	| "effectiveRole"
	| "childrenAccess"
	| "createRootNode"
	| "createNode"
	| "createRepo"
	| "importRepo"
	| "moveNode"
	| "archiveNode"
	| "grant"
	| "revoke"
	| "grants"
	| "protectedRefs"
	| "importCompleted"
>;

export type BrowseRepo = Pick<
	RepoCoreFacade,
	"resolveRef" | "readContext" | "importComplete"
>;

export type BrowseDeps = {
	tree(): BrowseTree;
	repo(repoId: string): BrowseRepo;
	/** The Artifacts binding (reads by SHA only). */
	readonly artifacts: Pick<RepoStore, "get">;
	probe(): Pick<RepoProbeApi, "diff">;
};

export const browseDepsOf = (
	env: Env,
	ctx: ExecutionContext,
): BrowseDeps => ({
	tree: () =>
		env.FORGE.getByName(FORGE_DO_NAME).tree() as unknown as BrowseTree,
	repo: (repoId) =>
		env.REPO.getByName(repoDoName(repoId)).core() as unknown as BrowseRepo,
	artifacts: env.ARTIFACTS,
	probe: () => loopback(ctx).RepoProbe as unknown as Pick<RepoProbeApi, "diff">,
});
