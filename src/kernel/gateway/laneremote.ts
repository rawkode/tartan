// Lane remotes of the `repo` backend (WP4): `/<repoPath>/-/lanes/<laneId>
// .git/…` proxies the lane's current lane repo (`lanes.repo_name`) and nothing
// else, without ref rewriting; the URL never names a raw Artifacts repo.
//
// - The lane must be a `repo` lane of the repo the path resolves to, in any
//   state from `opening` to `archived` (a `deleted` lane's repo is gone),
//   else 404; so must its lane repo (an `opening` lane may have none yet).
// - No public view on any visibility: anonymous callers get 401, roleless
//   ones 404, upload-pack needs the member view (Reporter+), receive-pack
//   Developer+ at this lane with the `lanes` or `repo:write` scope.
// - Advertisements are the lane repo's own refs (normally `HEAD` and
//   `refs/heads/main`), unfiltered, with the capability allowlists of the
//   canonical repo. A receive-pack advertisement mints a lane-repo write
//   token only for the lane's owner or a delegate while the lane takes
//   pushes; anyone else gets an empty advertisement and every push they send
//   is refused by the lane-remote table.
// - Upload-pack requests pass through undecoded (members may fetch any
//   object of a lane); receive-pack is `receive.ts` with the lane target.

import { fromRpcError, type Lane, type LaneState } from "@tartan/contract";
import type { AuthContext, Upstream } from "@tartan/contract/kernel.ts";
import {
	RECEIVE_PACK_CAPABILITIES,
	rewriteAdvertisement,
	rewriteV2Capabilities,
	UPLOAD_PACK_V0_CAPABILITIES,
	UPLOAD_PACK_V2_CAPABILITIES,
} from "@tartan/gitproto";
import { laneNotFound, type RepoAccess, resolveAccess } from "./access.ts";
import { CONTENT_TYPE, gitBody, gitText } from "./respond.ts";
import type { GatewayDeps, GatewayRepo, GitRequest } from "./types.ts";
import {
	emptyReceiveAdvertisement,
	readAdvertisement,
	relayUpload,
	upstreamFailed,
} from "./upload.ts";
import { callUpstream } from "./upstream.ts";
import { isV2Advertisement } from "./views.ts";

/** States in which a lane remote's owner gets the real receive-pack advertisement. */
const PUSHABLE_STATES: ReadonlySet<LaneState> = new Set([
	"open",
	"submitted",
	"landing",
	"lost",
]);

const isNotFound = (error: unknown): boolean =>
	fromRpcError(error).code === "not_found";

/**
 * The lane a lane remote names, or null (answered 404): unknown, another
 * repo's, a `branch` lane, or `deleted` (its lane repo was collected).
 */
export const laneOf = async (
	repo: GatewayRepo,
	repoId: string,
	laneId: string,
): Promise<Lane | null> => {
	let lane: Lane | null;
	try {
		lane = await repo.getLane(laneId);
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
	if (
		lane === null || lane.id !== laneId || lane.repoId !== repoId ||
		lane.mode !== "repo" || lane.state === "deleted"
	) {
		return null;
	}
	return lane;
};

/** The lane repo's upstream, or null when it does not exist (yet, or any more). */
export const laneUpstream = async (
	repo: GatewayRepo,
	laneId: string,
	scope: "read" | "write",
): Promise<Upstream | null> => {
	try {
		const upstream = await repo.upstream({ laneId }, scope);
		// Layer 2 needs a lane repo here, never the canonical repo (fail closed).
		return upstream.kind === "lane-repo" ? upstream : null;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
};

/** The owner or a delegate, with a token not pinned to another lane. */
const mayPushLane = (auth: AuthContext, lane: Lane): boolean =>
	(lane.owner === auth.principal || lane.delegates.includes(auth.principal)) &&
	(auth.laneId === null || auth.laneId === lane.id);

const laneAdvertisement = async (
	deps: GatewayDeps,
	r: GitRequest,
	access: RepoAccess,
	service: "git-upload-pack" | "git-receive-pack",
): Promise<Response> => {
	const laneId = r.laneId as string;
	const repo = deps.repo(access.repoId);
	const lane = await laneOf(repo, access.repoId, laneId);
	if (lane === null) return laneNotFound();
	if (service === "git-receive-pack") {
		const auth = r.auth as AuthContext;
		if (!mayPushLane(auth, lane) || !PUSHABLE_STATES.has(lane.state)) {
			return gitBody(
				emptyReceiveAdvertisement(),
				CONTENT_TYPE.receiveAdvertisement,
			);
		}
	}
	const upstream = await laneUpstream(
		repo,
		laneId,
		service === "git-receive-pack" ? "write" : "read",
	);
	if (upstream === null) return laneNotFound();
	const data = { repoId: access.repoId, laneId };
	const body = await readAdvertisement(deps, r, upstream, service, data);
	if (body instanceof Response) return body;
	try {
		if (service === "git-receive-pack") {
			return gitBody(
				rewriteAdvertisement(body, {
					service,
					keepRef: () => true,
					capabilities: { protocol: "v0", names: RECEIVE_PACK_CAPABILITIES },
				}),
				CONTENT_TYPE.receiveAdvertisement,
			);
		}
		return gitBody(
			isV2Advertisement(body)
				? rewriteV2Capabilities(body, {
					protocol: "v2",
					commands: UPLOAD_PACK_V2_CAPABILITIES,
				})
				: rewriteAdvertisement(body, {
					service,
					keepRef: () => true,
					capabilities: {
						protocol: "v0",
						names: UPLOAD_PACK_V0_CAPABILITIES,
					},
				}),
			CONTENT_TYPE.uploadAdvertisement,
		);
	} catch (error) {
		return upstreamFailed(deps, "advertisement", {
			...data,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

/** `GET /<repoPath>/-/lanes/<laneId>.git/info/refs?service=…`. */
export const handleLaneInfoRefs = async (
	deps: GatewayDeps,
	r: GitRequest,
): Promise<Response> => {
	const service = r.url.searchParams.get("service");
	if (service !== "git-upload-pack" && service !== "git-receive-pack") {
		return gitText(403, "only smart HTTP is served (no service given)");
	}
	const access = await resolveAccess(deps.tree, r, service);
	if (access.kind === "response") return access.response;
	return await laneAdvertisement(deps, r, access, service);
};

/** `POST /<repoPath>/-/lanes/<laneId>.git/git-upload-pack` (member view, passed through). */
export const handleLaneUploadPack = async (
	deps: GatewayDeps,
	r: GitRequest,
): Promise<Response> => {
	const access = await resolveAccess(deps.tree, r, "git-upload-pack");
	if (access.kind === "response") return access.response;
	const body = r.req.body;
	if (body === null) return gitText(400, "empty upload-pack request");
	const laneId = r.laneId as string;
	const repo = deps.repo(access.repoId);
	const lane = await laneOf(repo, access.repoId, laneId);
	const upstream = lane === null
		? null
		: await laneUpstream(repo, laneId, "read");
	if (upstream === null) {
		await body.cancel().catch(() => {});
		return laneNotFound();
	}
	let res: Response;
	try {
		res = await callUpstream(deps, r.req, upstream, {
			method: "POST",
			path: "git-upload-pack",
			body,
			encoding: r.req.headers.get("content-encoding"),
		});
	} catch (error) {
		return upstreamFailed(deps, "upload-pack", {
			repoId: access.repoId,
			laneId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return await relayUpload(deps, access, res, null);
};
