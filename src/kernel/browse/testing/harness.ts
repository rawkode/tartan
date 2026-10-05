// Test-only: the browse and nodes routes over the real tree module (the
// tree harness: node:sqlite, FakeArtifacts with real git objects, WP3's
// genesis), a RepoDO fake that resolves refs from the fake repo's refs the
// way RepoDO's index does (full names, short names, lane ids, SHAs; never
// through the binding) and derives the public view's read context, and a
// recording RepoProbe. Requests run through the handlers with an
// `AuthContext` as WP2's middleware would set it.

import {
	type FileDiff,
	type ImportCompleteRequest,
	isHiddenRef,
	parseId,
	repoArtifactsName,
	SHA1_RE,
	trunkRef,
} from "@tartan/contract";
import type { AuthContext, ReadContext } from "@tartan/contract/kernel.ts";
import type { Env } from "../../../env.ts";
import type { RouteContext, RouteHandler } from "../../../router.ts";
import {
	createTreeHarness,
	type TreeHarness,
} from "../../tree/testing/harness.ts";
import type { BrowseDeps, BrowseRepo } from "../deps.ts";

export type ProbeCall = {
	readonly a: { repoId: string; sha: string };
	readonly b: { repoId: string; sha: string };
	/** `{patch: true}` was asked for (`patch=1`). */
	readonly patch: boolean;
};

export const createBrowseHarness = () => {
	const h: TreeHarness = createTreeHarness();
	/** Lane id → head sha, per repo (RepoDO's lane rows). */
	const lanes = new Map<string, Map<string, string>>();
	const probeCalls: ProbeCall[] = [];
	let probeAnswer: FileDiff[] = [
		{
			path: "README.md",
			change: "modified",
			binary: false,
			additions: 1,
			deletions: 0,
			hunks: [],
		},
	];
	const refsOf = (repoId: string): Record<string, string> => {
		try {
			return h.fake.inspect.refs(repoArtifactsName(repoId));
		} catch {
			return {};
		}
	};
	const defaultBranchOf = async (repoId: string) =>
		(await h.facade.node(repoId))?.defaultBranch ?? "main";

	const repo = (repoId: string): BrowseRepo => ({
		resolveRef: async (input) => {
			const ref = input.trim();
			if (SHA1_RE.test(ref)) return ref;
			if (parseId("lane", ref) !== null) {
				return lanes.get(repoId)?.get(ref) ?? null;
			}
			const refs = refsOf(repoId);
			const candidates = ref === "HEAD"
				? [trunkRef(await defaultBranchOf(repoId))]
				: ref.startsWith("refs/")
				? [ref]
				: [`refs/heads/${ref}`, `refs/tags/${ref}`];
			for (const name of candidates) {
				if (refs[name]) return refs[name];
			}
			return null;
		},
		readContext: (principal) => {
			const visible = Object.entries(refsOf(repoId))
				.filter(([ref]) => !isHiddenRef(ref))
				.map(([, sha]) => sha);
			return Promise.resolve(
				{
					view: principal === "anon" ? "public" : "member",
					visibleTips: [...new Set(visible)],
					recentTips: [],
					ownLanes: [],
				} satisfies ReadContext,
			);
		},
		importComplete: (by: string, input: ImportCompleteRequest) =>
			h.repos.core(repoId).importComplete(by, input),
	});

	const deps: BrowseDeps = {
		tree: () => h.facade,
		repo,
		artifacts: h.fake,
		probe: () => ({
			diff: (a, b, options) => {
				probeCalls.push({
					a: { repoId: a.repoId, sha: a.sha },
					b: { repoId: b.repoId, sha: b.sha },
					patch: options?.patch === true,
				});
				return Promise.resolve(probeAnswer);
			},
		}),
	};

	/** Runs `handler` for a request as `auth` (`params` as the router would capture them). */
	const call = async (
		handler: RouteHandler,
		method: string,
		path: string,
		auth: AuthContext | null,
		options: { body?: unknown; params?: Record<string, string> } = {},
	): Promise<Response> => {
		const url = new URL(`https://code.example.test${path}`);
		const req = new Request(url, {
			method,
			...(options.body !== undefined
				? {
					body: JSON.stringify(options.body),
					headers: { "content-type": "application/json" },
				}
				: {}),
		});
		const c: RouteContext = {
			req,
			env: {} as Env,
			ctx: {} as ExecutionContext,
			url,
			params: options.params ?? {},
			route: { id: "test", owner: "WP3", policy: {} as never },
			auth,
		};
		return await handler(c);
	};

	/** A lane head (`branch` backend): `refs/heads/lanes/<id>` in the canonical repo plus RepoDO's lane row. */
	const addLane = (repoId: string, laneId: string, sha: string): void => {
		h.fake.setRef(
			repoArtifactsName(repoId),
			`refs/heads/lanes/${laneId}`,
			sha,
			{ quiet: true },
		);
		const map = lanes.get(repoId) ?? new Map();
		map.set(laneId, sha);
		lanes.set(repoId, map);
	};

	return {
		...h,
		tree: h,
		deps,
		depsFor: () => deps,
		call,
		addLane,
		probeCalls,
		setProbeAnswer: (files: FileDiff[]) => {
			probeAnswer = files;
		},
	};
};

export type BrowseHarness = ReturnType<typeof createBrowseHarness>;

export const session = (principal: string): AuthContext => ({
	principal,
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
});

export const adminSession = (principal: string): AuthContext => ({
	...session(principal),
	isAdmin: true,
});

export const agentToken = (
	principal: string,
	o: Partial<AuthContext> = {},
): AuthContext => ({
	principal,
	kind: "agent",
	via: "agent-token",
	scopes: ["repo:read", "repo:write", "lanes", "api", "mcp"],
	nodeId: null,
	laneId: null,
	maxRole: 30,
	isAdmin: false,
	...o,
});

export const pat = (
	principal: string,
	o: Partial<AuthContext> = {},
): AuthContext => ({
	principal,
	kind: "user",
	via: "pat",
	scopes: ["repo:read", "repo:write", "api"],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
	...o,
});
