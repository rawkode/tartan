// Test-only (Deno and workerd): an in-memory RepoDO port and a scripted
// upstream for the gateway's unit tests, where a real `git http-backend`
// cannot produce the case (Artifacts' size-error answers, a hang-up, a
// delayed phase 1, a client that goes away, a 95 MB body).

import {
	type Lane,
	type NodeDto,
	notFound,
	ROLE,
	ulid,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AuthContext,
	PushCommand,
	PushContext,
	PushReport,
	ReadContext,
	RecordPushResult,
	ResolvedPath,
	Upstream,
} from "@tartan/contract/kernel.ts";
import { canonicalPushPolicy, laneRepoPolicy } from "../policy.ts";
import type {
	GatewayConfig,
	GatewayDeps,
	GatewayRepo,
	GitRequest,
} from "../types.ts";

export const REPO_ID = "01k70000000000000000000000";
export const REMOTE = `https://up.artifacts.test/git/ns/r-${REPO_ID}.git`;
export const sha = (n: number): string =>
	(n + 1).toString(16).padStart(40, "e");
export const LANE = `ln_${ulid()}`;

export const authOf = (over: Partial<AuthContext> = {}): AuthContext => ({
	principal: `u_${ulid()}`,
	kind: "user",
	via: "pat",
	tokenId: `tok_${ulid()}`,
	scopes: ["repo:read", "repo:write", "lanes"],
	nodeId: null,
	laneId: null,
	maxRole: ROLE.owner,
	isAdmin: false,
	...over,
});

export type FakeRepo = GatewayRepo & {
	readonly pushes: PushReport[];
	readonly rejections: {
		commands: readonly PushCommand[];
		reason: string;
		target: string;
	}[];
	readonly diffs: string[];
	readonly upstreamScopes: ("read" | "write")[];
	/** `upstream()` targets in call order (`"repo"` or a lane id). */
	readonly upstreamTargets: string[];
	/** Lanes `getLane` and `pushContext({laneId})` answer from. */
	readonly lanes: Map<string, Lane>;
	/** Delays `recordPush` until the returned function is called. */
	holdRecord(): () => void;
	context: Partial<PushContext>;
	read: Partial<ReadContext>;
};

/** The Artifacts name of a lane's repo in the fakes (`l-<repoUlid>-<laneUlid>`). */
export const laneRepoName = (laneId: string): string =>
	`l-${REPO_ID}-${laneId.slice(3)}`;
export const laneRemote = (laneId: string): string =>
	`https://up.artifacts.test/git/ns/${laneRepoName(laneId)}.git`;

/** A `repo`-backend lane of the fake repo. */
export const repoLane = (
	id: string,
	owner: string,
	over: Partial<Lane> = {},
): Lane => ({
	id,
	repoId: REPO_ID,
	kind: "lane",
	mode: "repo",
	seed: "import",
	ref: "refs/heads/main",
	branch: `lanes/${id}`,
	owner,
	delegates: [],
	footprint: { paths: [], projects: [] } as unknown as Lane["footprint"],
	base: sha(0),
	head: sha(0),
	state: "open",
	quarantined: false,
	leaseExpiresAt: Number.MAX_SAFE_INTEGER,
	pushes: 0,
	createdAt: 0,
	remote: `/acme/shop/-/lanes/${id}.git`,
	...over,
});

