// Test fixtures for tartan.changes (Deno only): the repo, principals, a
// scripted lane table with `laneRange`, envelopes and a harness over
// `@tartan/ext-api/testing.ts` with the manifest's grants.

import {
	type Actor,
	type CapsMethod,
	type Envelope,
	type Lane,
	type LaneRange,
	laneRemotePath,
	parseManifest,
	type RepoInfo,
	type ToolContext,
	validateEventData,
} from "@tartan/contract";
import {
	type CapsHandler,
	createTestHarness,
	type Harness,
} from "@tartan/ext-api/testing.ts";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";

export const REPO = "01k6rrrrrrrrrrrrrrrrrrrrrr";
export const REPO_PATH = "acme/router";
export const TRUNK = "a".repeat(40);
export const sha = (c: string): string => c.repeat(40);

export const manifest = (() => {
	const parsed = parseManifest(manifestJson);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
})();

export const USER = "u_01k6vvvvvvvvvvvvvvvvvvvvvv";
export const AGENT = "a_01k6aaaaaaaaaaaaaaaaaaaaaa";
export const OTHER = "a_01k6bbbbbbbbbbbbbbbbbbbbbb";
export const userActor: Actor = { kind: "user", id: USER };
export const agentActor: Actor = { kind: "agent", id: AGENT, onBehalfOf: USER };
export const otherActor: Actor = { kind: "agent", id: OTHER };
export const LANE = "ln_01k60000000000000000000001";
export const WORK_REF = `${REPO_PATH}#7`;

export const toolCtx = (actor: Actor): ToolContext => ({
	node: REPO,
	repo: REPO,
	scope: REPO_PATH,
	actor,
	mode: "enforce",
});

export const lane = (
	id: string,
	owner: string,
	overrides: Partial<Lane> = {},
): Lane => {
	const mode = overrides.mode ?? "branch";
	return {
		id,
		repoId: REPO,
		kind: "lane",
		mode,
		ref: mode === "repo" ? "refs/heads/main" : `refs/heads/lanes/${id}`,
		branch: `lanes/${id}`,
		owner,
		delegates: [],
		entity: { kind: "work", id: WORK_REF },
		footprint: { projects: [], prefixes: [] },
		base: TRUNK,
		state: "open",
		quarantined: false,
		leaseExpiresAt: 0,
		pushes: 0,
		createdAt: 0,
		remote: laneRemotePath({ id, mode }, REPO_PATH),
		...(mode === "repo" ? { seed: "import" as const } : {}),
		...overrides,
	};
};

let seq = 0;
export const event = <T>(
	type: string,
	data: T,
	overrides: Partial<Envelope> = {},
): Envelope<T> => {
	seq += 1;
	return {
		id: `01k6e${String(seq).padStart(21, "0")}`,
		seq,
		stream: `repo:${REPO}`,
		type,
		v: 1,
		source: { kind: "kernel" },
		actor: { kind: "agent", id: AGENT },
		node: REPO,
		repo: REPO,
		depth: 0,
		shadow: false,
		at: 1_790_000_000_000 + seq,
		...overrides,
		data,
	};
};

export const repoInfo: RepoInfo = {
	id: REPO,
	nodeId: REPO,
	path: REPO_PATH,
	defaultBranch: "main",
	visibility: "private",
	trunkSha: TRUNK,
	landingPaused: false,
};

export type ChangesHarness = Harness & {
	readonly lanes: Map<string, Lane>;
	/** `caps.repo.laneRange` answers, by lane. */
	readonly ranges: Map<string, LaneRange>;
	/** Records a push the kernel saw in phase 1 (lane head and pushes). */
	push(laneId: string, head: string, rangeBase?: string): void;
	emitted(): { type: string; data: Record<string, unknown> }[];
	types(): string[];
};

