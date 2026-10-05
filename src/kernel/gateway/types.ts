// The gateway's ports (WP4): everything it needs from the rest of the kernel,
// as narrow interfaces so the handlers run in Deno tests, in workerd and
// behind the router with the same code. `deps.ts` builds them from `Env`.

import type { EffectiveRole, NodeDto } from "@tartan/contract";
import type {
	AuthContext,
	CanonicalPushPolicy,
	LaneRepoPushPolicy,
	RepoCoreFacade,
	RepoProbeApi,
	ResolvedPath,
} from "@tartan/contract/kernel.ts";

/** The two smart-HTTP services. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/** WP3's tree, as the gateway reads it (ForgeDO `tree()`; cached per isolate by `deps.ts`). */
export type GatewayTree = {
	resolvePath(path: string): Promise<ResolvedPath | null>;
	/** Grants and synthesized root owners only (no visibility; see `access.ts`). */
	effectiveRole(principals: string[], nodeId: string): Promise<EffectiveRole>;
	node(id: string): Promise<NodeDto | null>;
};

/** The RepoDO `core()` methods the gateway calls (WP5a; `getLane` for lane remotes). */
export type GatewayRepo = Pick<
	RepoCoreFacade,
	| "pushContext"
	| "readContext"
	| "recordPush"
	| "recordRejection"
	| "recordDiff"
	| "upstream"
	| "refs"
	| "getLane"
>;

export type GatewayConfig = {
	/** `MAX_PUSH_BYTES` (`TARTAN_MAX_PUSH_MB`). */
	readonly maxPushBytes: number;
	/** `ECHO_ENABLED`: band-2 guidance on synthesized rejections. */
	readonly echo: boolean;
	/** `UPSTREAM_AUTH`. */
	readonly upstreamAuth: "bearer" | "basic";
	/** `PHASE1_FLUSH_WAIT_MS`: how long the final flush waits for phase 1. */
	readonly phase1WaitMs: number;
	/**
	 * The ref-policy classifier. Tests replace it (an allow-all fake proves the
	 * canonical write precheck holds on its own).
	 */
	readonly policy: CanonicalPushPolicy;
	/**
	 * The lane-remote classifier. Tests replace it (an allow-all
	 * fake proves that the lane-repo-scoped upstream token, layer 2, holds
	 * on its own).
	 */
	readonly lanePolicy: LaneRepoPushPolicy;
};

export type GatewayDeps = {
	readonly tree: GatewayTree;
	readonly repo: (repoId: string) => GatewayRepo;
	/**
	 * The forge Owner (import mode). No RPC exposes it yet
	 * (a contract request), so the default answers false and an
	 * importing repo refuses every push.
	 */
	readonly isForgeOwner: (principal: string) => Promise<boolean>;
	/** RepoProbe (WP8) for phase 2 of push recording. */
	readonly probe: () => Pick<RepoProbeApi, "laneDiff">;
	/** Outbound fetch to the Artifacts git remotes. */
	readonly fetch: (request: Request) => Promise<Response>;
	readonly requestId: () => string;
	readonly log: (message: string, data: Record<string, unknown>) => void;
	readonly config: GatewayConfig;
};

/** One git request as the route handlers hand it over. */
export type GitRequest = {
	readonly req: Request;
	readonly url: URL;
	/** The node path the router captured (`acme/shop`, without `.git`). */
	readonly repoPath: string;
	/**
	 * A lane remote's lane id (`/<repoPath>/-/lanes/<laneId>.git/…`, exactly
	 * a lowercase `ln_<ulid>`, checked by the route); absent on the canonical
	 * URL.
	 */
	readonly laneId?: string;
	readonly auth: AuthContext | null;
	readonly waitUntil: (promise: Promise<unknown>) => void;
};
