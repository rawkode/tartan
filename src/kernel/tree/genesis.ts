// Repo genesis (WP3 until WP10's `KernelGitJobs.genesis` exists; K1): the first
// commit on the default branch of a created repo, written in the Worker with
// `@tartan/gitproto`'s pack writer and ref-only push client, no container. The
// K1 intent (`purpose: "genesis"`) is registered in RepoDO before the push and
// marked `pushed` after it; RepoDO then sets the ref index and `trunk_commits`
// seq 0 (WP5a's ledger).
//
// Not here (WP10): the advance #0 rows
// (`land_batches`/`advances`, reason `{events: [repo.created]}`) and the
// `Tartan-Advance` trailer that names them. The port has WP10's signature,
// so `createKernelGitJobs(env).genesis` replaces this file one-for-one.

import { tartanError, trunkRef, ZERO_SHA } from "@tartan/contract";
import type {
	Clock,
	RepoCoreFacade,
	ResolvedSha,
} from "@tartan/contract/kernel.ts";
import {
	encodeCommit,
	encodeTree,
	hashObject,
	type PackObject,
	pushRefs,
	writePack,
} from "@tartan/gitproto";
import { UPSTREAM_AUTH } from "../../constants.ts";
import type { GenesisPort } from "./context.ts";

/** The RepoDO `core` calls genesis makes (WP5a). */
export type GenesisCore = Pick<
	RepoCoreFacade,
	"upstream" | "registerKernelWrite" | "markKernelWrite"
>;

export type GenesisDeps = {
	core(repoId: string): GenesisCore;
	readonly clock: Clock;
	/** The git transport to the Artifacts remote (default: global `fetch`). */
	readonly fetch?: typeof fetch;
};

/** WP3's genesis takes an optional title for the README. */
export type GenesisRequest = Parameters<GenesisPort>[1];

/** The upstream `Authorization` header for an Artifacts remote (`UPSTREAM_AUTH`). */
export const upstreamAuthorization = (token: string): string => {
	if (UPSTREAM_AUTH === "bearer") return `Bearer ${token}`;
	const secret = token.replace(/\?expires=\d+$/, "");
	return `Basic ${btoa(`x:${secret}`)}`;
};

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const README_TEXT = (title: string): string =>
	`# ${title}\n\nThis repository is hosted on Tartan. Agents work in lanes; trunk moves only through the kernel's Advance.\n`;

export type GenesisCommit = {
	readonly commit: ResolvedSha;
	readonly tree: string;
	readonly objects: readonly PackObject[];
};

/**
 * The objects of the genesis commit: `README.md`, the root tree, the commit
 * (ADR repo config: no `.tartan/` tree; Tartan config is the package `tartan`
 * of root `*.cue` files a repository adds when it wants one).
 */
export const buildGenesisCommit = async (
	input: GenesisRequest,
	atSeconds: number,
): Promise<GenesisCommit> => {
	const readme: PackObject = {
		type: "blob",
		data: utf8(README_TEXT(input.title ?? "Repository")),
	};
	const readmeId = await hashObject("blob", readme.data);
	const root: PackObject = {
		type: "tree",
		data: encodeTree([{ mode: "100644", name: "README.md", id: readmeId }]),
	};
	const rootId = await hashObject("tree", root.data);
	const signature = {
		name: input.author.name,
		email: input.author.email,
		at: atSeconds,
	};
	const message = input.message.endsWith("\n")
		? input.message
		: `${input.message}\n`;
	const commit: PackObject = {
		type: "commit",
		data: encodeCommit({ tree: rootId, author: signature, message }),
	};
	const commitId = await hashObject("commit", commit.data);
	return {
		commit: commitId as ResolvedSha,
		tree: rootId,
		objects: [readme, root, commit],
	};
};

/**
 * `genesis(repoId, input)`: builds the commit, registers the K1 intent,
 * pushes `zeros → commit` to the default branch with a write token scoped to
 * the canonical repo (memory only, K11), and marks the intent `pushed` (or
 * `abandoned` when the push fails).
 */
export const createGenesis = (deps: GenesisDeps): GenesisPort =>
async (
	repoId: string,
	input: GenesisRequest,
): Promise<{ commit: string }> => {
	const built = await buildGenesisCommit(
		input,
		Math.floor(deps.clock.now() / 1000),
	);
	const { pack } = await writePack(built.objects);
	const core = deps.core(repoId);
	const ref = trunkRef(input.defaultBranch);
	const upstream = await core.upstream({}, "write");
	const intent = await core.registerKernelWrite({
		target: "repo",
		ref,
		expectOld: ZERO_SHA,
		newSha: built.commit,
		purpose: "genesis",
		ownerKind: "kernel",
		ownerId: `genesis:${repoId}`,
	});
	try {
		const [status] = await pushRefs(
			{
				url: upstream.remote,
				authorization: upstreamAuthorization(upstream.token),
				...(deps.fetch ? { fetch: deps.fetch } : {}),
			},
			[{ ref, old: ZERO_SHA, new: built.commit }],
			{ pack },
		);
		if (!status.ok) {
			throw tartanError("conflict", `genesis push refused: ${status.reason}`, {
				reason: "genesis",
			});
		}
	} catch (error) {
		await core.markKernelWrite(intent.id, "abandoned").catch(() => {});
		throw error;
	}
	await core.markKernelWrite(intent.id, "pushed");
	return { commit: built.commit };
};
