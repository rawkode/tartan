// The `branch` lane backend (WP5a): lanes are
// branches `refs/heads/lanes/<laneId>` of the canonical repo. Opening one
// makes no Artifacts call (the ref appears on the owner's first push); its
// head is read with one `ls-refs ref-prefix` of exactly its ref; lane GC
// deletes the ref with a ref-only `lane-gc` CAS write (WP10's `refWrite`)
// at the head recorded at close, and only there.

import { unavailable, ZERO_SHA } from "@tartan/contract";
import type {
	LaneBackend,
	LaneFetchSpec,
	LaneGcOutcome,
	LaneRow,
	Upstream,
} from "@tartan/contract/kernel.ts";
import { type Core, repoIdentity } from "../core.ts";
import { authorizationFor } from "../gitremote.ts";
import type { ArtifactsAccess } from "../upstream.ts";

export type BranchBackendDeps = {
	readonly core: Core;
	readonly access: ArtifactsAccess;
};

export const createBranchLaneBackend = (
	deps: BranchBackendDeps,
): LaneBackend => {
	const { core, access } = deps;
	const canonicalName = (): string => repoIdentity(core.sql).artifactsName;

	const remoteFor = async (
		lane: LaneRow,
		scope: "read" | "write",
	): Promise<Upstream> => {
		const name = canonicalName();
		const token = await access.token(name, scope);
		return {
			artifactsName: name,
			remote: token.remote,
			token: token.token,
			expiresAt: token.expiresAt,
			kind: "lane-branch",
			ref: lane.ref,
		};
	};

	const readTip = async (lane: LaneRow): Promise<string | null> => {
		const token = await access.token(canonicalName(), "read");
		const refs = await core.ports.lsRefs(
			{ url: token.remote, authorization: authorizationFor(token.token) },
			{ refPrefixes: [lane.ref] },
		);
		return refs.find((ref) => ref.ref === lane.ref)?.sha ?? null;
	};

	const fetchSpec = (_lane: LaneRow, sha: string): LaneFetchSpec => {
		const name = canonicalName();
		const remote = access.knownRemote(name);
		if (remote === null) {
			throw unavailable(`the remote of ${name} is not known yet`);
		}
		return { remote, sha, token: { artifactsName: name, scope: "read" } };
	};

	const gc = async (
		lane: LaneRow,
		expectHead: string,
	): Promise<LaneGcOutcome> => {
		const tip = await readTip(lane);
		if (tip === null) return { deleted: false, reason: "missing" };
		if (tip !== expectHead || expectHead === ZERO_SHA) {
			return { deleted: false, reason: "head-moved" };
		}
		const [result] = await core.ports.gitJobs.refWrite(
			repoIdentity(core.sql).repoId,
			[{
				target: lane.id,
				ref: lane.ref,
				expectOld: expectHead,
				newSha: ZERO_SHA,
				purpose: "lane-gc",
				ownerKind: "kernel",
				ownerId: `lane-gc:${lane.id}`,
			}],
		);
		if (result?.ok === true) return { deleted: true };
		const after = await readTip(lane);
		return after === null
			? { deleted: false, reason: "missing" }
			: { deleted: false, reason: "head-moved" };
	};

	return { name: "branch", remoteFor, readTip, fetchSpec, gc };
};
