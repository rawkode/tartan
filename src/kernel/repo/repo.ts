// The repo itself: `init` (once, from WP3's createRepo/importRepo), `info`, and
// import mode's end, `importComplete` (the only owner of that logic): reconcile
// `refs` from a fresh advertisement, set the default branch, seed
// `trunk_commits` with the first-parent chain (≤ 1,000, K17), turn protection
// and lanes on ⇒ `repo.imported`.

import {
	conflict,
	denied,
	type ImportCompleteRequest,
	type ImportCompleteResponse,
	invalid,
	isPrincipalId,
	isSha,
	isUlid,
	isValidRefName,
	NodePathSchema,
	repoArtifactsName,
	type RepoInfo,
	ROLE,
	trunkRef,
} from "@tartan/contract";
import type { RepoStoreCommit } from "@tartan/contract/kernel.ts";
import { TRUNK_IMPORT_CHAIN } from "../../constants.ts";
import {
	type Core,
	emit,
	errorText,
	getMeta,
	isImporting,
	repoIdentity,
	rows,
	setMeta,
} from "./core.ts";
import { authorizationFor } from "./gitremote.ts";
import type { Protection } from "./protection.ts";
import { writeRef } from "./refs.ts";
import type { Roles } from "./roles.ts";
import { recordImportChainSync } from "./trunk.ts";
import type { ArtifactsAccess } from "./upstream.ts";

export type InitInput = {
	repoId: string;
	nodeId: string;
	path: string;
	defaultBranch: string;
	refs?: Record<string, string>;
	/**
	 * Not in contract v0.2 (REQUEST to WP0): `"importing"` for an Owner push
	 * import. Read when present so WP3 can pass it once added.
	 */
	importState?: "none" | "importing";
};

/** `init`: idempotent for the same repo; seeds meta and the index. */
export const initSync = (core: Core, input: InitInput): void => {
	if (!isUlid(input.repoId) || !isUlid(input.nodeId)) {
		throw invalid("repoId and nodeId must be lowercase ulids");
	}
	if (!NodePathSchema.safeParse(input.path).success) {
		throw invalid(`invalid repo path: ${input.path}`);
	}
	if (!isValidRefName(trunkRef(input.defaultBranch))) {
		throw invalid(`invalid default branch: ${input.defaultBranch}`);
	}
	const refs = Object.entries(input.refs ?? {});
	for (const [ref, sha] of refs) {
		if (!isValidRefName(ref) || !isSha(sha)) {
			throw invalid(`invalid ref entry: ${ref}`);
		}
	}
	const existing = getMeta(core.sql, "repo_id");
	if (existing !== null) {
		if (existing !== input.repoId) {
			throw conflict(`RepoDO already holds repo ${existing}`);
		}
		setMeta(core.sql, "path", input.path);
		return;
	}
	setMeta(core.sql, "repo_id", input.repoId);
	setMeta(core.sql, "node_id", input.nodeId);
	setMeta(core.sql, "path", input.path);
	setMeta(core.sql, "artifacts_name", repoArtifactsName(input.repoId));
	setMeta(core.sql, "default_branch", input.defaultBranch);
	setMeta(core.sql, "landing_paused", "0");
	setMeta(core.sql, "drifted", "0");
	setMeta(
		core.sql,
		"import_state",
		input.importState === "importing" ? "importing" : "none",
	);
	for (const [ref, sha] of refs) writeRef(core, ref, sha);
	emit(core, {
		type: "repo.created",
		data: {
			repoId: input.repoId,
			path: input.path,
			artifactsName: repoArtifactsName(input.repoId),
		},
		idemKey: `core:init:${input.repoId}:repo.created`,
	});
};

/** `info`: meta plus the node's visibility and description from ForgeDO's tree. */
export const repoInfo = async (core: Core): Promise<RepoInfo> => {
	const identity = repoIdentity(core.sql);
	const node = await core.ports.forgeTree().node(identity.nodeId);
	return {
		id: identity.repoId,
		nodeId: identity.nodeId,
		path: node?.path ?? identity.path,
		defaultBranch: identity.defaultBranch,
		visibility: node?.visibility ?? "private",
		trunkSha: getMeta(core.sql, "trunk_sha"),
		landingPaused: getMeta(core.sql, "landing_paused") === "1",
		...(node?.description !== undefined
			? { description: node.description }
			: {}),
	};
};

