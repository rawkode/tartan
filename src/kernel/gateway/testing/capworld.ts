// Test-only (Deno and workerd; no Deno APIs): the capability route's
// handlers in front of FakeArtifacts, whose `import()` pulls through them
// (the importer's recorded request shape, `artifacts/1.0`, no credentials),
// with an in-memory RepoDO capability state (`capstate.ts`), a real HMAC key,
// the real per-request token minter and a fixed clock.

import { CAP_PATH_RE, repoArtifactsName, ulid } from "@tartan/contract";
import type { CapMac } from "@tartan/contract/kernel.ts";
import { createFakeArtifacts, type FakeArtifacts } from "@tartan/testkit";
import {
	type CapDeps,
	type CapRouteRequest,
	createCapControlBucket,
	createCapFailureBuckets,
	createCapTokenMinter,
	handleCapInfoRefs,
	handleCapNotFound,
	handleCapUploadPack,
} from "../cap.ts";
import {
	type CapLane,
	type CapState,
	createCapState,
	signedCapPath,
	testCapMac,
} from "./capstate.ts";

export const CAP_ORIGIN = "https://git.example.test";
export const CAP_NOW = 1_790_000_000_000;
export const CAP_NOW_S = CAP_NOW / 1000;
export const LANE_MAIN = "refs/heads/main";

export type CapWorld = {
	readonly repoId: string;
	readonly fake: FakeArtifacts;
	readonly state: CapState;
	readonly mac: CapMac;
	readonly logs: { message: string; data: Record<string, unknown> }[];
	readonly waits: Promise<unknown>[];
	readonly trunk: string;
	readonly canonical: string;
	deps: CapDeps;
	/** The route table's three capability handlers, by path and method. */
	route(request: Request): Promise<Response>;
	/** An `opening` lane with a fresh nonce and its signed capability URL. */
	lane(over?: Partial<CapLane>): Promise<{ lane: CapLane; url: string }>;
	settle(): Promise<void>;
	/** Successful `createToken` / `revokeToken` binding calls on FakeArtifacts. */
	tokenOps(): { create: number; revoke: number };
};

export const capWorld = async (
	options: {
		readonly defaultBranch?: string;
		readonly clientCheck?: boolean;
		readonly limits?: { perIpPerMin: number; perIsolatePerMin: number };
	} = {},
): Promise<CapWorld> => {
	// The importer's fetch reaches the route once `world` exists.
	const importer: { route: (request: Request) => Promise<Response> } = {
		route: () => Promise.reject(new Error("the capability world is not ready")),
	};
	const fake = createFakeArtifacts({
		now: () => CAP_NOW,
		fetch: (request) => importer.route(request),
	});
	const repoId = ulid().toLowerCase();
	const canonical = repoArtifactsName(repoId);
	const seeded = await fake.seed(canonical, {
		files: { "README.md": "trunk\n", "src/a.ts": "export const a = 1;\n" },
		defaultBranch: options.defaultBranch ?? "main",
		alsoRefs: ["refs/heads/feature", "refs/tags/v1"],
	});
	const state = createCapState();
	const mac = await testCapMac();
	const logs: { message: string; data: Record<string, unknown> }[] = [];
	const waits: Promise<unknown>[] = [];
	const log = (message: string, data: Record<string, unknown>) =>
		void logs.push({ message, data });
	const world: CapWorld = {
		repoId,
		fake,
		state,
		mac,
		logs,
		waits,
		trunk: seeded.head as string,
		canonical,
		deps: {
			verifyMac: (fields, value) => mac.verify(fields, value),
			repo: (id) => state.repo(id),
			mintReadToken: createCapTokenMinter({
				artifacts: fake,
				bucket: createCapControlBucket(1_000),
				ttlS: 120,
				log,
			}),
			fetch: (request) => fake.fetch(request),
			now: () => CAP_NOW,
			log,
			buckets: createCapFailureBuckets({
				now: () => CAP_NOW,
				...(options.limits ? { limits: options.limits } : {}),
			}),
			config: {
				ttlS: 120,
				clientCheck: options.clientCheck ?? false,
				upstreamAuth: "bearer",
			},
		},
		route: (request) => {
			const url = new URL(request.url);
			const c: CapRouteRequest = {
				req: request,
				url,
				waitUntil: (promise) => void waits.push(promise),
			};
			const parts = CAP_PATH_RE.exec(url.pathname);
			if (
				parts !== null && parts[6] === "info/refs" && request.method === "GET"
			) {
				return handleCapInfoRefs(world.deps, c);
			}
			if (
				parts !== null && parts[6] === "git-upload-pack" &&
				request.method === "POST"
			) {
				return handleCapUploadPack(world.deps, c);
			}
			return handleCapNotFound(world.deps, c);
		},
		lane: async (over = {}) => {
			const lane = state.addLane(repoId, world.trunk, {
				defaultBranch: options.defaultBranch ?? "main",
				...over,
			});
			const path = await signedCapPath(mac, lane, CAP_NOW_S + 120);
			return { lane, url: `${CAP_ORIGIN}${path}` };
		},
		settle: async () => {
			while (waits.length > 0) await Promise.allSettled(waits.splice(0));
		},
		tokenOps: () => ({
			create:
				fake.calls.filter((c) =>
					c.op === "repo.createToken" && c.outcome === "ok"
				).length,
			revoke:
				fake.calls.filter((c) =>
					c.op === "repo.revokeToken" && c.outcome === "ok"
				).length,
		}),
	};
	importer.route = world.route;
	return world;
};

/** The lane repo's Artifacts name (`l-<repoUlid>-<laneUlid>`). */
export const capLaneName = (world: CapWorld, lane: CapLane): string =>
	`l-${world.repoId}-${lane.laneId.slice(3).toLowerCase()}`;

/** `ARTIFACTS.import({source: {url, branch: "main"}})` into the lane's repo. */
export const importLane = (world: CapWorld, url: string, lane: CapLane) =>
	world.fake.import({
		source: { url, branch: "main" },
		target: { name: capLaneName(world, lane) },
	});

export const capGet = (
	world: CapWorld,
	url: string,
	headers: HeadersInit = {},
): Promise<Response> =>
	world.route(
		new Request(`${url}/info/refs?service=git-upload-pack`, { headers }),
	);

export const capPost = (
	world: CapWorld,
	url: string,
	body: BodyInit,
	headers: HeadersInit = {},
): Promise<Response> =>
	world.route(
		new Request(`${url}/git-upload-pack`, {
			method: "POST",
			body,
			headers: {
				"content-type": "application/x-git-upload-pack-request",
				...headers,
			},
		}),
	);