export const createFakeRepo = (): FakeRepo => {
	let gate: Promise<void> | null = null;
	const repo: FakeRepo = {
		pushes: [],
		rejections: [],
		diffs: [],
		upstreamScopes: [],
		upstreamTargets: [],
		lanes: new Map(),
		context: {},
		read: {},
		holdRecord: () => {
			let release!: () => void;
			gate = new Promise((resolve) => {
				release = resolve;
			});
			return release;
		},
		pushContext: (auth, _pin, target) => {
			const lane = target === undefined
				? undefined
				: repo.lanes.get(target.laneId);
			if (target !== undefined && lane === undefined) {
				return Promise.reject(notFound(`unknown lane: ${target.laneId}`));
			}
			return Promise.resolve({
				caller: { kind: auth.kind, writeCredential: true },
				ownLanes: [...repo.lanes.values()]
					.filter((l) =>
						l.owner === auth.principal || l.delegates.includes(auth.principal)
					)
					.map((l) => ({
						laneId: l.id,
						mode: l.mode,
						ref: l.ref,
						state: l.state,
						headSha: l.head ?? null,
						resumable: true,
						leased: false,
					})),
				...(lane === undefined ? {} : {
					target: {
						laneId: lane.id,
						mode: lane.mode,
						state: lane.state,
						owner: lane.owner,
						delegates: lane.delegates,
						headSha: lane.head ?? null,
						quarantined: lane.quarantined,
						resumable: true,
						leased: false,
					},
				}),
				adopted: [],
				protectedPatterns: ["refs/heads/main"],
				defaultBranch: "main",
				caseFoldedRefs: ["refs/heads/main"],
				importState: "none",
				landingPaused: false,
				...repo.context,
			});
		},
		getLane: (laneId) => Promise.resolve(repo.lanes.get(laneId) ?? null),
		readContext: (principal) =>
			Promise.resolve({
				view: principal === "anon" ? "public" : "member",
				visibleTips: [sha(0)],
				recentTips: [],
				ownLanes: [],
				...repo.read,
			}),
		recordPush: async (report) => {
			if (gate !== null) await gate;
			repo.pushes.push(report);
			const events = report.refs.map((ref, i) => ({
				id: ulid(),
				type: "push.accepted",
				data: {
					pushId: `p${repo.pushes.length}-${i}`,
					target: "repo",
					ref: ref.ref,
					before: ref.before,
					after: ref.after,
					via: report.via,
				},
			}));
			return {
				pushIds: events.map((e) => e.data.pushId),
				eventIds: events.map((e) => e.id),
				events,
				reconciled: [],
			} as unknown as RecordPushResult;
		},
		recordRejection: (rejection) => {
			repo.rejections.push({
				commands: rejection.commands,
				reason: rejection.reason,
				target: rejection.target,
			});
			return Promise.resolve();
		},
		recordDiff: (pushId) => {
			repo.diffs.push(pushId);
			return Promise.resolve();
		},
		refs: () => Promise.resolve([]),
		upstream: (target, scope): Promise<Upstream> => {
			repo.upstreamScopes.push(scope);
			repo.upstreamTargets.push(target.laneId ?? "repo");
			if (target.laneId !== undefined) {
				const lane = repo.lanes.get(target.laneId);
				if (lane === undefined || lane.mode !== "repo") {
					return Promise.reject(notFound(`no lane repo: ${target.laneId}`));
				}
				return Promise.resolve({
					artifactsName: laneRepoName(lane.id),
					remote: laneRemote(lane.id),
					token: `art_v2_lane_${scope}_${"2".repeat(32)}?expires=9999999999`,
					expiresAt: Number.MAX_SAFE_INTEGER,
					kind: "lane-repo",
					ref: "refs/heads/main",
				});
			}
			return Promise.resolve({
				artifactsName: `r-${REPO_ID}`,
				remote: REMOTE,
				token: `art_v2_x_${"1".repeat(40)}?expires=9999999999`,
				expiresAt: Number.MAX_SAFE_INTEGER,
				kind: "canonical",
				ref: "refs/heads/main",
			});
		},
	};
	return repo;
};

export type UpstreamCall = {
	readonly method: string;
	readonly path: string;
	readonly headers: Headers;
	/** Bytes the upstream read from the request body. */
	bodyBytes: number;
};

export type ScriptedUpstream = {
	readonly calls: UpstreamCall[];
	fetch(request: Request): Promise<Response>;
};

/**
 * An upstream whose answers come from `answer`; it reads (and counts) the
 * whole request body first, as a receive-pack does.
 */
