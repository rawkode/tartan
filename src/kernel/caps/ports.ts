// The kernel seams `createKernelCaps` and the extension host call. Every
// argument reaching a port has already been checked by caps: grants, mode,
// read-only, K12 confinement and the actor's role. `createKernelPorts(env)`
// implements the ports on the owning modules' facades (ForgeDO
// tree/registry/identity/events, RepoDO core/events/land/ runs, InboxDO,
// RepoProbe, the Artifacts binding, Workers AI and other ExtensionDOs); tests
// pass fakes of the same shape.
//
// Reads go by SHA (K15): a ref is resolved by RepoDO (`resolveRef`, never the
// binding), and the bytes are read from the repo that holds the source (the
// canonical repo, or the current lane repo of a `repo`-backend lane, named by
// `laneFetchSpecs`).

import {
	type ActorBounds,
	type CommitMeta,
	type EffectiveRole,
	extDoName,
	type ExtScope,
	FORGE_DO_NAME,
	type GitSource,
	inboxDoName,
	type NodeKind,
	type NodeRef,
	notFound,
	type NoticeInput,
	notImplemented,
	type Presence,
	type PrincipalInfo,
	repoArtifactsName,
	repoDoName,
	type ToolContext,
	type Trailer,
	type TreeEntryType,
} from "@tartan/contract";
import type {
	ForgeEventsFacade,
	InstallationInForce,
	RepoConfigFacade,
	RepoCoreFacade,
	RepoEventsFacade,
	RepoLandFacade,
	RepoProbeApi,
	RepoRunsFacade,
} from "@tartan/contract/kernel.ts";
import { disposingFacade, withRpc } from "../../do/dispose.ts";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";

/** A node as caps sees it after resolution (current path). */
export type PortNode = {
	readonly id: string;
	readonly path: string;
	readonly kind: NodeKind;
};

const REPO_CORE_METHODS = [
	"info",
	"resolveRef",
	"getLane",
	"listLanes",
	"openLane",
	"adoptLane",
	"closeLane",
	"archiveLane",
	"delegateLane",
	"syncLane",
	"restackLane",
	"laneRange",
	"laneFetchSpecs",
] as const satisfies readonly (keyof RepoCoreFacade)[];
const REPO_EVENTS_METHODS = [
	"append",
	"read",
	"head",
] as const satisfies readonly (keyof RepoEventsFacade)[];
const REPO_LAND_METHODS = [
	"submit",
	"status",
	"report",
	"contributeNote",
] as const satisfies readonly (keyof RepoLandFacade)[];
const REPO_CONFIG_METHODS = [
	"policy",
] as const satisfies readonly (keyof RepoConfigFacade)[];
const REPO_RUNS_METHODS = [
	"start",
	"get",
	"cancel",
	"logs",
] as const satisfies readonly (keyof RepoRunsFacade)[];

/** The RepoDO facades caps calls, for one repo. */
export type RepoPorts = {
	readonly core: Pick<RepoCoreFacade, typeof REPO_CORE_METHODS[number]>;
	readonly events: Pick<RepoEventsFacade, typeof REPO_EVENTS_METHODS[number]>;
	readonly land: Pick<RepoLandFacade, typeof REPO_LAND_METHODS[number]>;
	readonly runs: Pick<RepoRunsFacade, typeof REPO_RUNS_METHODS[number]>;
	/** Repo policy at a trunk commit (`caps.repo.policy`; ADR repo config). */
	readonly repoconfig: Pick<
		RepoConfigFacade,
		typeof REPO_CONFIG_METHODS[number]
	>;
};

export type SourceTreeEntry = {
	readonly name: string;
	readonly mode: string;
	readonly hash: string;
	readonly type: TreeEntryType;
};

/** SHA-only reads bound to the repo that holds one `GitSource` (K15). */
export type SourceReader = {
	commit(sha: string): Promise<CommitMeta | null>;
	/** Immediate children of a tree object. */
	tree(sha: string): Promise<readonly SourceTreeEntry[] | null>;
	/** A file at a commit. */
	file(commit: string, path: string): Promise<Uint8Array | null>;
	/** First-parent history from `from`, newest first. */
	log(from: string, limit: number): Promise<CommitMeta[]>;
};

/** Where an `interfaces.call` goes: the provider's ExtensionDO. */
export type ToolTarget = {
	readonly installationId: string;
	readonly scope: ExtScope;
};

export type NoticeDelivery = NoticeInput & {
	readonly source: string;
	readonly sourceLabel?: string;
};

