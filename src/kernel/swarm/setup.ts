// Provisioning the swarm's sim repos (WP20): the
// group `<namespace>/sim`, one repo per shard (`router-<nn>`) on the
// `branch` lane backend (`meta.lane_mode='branch'`: lanes open instantly, no
// Artifacts call per lane), the sample monorepo written onto each repo's
// trunk once (a kernel write with purpose `seed`, K1: registered before the
// push, marked `pushed` after it, so the ref index and push log explain the
// move), the Swarm pack in force on the sim group and the HUD (tartan.hud)
// on the namespace so it counts the swarm. Idempotent: a shard that exists
// is reused, a scaffold already on trunk is not written again.
//
// Never on a demo repo: everything lives under `<namespace>/sim`.

import {
	type NodeDto,
	type RepoInfo,
	type RepoLaneSettingsRequest,
	trunkRef,
} from "@tartan/contract";
import type {
	KernelWriteIntent,
	KernelWriteRow,
	PushCommand,
} from "@tartan/contract/kernel.ts";
import { pushRefs, writePack } from "@tartan/gitproto";
import { upstreamAuthorization } from "../tree/genesis.ts";
import {
	buildCommit,
	type DirEntry,
	normalizeMode,
	treeStateOf,
} from "./gittree.ts";
import type { ShardPlan, SwarmPlan } from "./plan.ts";
import { SAMPLE_FILES } from "./sample.ts";

/** The facades setup needs (ForgeDO tree and registry, RepoDO core, Artifacts). */
export type SetupDeps = {
	readonly by: string;
	resolve(path: string): Promise<NodeDto | null>;
	createGroup(
		parentId: string,
		slug: string,
		description: string,
	): Promise<NodeDto>;
	createRepo(
		parentId: string,
		slug: string,
		description: string,
	): Promise<NodeDto>;
	/** Installed extension ids in force at a node. */
	inForce(nodeId: string): Promise<readonly string[]>;
	install(extId: string, node: string): Promise<void>;
	repo(repoId: string): {
		info(): Promise<RepoInfo>;
		setLaneSettings(input: RepoLaneSettingsRequest): Promise<unknown>;
		/** Every event of the repo carries `sim: true` from now on. */
		markSimulated(): Promise<void>;
		upstream(): Promise<
			{ remote: string; token: string; artifactsName: string }
		>;
		registerKernelWrite(intent: KernelWriteIntent): Promise<KernelWriteRow>;
		markKernelWrite(id: string, state: "pushed" | "abandoned"): Promise<void>;
	};
	/** Reads the canonical repo's objects (the Artifacts binding, by name). */
	objects(artifactsName: string): Promise<{
		readCommit(sha: string): Promise<{ treeHash: string } | null>;
		readTree(
			sha: string,
		): Promise<
			| readonly { name: string; mode: string; hash: string; type: string }[]
			| null
		>;
	}>;
	/** The git transport to the Artifacts remote (default: global fetch). */
	readonly fetch?: typeof fetch;
	readonly now: () => number;
};

export type ShardReady = {
	readonly index: number;
	readonly path: string;
	readonly repoId: string;
	readonly trunk: string;
	/** True when this call wrote the sample monorepo onto trunk. */
	readonly scaffolded: boolean;
};

/** Members of the Swarm pack the sim repos need in force. */
const SWARM_MEMBERS = ["tartan.work", "tartan.changes"];

export const SIM_GROUP_DESCRIPTION =
	"Simulated swarm repositories (dev stages only): every lane and change here belongs to a simulated agent";

const ensureGroup = async (
	deps: SetupDeps,
	path: string,
): Promise<NodeDto> => {
	const existing = await deps.resolve(path);
	if (existing) return existing;
	const parentPath = path.split("/").slice(0, -1).join("/");
	const parent = await deps.resolve(parentPath);
	if (!parent) throw new Error(`no namespace ${parentPath}`);
	return await deps.createGroup(
		parent.id,
		path.split("/").at(-1)!,
		SIM_GROUP_DESCRIPTION,
	);
};

