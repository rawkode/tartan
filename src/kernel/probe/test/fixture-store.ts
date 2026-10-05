// Test doubles for RepoProbe, built on the git fixture (fixtures/
// histories.json, generated offline by gen-fixtures.ts):
//
// - an Artifacts-like store whose repos hold exactly the objects reachable
//   from their tips (a lane repo seeded at a base holds trunk up to it plus
//   its own commits), answering reads like the binding: null for an object
//   the repo does not hold, `log` by SHA only (a refname reads as empty);
// - RepoDO ports (upstream names, trunk positions, lane bases, refs, graph
//   cache) and an in-memory `diffs/` store;
// - a log of every binding read, by repo name.
//
// Plain module (no `cloudflare:*`), shared by Deno and workerd tests.

import type { ProjectConfigAnswer, ProjectGraph } from "@tartan/contract";
import type {
	RepoStoreCommit,
	RepoStoreTreeEntry,
	UpstreamTarget,
} from "@tartan/contract/kernel.ts";
import { createTokenBucket } from "../bucket.ts";
import { createObjectCache, type ObjectCache } from "../cache.ts";
import type { DiffStore, ProbeRepoPort, RepoProbeDeps } from "../probe.ts";
import type { ReadEvent, RepoHandle } from "../reader.ts";

export type Fixture = {
	readonly trunk: readonly string[];
	readonly refs: Readonly<Record<string, string>>;
	readonly lanes: Readonly<
		Record<string, {
			readonly head: string;
			readonly mergeBase: string | null;
			readonly nameStatus?: readonly (readonly string[])[];
			readonly hunks?: Readonly<Record<string, readonly unknown[]>>;
		}>
	>;
	readonly pairs: readonly {
		readonly name: string;
		readonly a: string;
		readonly b: string;
		readonly mergeBase: string;
		readonly files: readonly {
			readonly path: string;
			readonly base: string | null;
			readonly ours: string | null;
			readonly theirs: string | null;
			readonly merge: { readonly exit: number; readonly output: string } | null;
		}[];
	}[];
	readonly objects: {
		readonly commits: Readonly<Record<string, RepoStoreCommit>>;
		readonly trees: Readonly<Record<string, RepoStoreTreeEntry[]>>;
		readonly blobs: Readonly<Record<string, string>>;
	};
};

export const loadFixture = (text: string): Fixture =>
	JSON.parse(text) as Fixture;

export const blobBytes = (fixture: Fixture, sha: string): Uint8Array =>
	Uint8Array.from(atob(fixture.objects.blobs[sha]), (c) => c.charCodeAt(0));

const SHA = /^[0-9a-f]{40}$/;

/** Every object reachable from `tips` (commits, their trees, blobs, parents). */
export const reachable = (
	fixture: Fixture,
	tips: readonly string[],
): Set<string> => {
	const out = new Set<string>();
	const { commits, trees } = fixture.objects;
	const walkTree = (hash: string) => {
		if (out.has(hash)) return;
		out.add(hash);
		for (const e of trees[hash] ?? []) {
			if (e.type === "tree") walkTree(e.hash);
			else out.add(e.hash);
		}
	};
	const queue = [...tips];
	while (queue.length > 0) {
		const sha = queue.pop()!;
		if (out.has(sha) || !commits[sha]) continue;
		out.add(sha);
		walkTree(commits[sha].treeHash);
		queue.push(...commits[sha].parents);
	}
	return out;
};

export type FakeStore = {
	readonly reads: ReadEvent[];
	/** Raw binding calls by repo name (including `log`). */
	readonly calls: { repo: string; op: string; arg: string }[];
	get(name: string): Promise<RepoHandle>;
	/** Creates or replaces a repo holding what is reachable from `tips`. */
	setRepo(name: string, tips: readonly string[]): void;
};

