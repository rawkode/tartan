// Git smart-HTTP gateway handlers (WP4). The canonical repo
// (`/<repoPath>[.git]/…`) is served here; the router's `POLICY.git` already ran
// WP2's middleware: the canonical host only (403 elsewhere), tokens only (Basic
// password or Bearer `tpat_`/ `tagt_`; cookies are never read), and an invalid
// token is a 401 with the Basic challenge. The handlers answer the 401 of
// anonymous callers that need credentials and everything after it.
//
// Lane remotes (`/<repoPath>/-/lanes/<laneId>.git/…`, the `repo` backend) share
// the three git ops (`laneremote.ts`, `receive.ts`); the capability route
// (`/-/cap/v1/…`) is `cap.ts` under `POLICY.capability` (no credential,
// canonical host only). The two catch-alls answer a plain 404 for unknown git
// paths and capability paths (the capability one counted in the failure
// buckets).

import type { RouteContext, RouteHandler } from "../../router.ts";
import {
	type CapDeps,
	type CapRouteRequest,
	handleCapInfoRefs as capInfoRefs,
	handleCapNotFound as capNotFound,
	handleCapUploadPack as capUploadPack,
} from "./cap.ts";
import { createCapDeps, createGatewayDeps } from "./deps.ts";
import { handleLaneInfoRefs, handleLaneUploadPack } from "./laneremote.ts";
import { handleReceivePack as receivePack } from "./receive.ts";
import type { GatewayDeps, GitRequest } from "./types.ts";
import {
	handleInfoRefs as infoRefs,
	handleUploadPack as uploadPack,
} from "./upload.ts";

const plainNotFound = (): Response =>
	new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

/** The router's context as the gateway reads it (`lane` only on lane remotes). */
export const gitRequestOf = (c: RouteContext): GitRequest => ({
	req: c.req,
	url: c.url,
	repoPath: c.params.repo ?? "",
	...(c.params.lane === undefined ? {} : { laneId: c.params.lane }),
	auth: c.auth,
	waitUntil: (promise) => c.ctx.waitUntil(promise),
});

type GitOp = (deps: GatewayDeps, r: GitRequest) => Promise<Response>;

/**
 * One git op on both URL shapes: the canonical repo, and a lane remote
 * (the router's `lane` group, exactly a lowercase `ln_<ulid>`).
 */
const gitOp = (canonical: GitOp, lane: GitOp): RouteHandler => (c) =>
	(c.params.lane === undefined ? canonical : lane)(
		createGatewayDeps(c.env, c.ctx),
		gitRequestOf(c),
	);

/** `GET …/info/refs?service=git-upload-pack|git-receive-pack`. */
export const handleInfoRefs: RouteHandler = gitOp(infoRefs, handleLaneInfoRefs);

/**
 * `POST …/git-upload-pack` (the canonical public view's fail-closed request
 * parser; a lane remote passes member requests through).
 */
export const handleUploadPack: RouteHandler = gitOp(
	uploadPack,
	handleLaneUploadPack,
);

/** `POST …/git-receive-pack` (fail-closed command peek). */
export const handleReceivePack: RouteHandler = gitOp(receivePack, receivePack);

/** The router's context as the capability route reads it (no auth, ever). */
const capRequestOf = (c: RouteContext): CapRouteRequest => ({
	req: c.req,
	url: c.url,
	waitUntil: (promise) => c.ctx.waitUntil(promise),
});

type CapOp = (deps: CapDeps, c: CapRouteRequest) => Promise<Response>;

const capRoute = (op: CapOp): RouteHandler => (c) =>
	op(createCapDeps(c.env), capRequestOf(c));

/**
 * `GET /-/cap/v1/<exp>/<laneId>/<nonce>/<mac>/<repoId>.git/info/refs`: the
 * capability route's synthesized advertisement (syntax, TTL and MAC are checked
 * in the isolate before any DO call; every failure is a plain 404, or 429 past
 * the failure buckets).
 */
export const handleCapInfoRefs: RouteHandler = capRoute(capInfoRefs);

/** `POST /-/cap/v1/…/git-upload-pack`: a v2 `ls-refs`, or the single-want pack request. */
export const handleCapUploadPack: RouteHandler = capRoute(capUploadPack);

/**
 * Every other `/-/cap/` path, any method (a syntax failure, another op,
 * receive-pack, dumb HTTP, a wrong method on a valid path): a plain 404 with
 * no body, the same as a failed TTL or MAC check, counted in the failure
 * buckets (`CAP_FAILURE_LIMITS`).
 */
export const handleCapNotFound: RouteHandler = capRoute(capNotFound);

/**
 * Any other git-shaped lane path, any method (`/<repo>/-/lanes/<x>.git/…`
 * whose lane id is not exactly a lowercase `ln_<ulid>`, or whose op or
 * method is not one of the lane remote's): 404.
 */
export const handleLaneNotFound: RouteHandler = () => plainNotFound();