/** The first-parent chain from `tip` within one `log` page (newest first). */
export const firstParentChain = (
	tip: string,
	commits: readonly RepoStoreCommit[],
	max: number,
): string[] => {
	const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
	const chain: string[] = [];
	let at: string | undefined = tip;
	while (at !== undefined && chain.length < max) {
		chain.push(at);
		at = byHash.get(at)?.parents[0];
	}
	return chain;
};

export const createImportCompletion = (deps: {
	readonly core: Core;
	readonly access: ArtifactsAccess;
	readonly roles: Roles;
	readonly protection: Protection;
}) => {
	const { core, access, roles, protection } = deps;

	const readChain = async (name: string, tip: string): Promise<string[]> => {
		try {
			const commits = await access.control(async () => {
				const repo = await core.ports.artifacts.get(name);
				try {
					return await repo.log({ ref: tip, limit: TRUNK_IMPORT_CHAIN });
				} finally {
					repo[Symbol.dispose]?.();
				}
			});
			return firstParentChain(tip, commits, TRUNK_IMPORT_CHAIN);
		} catch (error) {
			core.ports.log("import chain read failed", { error: errorText(error) });
			return [tip];
		}
	};

	return async (
		by: string,
		input: ImportCompleteRequest,
		source?: string,
	): Promise<ImportCompleteResponse> => {
		if (!isPrincipalId(by)) throw invalid(`invalid principal: ${by}`);
		const identity = repoIdentity(core.sql);
		if (!isImporting(core.sql)) throw conflict("the repo is not importing");
		if (await roles.of({ id: by }) < ROLE.owner) {
			throw denied("role", "only an Owner may complete an import");
		}
		const defaultBranch = input.defaultBranch ?? identity.defaultBranch;
		const head = trunkRef(defaultBranch);
		if (!isValidRefName(head)) {
			throw invalid(`invalid default branch: ${defaultBranch}`);
		}
		const token = await access.token(identity.artifactsName, "read");
		const advertised = await core.ports.lsRefs(
			{ url: token.remote, authorization: authorizationFor(token.token) },
			{ refPrefixes: ["refs/heads/", "refs/tags/"], peel: true },
		);
		const tip = advertised.find((ref) => ref.ref === head)?.sha;
		if (tip === undefined) {
			throw invalid(`the default branch ${head} has not been pushed`);
		}
		const chain = await readChain(identity.artifactsName, tip);
		const result = core.tx(() => {
			if (!isImporting(core.sql)) throw conflict("the repo is not importing");
			const upstream = new Map(advertised.map((ref) => [ref.ref, ref]));
			for (
				const { ref } of rows<{ ref: string }>(
					core.sql,
					"SELECT ref FROM refs WHERE ref LIKE 'refs/heads/%' OR ref LIKE 'refs/tags/%'",
				)
			) {
				if (!upstream.has(ref)) {
					core.sql.exec("DELETE FROM refs WHERE ref = ?", ref);
				}
			}
			setMeta(core.sql, "default_branch", defaultBranch);
			for (const ref of advertised) {
				if (!isValidRefName(ref.ref) || !isSha(ref.sha)) continue;
				writeRef(core, ref.ref, ref.sha, {
					peeled: ref.peeled !== undefined && isSha(ref.peeled)
						? ref.peeled
						: null,
				});
			}
			const now = core.clock.now();
			core.sql.exec("UPDATE refs SET reconciled_at = ?", now);
			const trunkCommits = recordImportChainSync(core, chain);
			setMeta(core.sql, "import_state", "none");
			emit(core, {
				type: "repo.imported",
				data: {
					repoId: identity.repoId,
					path: identity.path,
					artifactsName: identity.artifactsName,
					source: source ?? "import-mode",
				},
			});
			return {
				repoId: identity.repoId,
				defaultBranch,
				trunkSha: tip,
				refs: advertised.length,
				trunkCommits,
			};
		});
		protection.invalidate();
		return result;
	};
};