/** Lists `path` of `commit` through the binding (null: missing). */
const readerOf = (objects: Awaited<ReturnType<SetupDeps["objects"]>>) =>
async (
	commit: string,
	path: string,
): Promise<readonly DirEntry[] | null> => {
	const meta = await objects.readCommit(commit);
	if (!meta) return null;
	let tree = meta.treeHash;
	for (const part of path.split("/").filter((p) => p !== "")) {
		const entries = await objects.readTree(tree);
		const next = entries?.find((e) => e.name === part);
		if (!next || next.type !== "tree") return null;
		tree = next.hash;
	}
	const entries = await objects.readTree(tree);
	return entries
		? entries.map((e) => ({
			name: e.name,
			mode: normalizeMode(e.mode),
			id: e.hash,
		}))
		: null;
};

/** Writes the sample monorepo onto trunk unless it is already there. */
export const scaffold = async (
	deps: SetupDeps,
	repoId: string,
	ownerId: string,
): Promise<{ trunk: string; scaffolded: boolean }> => {
	const core = deps.repo(repoId);
	const info = await core.info();
	if (info.trunkSha === null) throw new Error(`${info.path} has no trunk yet`);
	const upstream = await core.upstream();
	const objects = await deps.objects(upstream.artifactsName);
	const read = readerOf(objects);
	const root = (await read(info.trunkSha, "")) ?? [];
	if (root.some((e) => e.name === "pnpm-workspace.yaml")) {
		return { trunk: info.trunkSha, scaffolded: false };
	}
	const built = await buildCommit({
		state: treeStateOf(info.trunkSha),
		read,
		edits: Object.entries(SAMPLE_FILES).map(([path, content]) => ({
			path,
			content,
		})),
		message:
			"Sample monorepo for simulated agents\n\nWritten by the swarm (dev stages only).",
		author: {
			name: "Tartan swarm",
			email: "swarm@tartan.invalid",
			at: Math.floor(deps.now() / 1000),
		},
	});
	const ref = trunkRef(info.defaultBranch);
	const intent = await core.registerKernelWrite({
		target: "repo",
		ref,
		expectOld: info.trunkSha,
		newSha: built.commit,
		purpose: "seed",
		ownerKind: "kernel",
		ownerId,
	});
	const { pack } = await writePack(built.objects);
	const commands: PushCommand[] = [{
		ref,
		old: info.trunkSha,
		new: built.commit,
	}];
	try {
		const [status] = await pushRefs(
			{
				url: upstream.remote,
				authorization: upstreamAuthorization(upstream.token),
				...(deps.fetch ? { fetch: deps.fetch } : {}),
			},
			commands,
			{ pack },
		);
		if (!status?.ok) {
			throw new Error(
				`scaffold push refused: ${status?.reason ?? "no status"}`,
			);
		}
	} catch (error) {
		await core.markKernelWrite(intent.id, "abandoned").catch(() => {});
		throw error;
	}
	await core.markKernelWrite(intent.id, "pushed");
	return { trunk: built.commit, scaffolded: true };
};

const ensureShard = async (
	deps: SetupDeps,
	plan: SwarmPlan,
	group: NodeDto,
	shard: ShardPlan,
): Promise<ShardReady> => {
	const repo = (await deps.resolve(shard.path)) ??
		(await deps.createRepo(
			group.id,
			shard.slug,
			`Simulated swarm shard ${shard.index + 1} (dev only)`,
		));
	if (repo.kind !== "repo") throw new Error(`${shard.path} is not a repo`);
	await deps.repo(repo.id).setLaneSettings({ laneMode: "branch" });
	await deps.repo(repo.id).markSimulated();
	const { trunk, scaffolded } = await scaffold(
		deps,
		repo.id,
		`swarm:${plan.swarmId}`,
	);
	return {
		index: shard.index,
		path: shard.path,
		repoId: repo.id,
		trunk,
		scaffolded,
	};
};

/** Everything the cohorts need before they start. */
export const prepareSwarm = async (
	deps: SetupDeps,
	plan: SwarmPlan,
): Promise<readonly ShardReady[]> => {
	const namespace = await deps.resolve(plan.namespace);
	if (!namespace) throw new Error(`no namespace ${plan.namespace}`);
	const group = await ensureGroup(deps, plan.simGroup);
	const atGroup = await deps.inForce(group.id);
	if (!SWARM_MEMBERS.every((id) => atGroup.includes(id))) {
		await deps.install("tartan.pack.swarm", plan.simGroup);
	}
	if (!(await deps.inForce(namespace.id)).includes("tartan.hud")) {
		await deps.install("tartan.hud", plan.namespace);
	}
	const shards: ShardReady[] = [];
	for (const shard of plan.shards) {
		shards.push(await ensureShard(deps, plan, group, shard));
	}
	return shards;
};