export interface KernelPorts {
	/** Resolves a node by id or exact path (a redirect resolves to the moved node). */
	node(ref: NodeRef): Promise<PortNode | null>;
	/** The role the principals hold at a node from grants (no credential bounds). */
	effectiveRole(
		principals: readonly string[],
		nodeId: string,
	): Promise<EffectiveRole>;
	principal(id: string): Promise<PrincipalInfo | null>;
	/** The nearest enforce provider of an interface at a node (locked ancestors honoured). */
	provider(iface: string, nodeId: string): Promise<InstallationInForce | null>;
	repo(repoId: string): RepoPorts;
	readonly forgeEvents: Pick<
		ForgeEventsFacade,
		"read" | "readPage" | "head" | "appendKernel"
	>;
	readonly probe: Pick<
		RepoProbeApi,
		| "diffPaths"
		| "hunks"
		| "merge3"
		| "diff"
		| "projectGraph"
		| "affected"
		| "treeHash"
	>;
	reader(source: GitSource): Promise<SourceReader>;
	deliverNotice(principal: string, notice: NoticeDelivery): Promise<void>;
	/** Presence of the principals active in a repo. */
	presence(repoId: string): Promise<Presence[]>;
	/** `callTool` on another installation's ExtensionDO (call chain passed along). */
	callTool(
		target: ToolTarget,
		name: string,
		args: unknown,
		ctx: ToolContext,
		bounds: ActorBounds,
		chain: readonly string[],
	): Promise<unknown>;
	/** Workers AI with a JSON-schema response (builtin-only permission). */
	ai(model: string, prompt: string, schema: object): Promise<unknown>;
	/** A model var (`TARTAN_JUDGE_MODEL`) by name; undefined when unknown. */
	modelVar(name: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Artifacts reads by SHA
// ---------------------------------------------------------------------------

type ArtifactsCommit = {
	readonly hash: string;
	readonly treeHash: string;
	readonly message: string;
	readonly author: { readonly name: string; readonly email: string };
	readonly committer: { readonly name: string; readonly email: string };
	readonly parents: readonly string[];
	readonly authoredAt: number;
	readonly committedAt: number;
};

const TRAILER_RE = /^([A-Za-z0-9][A-Za-z0-9-]*):\s*(.*)$/;

/** Trailers: the `Key: value` lines of the last paragraph, when every line is one. */
export const parseTrailers = (message: string): Trailer[] => {
	const paragraphs = message.trimEnd().split(/\n\s*\n/);
	if (paragraphs.length < 2) return [];
	const lines = paragraphs[paragraphs.length - 1].split("\n");
	const parsed = lines.map((line) => TRAILER_RE.exec(line));
	if (parsed.some((m) => m === null)) return [];
	return parsed.map((m) => ({ key: m![1], value: m![2] }));
};

export const toCommitMeta = (c: ArtifactsCommit): CommitMeta => ({
	sha: c.hash,
	treeSha: c.treeHash,
	subject: c.message.split("\n", 1)[0] ?? "",
	message: c.message,
	author: { name: c.author.name, email: c.author.email },
	committer: { name: c.committer.name, email: c.committer.email },
	parents: [...c.parents],
	authoredAt: c.authoredAt,
	committedAt: c.committedAt,
	trailers: parseTrailers(c.message),
});

const readerOver = (open: () => Promise<ArtifactsRepo>): SourceReader => ({
	commit: async (sha) => {
		using repo = await open();
		const c = await repo.readCommit(sha);
		return c === null ? null : toCommitMeta(c);
	},
	tree: async (sha) => {
		using repo = await open();
		const entries = await repo.readTree(sha);
		return entries === null ? null : entries.map((e) => ({
			name: e.name,
			mode: e.mode,
			hash: e.hash,
			type: e.type,
		}));
	},
	file: async (commit, path) => {
		using repo = await open();
		const blob = await repo.readFile({ ref: commit, path });
		return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
	},
	log: async (from, limit) => {
		using repo = await open();
		const commits = await repo.log({ ref: from, limit });
		return commits.map(toCommitMeta);
	},
});

// ---------------------------------------------------------------------------
// The real ports
// ---------------------------------------------------------------------------

const forge = (env: Env) => env.FORGE.getByName(FORGE_DO_NAME);

/** RepoProbe over the Worker's loopback entrypoint (`ctx.exports`). */
const probePorts = (
	host: { readonly exports: unknown } | undefined,
): KernelPorts["probe"] => {
	const probe = () => {
		if (host === undefined) {
			throw notImplemented("RepoProbe needs the loopback ctx.exports");
		}
		return loopback(host).RepoProbe;
	};
	return {
		diffPaths: (source, base, head) => probe().diffPaths(source, base, head),
		hunks: (source, base, head, paths) =>
			probe().hunks(source, base, head, paths),
		merge3: (input) => probe().merge3(input),
		diff: (a, b) => probe().diff(a, b),
		projectGraph: (repoId, sha) => probe().projectGraph(repoId, sha),
		affected: (repoId, base, head, options) =>
			probe().affected(repoId, base, head, options),
		treeHash: (source, sha, path) => probe().treeHash(source, sha, path),
	};
};

/**
 * The kernel ports on the real facades (see the header). `host` is the
 * caller's `ExecutionContext` or `DurableObjectState`, for the loopback
 * RepoProbe entrypoint.
 */
export const createKernelPorts = (
	env: Env,
	host?: { readonly exports: unknown },
): KernelPorts => {
	// Facades are opened per call and disposed when it settles: a
	// `repo(id)` view opens nothing until a method is called.
	const repo = (repoId: string): RepoPorts => {
		const stub = () => env.REPO.getByName(repoDoName(repoId));
		return {
			core: disposingFacade(
				() => stub().core() as unknown as RepoPorts["core"],
				REPO_CORE_METHODS,
			),
			events: disposingFacade(
				() => stub().events() as unknown as RepoPorts["events"],
				REPO_EVENTS_METHODS,
			),
			land: disposingFacade(
				() => stub().land() as unknown as RepoPorts["land"],
				REPO_LAND_METHODS,
			),
			runs: disposingFacade(
				() => stub().runs() as unknown as RepoPorts["runs"],
				REPO_RUNS_METHODS,
			),
			repoconfig: disposingFacade(
				() => stub().repoconfig() as unknown as RepoPorts["repoconfig"],
				REPO_CONFIG_METHODS,
			),
		};
	};
	const forgeEvents = disposingFacade(
		() => forge(env).events() as unknown as KernelPorts["forgeEvents"],
		["read", "readPage", "head", "appendKernel"],
	);
	return {
		node: (ref) =>
			withRpc(() => forge(env).tree(), async (tree) => {
				if ("id" in ref) {
					const node = await tree.node(ref.id);
					return node === null
						? null
						: { id: node.id, path: node.path, kind: node.kind };
				}
				const resolved = await tree.resolvePath(ref.path);
				if (resolved === null || resolved.rest !== "") return null;
				const node = resolved.node;
				return { id: node.id, path: node.path, kind: node.kind };
			}),
		effectiveRole: (principals, nodeId) =>
			withRpc(
				() => forge(env).tree(),
				(tree) => tree.effectiveRole([...principals], nodeId),
			),
		principal: async (id) => {
			const row = await withRpc(
				() => forge(env).identity(),
				(identity) => identity.principal(id),
			);
			if (row === null) return null;
			// Never an email.
			return {
				id: row.id,
				kind: row.kind,
				handle: row.handle,
				display: row.display,
				...(row.agent_tool ? { agentTool: row.agent_tool } : {}),
				...(row.agent_model ? { agentModel: row.agent_model } : {}),
				...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
			};
		},
		provider: (iface, nodeId) =>
			withRpc(
				() => forge(env).registry(),
				(registry) => registry.provider(iface, nodeId),
			),
		repo,
		forgeEvents,
		probe: probePorts(host),
		reader: async (source) => {
			if (source.laneId === undefined) {
				const name = repoArtifactsName(source.repoId);
				return readerOver(() => env.ARTIFACTS.get(name));
			}
			const [spec] = await repo(source.repoId).core.laneFetchSpecs([
				source.laneId,
			]);
			if (spec === undefined) {
				throw notFound(`lane ${source.laneId} not found in ${source.repoId}`);
			}
			const name = spec.token.artifactsName;
			return readerOver(() => env.ARTIFACTS.get(name));
		},
		deliverNotice: async (principal, notice) => {
			await env.INBOX.getByName(inboxDoName(principal)).deliver(notice);
		},
		presence: () =>
			Promise.reject(
				notImplemented(
					"caps.principals.presence (no RepoDO presence read yet)",
				),
			),
		callTool: (target, name, args, ctx, bounds, chain) =>
			env.EXT.getByName(extDoName(target.installationId, target.scope))
				.callTool(name, args, ctx, bounds, chain),
		ai: async (model, prompt, schema) => {
			const run = env.AI.run as unknown as (
				model: string,
				input: unknown,
			) => Promise<{ response?: unknown }>;
			const out = await run(model, {
				messages: [{ role: "user", content: prompt }],
				response_format: { type: "json_schema", json_schema: schema },
			});
			const response = out.response;
			return typeof response === "string" ? JSON.parse(response) : response;
		},
		modelVar: (name) =>
			name === "TARTAN_JUDGE_MODEL" ? env.TARTAN_JUDGE_MODEL : undefined,
	};
};
