// Test fixtures for tartan.work (Deno only): the repo, principals, a lane
// factory, envelopes and a harness over `@tartan/ext-api/testing.ts` with the
// manifest's grants and scripted kernel answers.

import {
	type Actor,
	type CapsMethod,
	type Envelope,
	type Lane,
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
export const GROUP = "01k6gggggggggggggggggggggg";
export const BASE = "a".repeat(40);
export const HEAD = "b".repeat(40);

export const manifest = (() => {
	const parsed = parseManifest(manifestJson);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
})();

export const USER = "u_01k6vvvvvvvvvvvvvvvvvvvvvv";
export const AGENT = "a_01k6aaaaaaaaaaaaaaaaaaaaaa";
export const AGENT_2 = "a_01k6bbbbbbbbbbbbbbbbbbbbbb";
export const userActor: Actor = { kind: "user", id: USER };
export const agentActor: Actor = { kind: "agent", id: AGENT, onBehalfOf: USER };
export const agent2Actor: Actor = { kind: "agent", id: AGENT_2 };

export const laneId = (n: number): string =>
	`ln_01k6${String(n).padStart(22, "0")}`;

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
		footprint: { projects: [], prefixes: [] },
		base: BASE,
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

export const toolCtx = (actor: Actor): ToolContext => ({
	node: REPO,
	repo: REPO,
	scope: REPO_PATH,
	actor,
	mode: "enforce",
});

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
	trunkSha: BASE,
	landingPaused: false,
};

export type WorkHarness = Harness & {
	/** Lanes the fake kernel knows, by id. */
	readonly lanes: Map<string, Lane>;
	/** Emitted events, each payload checked against its schema (K10). */
	emitted(): { type: string; data: Record<string, unknown> }[];
	types(): string[];
};

export const createWorkHarness = (
	handlers: Partial<Record<CapsMethod, CapsHandler>> = {},
	options: { readonly config?: unknown } = {},
): WorkHarness => {
	const lanes = new Map<string, Lane>();
	let opened = 0;
	const h = createTestHarness({
		module: extension,
		migrations,
		grants: manifest.permissions,
		...(options.config === undefined ? {} : { config: options.config }),
		install: {
			id: "i_01k6iiiiiiiiiiiiiiiiiiiiii",
			extId: manifest.id,
			version: manifest.version,
			node: { id: GROUP, path: "acme" },
			scopeKey: `repo:${REPO}`,
		},
		now: () => 1_790_000_000_000,
		handlers: {
			"repo.info": () => repoInfo,
			"lanes.open": (o: { owner: string; footprint: Lane["footprint"] }) => {
				opened += 1;
				const l = lane(laneId(opened), o.owner, { footprint: o.footprint });
				lanes.set(l.id, l);
				return l;
			},
			"lanes.get": (id: string) => {
				const l = lanes.get(id);
				if (!l) throw new Error(`no lane ${id}`);
				return l;
			},
			"lanes.close": () => undefined,
			"interfaces.call": () => ({ results: [] }),
			"authz.check": () => true,
			"notes.contribute": () => undefined,
			...handlers,
		},
	});
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
		emitted,
		types: () => emitted().map((e) => e.type),
	});
};