export const scriptedUpstream = (
	answer: (call: UpstreamCall) => Response | Promise<Response>,
): ScriptedUpstream => {
	const calls: UpstreamCall[] = [];
	return {
		calls,
		fetch: async (request) => {
			const url = new URL(request.url);
			const call: UpstreamCall = {
				method: request.method,
				path: `${url.pathname}${url.search}`,
				headers: request.headers,
				bodyBytes: 0,
			};
			calls.push(call);
			if (request.body !== null) {
				const reader = request.body.getReader();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					call.bodyBytes += value.byteLength;
				}
			}
			return await answer(call);
		},
	};
};

export const repoNode = (
	over: Partial<NodeDto> = {},
): NodeDto => ({
	id: REPO_ID,
	parentId: null,
	kind: "repo",
	slug: "shop",
	path: "acme/shop",
	depth: 1,
	visibility: "private",
	defaultBranch: "main",
	archived: false,
	createdAt: 0,
	...over,
});

export type UnitWorld = {
	readonly repo: FakeRepo;
	readonly logs: { message: string; data: Record<string, unknown> }[];
	readonly waits: Promise<unknown>[];
	readonly roles: Map<string, number>;
	node: NodeDto;
	config: GatewayConfig;
	upstream: ScriptedUpstream;
	deps(): GatewayDeps;
	request(
		method: "GET" | "POST",
		op: string,
		options?: {
			readonly auth?: AuthContext | null;
			readonly body?: BodyInit | null;
			readonly headers?: Record<string, string>;
			/** A lane remote URL (`/acme/shop/-/lanes/<laneId>.git/<op>`). */
			readonly laneId?: string;
		},
	): GitRequest;
	settle(): Promise<void>;
};

export const createUnitWorld = (): UnitWorld => {
	const world: UnitWorld = {
		repo: createFakeRepo(),
		logs: [],
		waits: [],
		roles: new Map(),
		node: repoNode(),
		config: {
			maxPushBytes: 95_000_000,
			echo: false,
			upstreamAuth: "bearer",
			phase1WaitMs: 5_000,
			policy: canonicalPushPolicy,
			lanePolicy: laneRepoPolicy,
		},
		upstream: scriptedUpstream(() =>
			new Response("unexpected", { status: 500 })
		),
		deps: () => ({
			tree: {
				resolvePath: (path): Promise<ResolvedPath | null> =>
					Promise.resolve(
						path === world.node.path ? { node: world.node, rest: "" } : null,
					),
				effectiveRole: (principals) =>
					Promise.resolve(
						Math.max(0, ...principals.map((p) => world.roles.get(p) ?? 0)) as 0,
					),
				node: (id) => Promise.resolve(id === world.node.id ? world.node : null),
			},
			repo: () => world.repo,
			isForgeOwner: () => Promise.resolve(false),
			probe: () => ({
				laneDiff: (_source, after) =>
					Promise.resolve({
						rangeBase: after,
						rangeTruncated: false,
						diffKey: "k",
						commits: [],
						paths: [],
						truncated: false,
					}),
			}),
			fetch: (request) => world.upstream.fetch(request),
			requestId: ulid,
			log: (message, data) => void world.logs.push({ message, data }),
			config: world.config,
		}),
		request: (method, op, options = {}) => {
			const url = new URL(
				options.laneId === undefined
					? `https://git.example.test/acme/shop.git/${op}`
					: `https://git.example.test/acme/shop/-/lanes/${options.laneId}.git/${op}`,
			);
			const auth = options.auth === undefined ? null : options.auth;
			if (auth !== null && !world.roles.has(auth.principal)) {
				world.roles.set(auth.principal, ROLE.developer);
			}
			return {
				req: new Request(url, {
					method,
					headers: options.headers,
					body: options.body ?? null,
				}),
				url,
				repoPath: "acme/shop",
				...(options.laneId === undefined ? {} : { laneId: options.laneId }),
				auth,
				waitUntil: (promise) => void world.waits.push(promise),
			};
		},
		settle: async () => {
			while (world.waits.length > 0) {
				await Promise.allSettled(world.waits.splice(0));
			}
		},
	};
	return world;
};

export { ZERO_SHA };