export const createChangesHarness = (
	handlers: Partial<Record<CapsMethod, CapsHandler>> = {},
	options: { readonly config?: unknown } = {},
): ChangesHarness => {
	const lanes = new Map<string, Lane>();
	const ranges = new Map<string, LaneRange>();
	const h = createTestHarness({
		module: extension,
		migrations,
		grants: manifest.permissions,
		...(options.config === undefined ? {} : { config: options.config }),
		install: {
			id: "i_01k6iiiiiiiiiiiiiiiiiiiiii",
			extId: manifest.id,
			version: manifest.version,
			node: { id: REPO, path: REPO_PATH },
			scopeKey: `repo:${REPO}`,
		},
		now: () => 1_790_000_000_000,
		handlers: {
			"repo.info": () => repoInfo,
			"lanes.get": (id: string) => {
				const l = lanes.get(id);
				if (!l) throw new Error(`not_found: lane ${id}`);
				return l;
			},
			"lanes.adopt": (o: { ref: string; owner: string }) => {
				const l = lane("ln_01k6000000000000000000000d", o.owner, {
					kind: "adopted",
					ref: o.ref,
					branch: o.ref.replace("refs/heads/", ""),
					entity: undefined,
				});
				lanes.set(l.id, l);
				return l;
			},
			"repo.laneRange": (id: string) => {
				const r = ranges.get(id);
				if (!r) throw new Error(`not_found: range of ${id}`);
				return r;
			},
			"repo.affected": () => ({ projects: ["api"], global: false }),
			"repo.diff": () => [
				{
					path: "services/api/src/middleware/limit.ts",
					change: "modified",
					binary: false,
					additions: 12,
					deletions: 3,
					hunks: [],
				},
			],
			"repo.diffPaths": () => ({
				paths: [{
					path: "services/api/src/middleware/limit.ts",
					change: "modified",
				}],
				truncated: false,
			}),
			"repo.hunks": () => [{
				path: "services/api/src/middleware/limit.ts",
				binary: false,
				hunks: [{ oldStart: 40, oldLines: 3, newStart: 40, newLines: 9 }],
			}],
			"notes.contribute": () => undefined,
			"authz.check": () => false,
			...handlers,
		},
	});
	const push = (laneId: string, head: string, rangeBase = TRUNK) => {
		const l = lanes.get(laneId)!;
		lanes.set(laneId, { ...l, head, pushes: l.pushes + 1 });
		ranges.set(laneId, {
			head,
			rangeBase,
			rangeTruncated: false,
			diffKey: `diffs/${REPO}/${rangeBase}..${head}.json`,
		});
	};
	const emitted = () =>
		h.recorder.emitted.map((e) => {
			const checked = validateEventData(e.type, e.data);
			if (!checked.ok) {
				throw new Error(`${e.type}: ${checked.errors.join("; ")}`);
			}
			return { type: e.type, data: e.data as Record<string, unknown> };
		});
	return Object.assign(h, {
		lanes,
		ranges,
		push,
		emitted,
		types: () => emitted().map((e) => e.type),
	});
};

/** `lane.opened` of a lane the harness knows (branch backend unless given). */
export const opened = (l: Lane) =>
	event("lane.opened", {
		laneId: l.id,
		...(l.entity ? { entity: l.entity } : {}),
		owner: l.owner,
		base: l.base,
		footprint: l.footprint,
		mode: l.mode,
	}, { actor: { kind: "agent", id: l.owner, onBehalfOf: USER } });

export const diffed = (laneId: string, after: string, rangeBase = TRUNK) =>
	event("push.diffed", {
		pushId: `p_${after.slice(0, 6)}`,
		target: laneId,
		ref: `refs/heads/lanes/${laneId}`,
		after,
		rangeBase,
		rangeTruncated: false,
		commits: [],
		paths: ["services/api/src/middleware/limit.ts"],
		truncated: false,
		diffKey: `diffs/${REPO}/${rangeBase}..${after}.json`,
	});