export const createFakeStore = (fixture: Fixture): FakeStore => {
	const repos = new Map<string, Set<string>>();
	const calls: FakeStore["calls"] = [];
	const { commits, trees, blobs } = fixture.objects;
	const handle = (name: string): RepoHandle => {
		const holds = (sha: string) => repos.get(name)?.has(sha) ?? false;
		const record = (op: string, arg: string) =>
			calls.push({ repo: name, op, arg });
		return {
			readTree: (hash) => {
				record("readTree", hash);
				return Promise.resolve(holds(hash) && trees[hash] ? trees[hash] : null);
			},
			readCommit: (hash) => {
				record("readCommit", hash);
				return Promise.resolve(
					holds(hash) && commits[hash] ? commits[hash] : null,
				);
			},
			readBlob: (hash) => {
				record("readBlob", hash);
				return Promise.resolve(
					holds(hash) && blobs[hash]
						? new Blob([blobBytes(fixture, hash) as Uint8Array<ArrayBuffer>])
						: null,
				);
			},
			log: (opts = {}) => {
				const ref = opts.ref ?? "HEAD";
				record("log", ref);
				// The binding resolves no full refname [E A4]; tests pass SHAs.
				if (!SHA.test(ref) || !holds(ref)) return Promise.resolve([]);
				const out: RepoStoreCommit[] = [];
				let cur: string | undefined = ref;
				let skip = opts.offset ?? 0;
				const limit = Math.min(opts.limit ?? 50, 1000);
				while (cur && holds(cur) && out.length < limit) {
					if (skip > 0) skip--;
					else out.push(commits[cur]);
					cur = commits[cur].parents[0];
				}
				return Promise.resolve(out);
			},
		};
	};
	return {
		reads: [],
		calls,
		get: (name) => {
			if (!repos.has(name)) {
				return Promise.reject(Object.assign(new Error(`NOT_FOUND: ${name}`), {
					name: "ArtifactsError",
					code: "NOT_FOUND",
				}));
			}
			return Promise.resolve(handle(name));
		},
		setRepo: (name, tips) => repos.set(name, reachable(fixture, tips)),
	};
};

export type FakeRepoState = {
	/** laneId → current Artifacts repo name (`repo` lanes); absent = `branch` lane. */
	readonly laneRepos: Map<string, string>;
	readonly laneBases: Map<string, string>;
	readonly graphs: Map<string, ProjectGraph>;
	trunkSeqCalls: number;
	upstreamCalls: UpstreamTarget[];
	/** The trunk config's projects at a commit (ADR repo config); default: none. */
	projectConfig?: (sha: string) => ProjectConfigAnswer;
};

export const createFakeRepoPort = (
	fixture: Fixture,
	repoId: string,
	state: FakeRepoState,
): ProbeRepoPort => {
	const seq = new Map(fixture.trunk.map((sha, i) => [sha, i]));
	return {
		artifactsName: (target) => {
			state.upstreamCalls.push(target);
			const lane = target.laneId
				? state.laneRepos.get(target.laneId)
				: undefined;
			return Promise.resolve(lane ?? `r-${repoId}`);
		},
		trunkSeqs: (shas) => {
			state.trunkSeqCalls++;
			return Promise.resolve(
				Object.fromEntries(
					shas.flatMap((s) => seq.has(s) ? [[s, seq.get(s)!]] : []),
				),
			);
		},
		laneBase: (laneId) => Promise.resolve(state.laneBases.get(laneId) ?? null),
		trunkTip: () => Promise.resolve(fixture.trunk.at(-1) ?? null),
		resolveRef: (ref) =>
			Promise.resolve(
				SHA.test(ref)
					? ref
					: ref === "main" || ref === "refs/heads/main"
					? fixture.trunk.at(-1)!
					: null,
			),
		projects: (sha) => Promise.resolve(state.graphs.get(sha) ?? null),
		putProjects: (graph) => {
			state.graphs.set(graph.sha, graph);
			return Promise.resolve();
		},
		projectConfig: (sha) =>
			Promise.resolve(
				state.projectConfig?.(sha) ??
					{ key: "none", projects: null, global: [], provisional: false },
			),
	};
};

export const createMemoryDiffs = (): DiffStore & {
	readonly keys: () => string[];
} => {
	const map = new Map<string, string>();
	return {
		get: (key) => {
			const v = map.get(key);
			return Promise.resolve(
				v === undefined ? null : { text: () => Promise.resolve(v) },
			);
		},
		put: (key, value) => {
			map.set(key, value);
			return Promise.resolve();
		},
		keys: () => [...map.keys()],
	};
};

export type Harness = {
	readonly fixture: Fixture;
	readonly store: FakeStore;
	readonly state: FakeRepoState;
	readonly diffs: ReturnType<typeof createMemoryDiffs>;
	readonly cache: ObjectCache;
	readonly deps: RepoProbeDeps;
};

/** A ready RepoProbe environment over the fixture (any repo id; lanes via `state`). */
export const createHarness = (
	fixture: Fixture,
	options: { readonly cache?: ObjectCache; readonly bucketRate?: number } = {},
): Harness => {
	const store = createFakeStore(fixture);
	const state: FakeRepoState = {
		laneRepos: new Map(),
		laneBases: new Map(),
		graphs: new Map(),
		trunkSeqCalls: 0,
		upstreamCalls: [],
	};
	const diffs = createMemoryDiffs();
	const cache = options.cache ?? createObjectCache({ edge: null });
	const deps: RepoProbeDeps = {
		repo: (id) => createFakeRepoPort(fixture, id, state),
		store,
		diffs,
		cache,
		bucket: createTokenBucket({ ratePerSecond: options.bucketRate ?? 100_000 }),
		onRead: (e) => store.reads.push(e),
	};
	return { fixture, store, state, diffs, cache, deps };
};
