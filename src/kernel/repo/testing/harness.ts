// Test-only: the RepoDO `core` module on the `node:sqlite` storage fake, with
// recording fakes of every port (FakeArtifacts that records calls, an
// in-memory upstream that `ls-refs` reads, WP6's event log in the same
// database so rollbacks apply, WP10's git jobs, WP8's RepoProbe, WP7b's gate
// dispatcher, WP3's tree) and the real WP0 timer multiplexer on a fake clock.
// WP1's `@tartan/testkit` does not exist yet; these are minimal local fakes.

import {
	createUlid,
	type EffectiveRole,
	type GitSource,
	laneArtifactsName,
	notImplemented,
	ROLE,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	DiffResult,
	GateDispatchResult,
	KernelGitJobs,
	KernelWriteIntent,
	ModuleDeps,
	RepoBackend,
	RepoCoreFacade,
	RepoCoreInternal,
	RepoInternals,
	RepoStore,
	TreeFacade,
} from "@tartan/contract/kernel.ts";
import type { GitRemote, LsRef } from "@tartan/gitproto";
import {
	COMMON_MIGRATIONS,
	migrationSources,
	runMigrations,
} from "../../../do/migrations.ts";
import { bindTimers, createTimers, type Timers } from "../../../do/timers.ts";
import type { Env } from "../../../env.ts";
import type { CorePorts } from "../core.ts";
import {
	createFakeEvents,
	createFakeLand,
	type FakeEvents,
	type FakeLand,
} from "./fakes.ts";
import { createRepoBackend } from "../lanes/repo-backend/index.ts";
import { createRepoCoreModule } from "../module.ts";
import { createFakeStorage, type FakeStorage } from "./sqlite.ts";

/** A 40-hex SHA from a small number (never zeros). */
export const sha = (n: number): string =>
	(n + 1).toString(16).padStart(40, "a");

export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

export type FakeClock = {
	now(): number;
	set(at: number): void;
	advance(ms: number): void;
};

export const createClock = (start = T0): FakeClock => {
	let at = start;
	return {
		now: () => at,
		set: (next) => {
			at = next;
		},
		advance: (ms) => {
			at += ms;
		},
	};
};

// ---------------------------------------------------------------------------
// Upstream: what Artifacts holds (ref → sha per repo name)
// ---------------------------------------------------------------------------

export type FakeUpstream = {
	readonly repos: Map<string, Map<string, string>>;
	set(repo: string, ref: string, sha: string): void;
	get(repo: string, ref: string): string | null;
	remoteOf(repo: string): string;
	/** `ls-refs` calls: the repo and the `ref-prefix` arguments. */
	readonly lsRefsCalls: { repo: string; prefixes: readonly string[] }[];
	/** Every `ls-refs` throws while set. */
	failing: boolean;
	/**
	 * Runs after `ls-refs` has read its answer and before it returns: a
	 * test records a push here to model one landing while the call is in
	 * flight (the answer is then older than the index).
	 */
	inFlight?: () => Promise<void>;
};

const REMOTE_PREFIX = "https://artifacts.fake.test/ns/";

export const createUpstream = (): FakeUpstream => {
	const repos = new Map<string, Map<string, string>>();
	return {
		repos,
		set: (repo, ref, value) => {
			const refs = repos.get(repo) ?? new Map();
			if (value === ZERO_SHA) refs.delete(ref);
			else refs.set(ref, value);
			repos.set(repo, refs);
		},
		get: (repo, ref) => repos.get(repo)?.get(ref) ?? null,
		remoteOf: (repo) => `${REMOTE_PREFIX}${repo}.git`,
		lsRefsCalls: [],
		failing: false,
	};
};

const lsRefsOf = (upstream: FakeUpstream) =>
async (
	remote: GitRemote,
	options?: { readonly refPrefixes?: readonly string[] },
): Promise<readonly LsRef[]> => {
	const repo = remote.url.slice(REMOTE_PREFIX.length).replace(/\.git$/, "");
	const prefixes = options?.refPrefixes ?? [];
	upstream.lsRefsCalls.push({ repo, prefixes });
	if (upstream.failing) throw new Error("upstream down");
	if (!remote.authorization.startsWith("Bearer ")) {
		throw new Error("no authorization");
	}
	const refs = [...(upstream.repos.get(repo) ?? new Map()).entries()]
		.filter(([ref]) =>
			prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p))
		)
		.map(([ref, value]) => ({ ref, sha: value }));
	const inFlight = upstream.inFlight;
	upstream.inFlight = undefined;
	await inFlight?.();
	return refs;
};

// ---------------------------------------------------------------------------
// FakeArtifacts (records every call)
// ---------------------------------------------------------------------------

export type ArtifactsCall = { readonly method: string; readonly name?: string };

export const createRecordingArtifacts = (
	upstream: FakeUpstream,
	clock: FakeClock,
	calls: ArtifactsCall[],
): RepoStore => {
	const handle = (name: string) => ({
		info: () => {
			calls.push({ method: "info", name });
			return Promise.resolve({
				id: name,
				name,
				description: null,
				defaultBranch: "main",
				createdAt: "",
				updatedAt: "",
				lastPushAt: null,
				source: null,
				readOnly: false,
				remote: upstream.remoteOf(name),
			});
		},
		createToken: (scope: "read" | "write" = "write", ttl = 600) => {
			calls.push({ method: "createToken", name });
			return Promise.resolve({
				id: `tok-${calls.length}`,
				plaintext: `art_v2_x_${"0".repeat(40)}?expires=${clock.now()}`,
				scope,
				expiresAt: new Date(clock.now() + ttl * 1000).toISOString(),
			});
		},
		revokeToken: () => Promise.resolve(true),
		listTokens: () => Promise.resolve({ tokens: [], total: 0 }),
		readBlob: () => Promise.resolve(null),
		readTree: () => Promise.resolve(null),
		readCommit: () => Promise.resolve(null),
		readFile: () => Promise.resolve(null),
		log: (opts?: { ref?: string; limit?: number }) => {
			calls.push({ method: "log", name });
			const tip = opts?.ref ?? "";
			const chain = [tip, sha(9001), sha(9002)].map((hash, i, all) => ({
				hash,
				treeHash: sha(8000 + i),
				message: `commit ${i}`,
				author: { name: "a", email: "a@example.test" },
				committer: { name: "a", email: "a@example.test" },
				parents: i + 1 < all.length ? [all[i + 1]] : [],
				authoredAt: 0,
				committedAt: 0,
			}));
			return Promise.resolve(chain);
		},
		[Symbol.dispose]: () => {},
	});
	const store = {
		create: () => {
			calls.push({ method: "create" });
			return Promise.reject(new Error("not used"));
		},
		get: (name: string) => {
			calls.push({ method: "get", name });
			return Promise.resolve(handle(name));
		},
		import: () => {
			calls.push({ method: "import" });
			return Promise.reject(new Error("not used"));
		},
		list: () => {
			calls.push({ method: "list" });
			return Promise.resolve({ repos: [], total: 0 });
		},
		delete: (name: string) => {
			calls.push({ method: "delete", name });
			return Promise.resolve(true);
		},
	};
	return store as unknown as RepoStore;
};

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export type TreeFake = {
	roles: Map<string, EffectiveRole>;
	protected: string[];
	failing: boolean;
};

export type GitJobsFake = KernelGitJobs & {
	readonly calls: { method: string; args: unknown[] }[];
};

export type Harness = {
	readonly storage: FakeStorage;
	readonly clock: FakeClock;
	readonly facade: RepoCoreFacade;
	readonly internal: RepoCoreInternal;
	readonly events: FakeEvents;
	readonly land: FakeLand;
	readonly upstream: FakeUpstream;
	readonly artifactsCalls: ArtifactsCall[];
	readonly probeCalls: { source: GitSource; after: string }[];
	readonly tree: TreeFake;
	readonly gitJobs: GitJobsFake;
	readonly timers: Timers;
	readonly logs: { message: string; data: Record<string, unknown> }[];
	readonly repoId: string;
	readonly nodeId: string;
	readonly canonical: string;
	/** Replaces RepoProbe's lane diff. */
	setLaneDiff(
		diff: (source: GitSource, after: string) => Promise<DiffResult>,
	): void;
	/** Replaces WP7b's gate dispatcher (default: the stub, "no gates"). */
	setGates(gates: () => Promise<GateDispatchResult>): void;
	/** Runs every due timer (the body of `alarm()`). */
	runTimers(): ReturnType<Timers["runDue"]>;
	/** Awaits detached work (`ctx.waitUntil`). */
	settle(): Promise<void>;
	ulid(): string;
};

export type HarnessOptions = {
	readonly laneMode?: "import" | "branch";
	readonly createRepoBackend?: (deps: unknown) => RepoBackend;
	readonly pushLeases?: boolean;
	/** Skip `init` (tests of an uninitialized repo). */
	readonly noInit?: boolean;
	readonly trunk?: string;
};

export const TRUNK = sha(1);

export const createHarness = async (
	options: HarnessOptions = {},
): Promise<Harness> => {
	const storage = createFakeStorage();
	const clock = createClock();
	const ulid = createUlid({ now: () => clock.now() });
	const upstream = createUpstream();
	const artifactsCalls: ArtifactsCall[] = [];
	const probeCalls: { source: GitSource; after: string }[] = [];
	const logs: { message: string; data: Record<string, unknown> }[] = [];
	const waits: Promise<unknown>[] = [];
	const repoId = ulid();
	const nodeId = repoId;
	const canonical = `r-${repoId}`;
	const tree: TreeFake = { roles: new Map(), protected: [], failing: false };
	let laneDiff = (source: GitSource, after: string): Promise<DiffResult> =>
		Promise.resolve({
			rangeBase: TRUNK,
			rangeTruncated: false,
			diffKey: `diffs/${source.repoId}/${TRUNK}..${after}.json`,
			commits: [{ sha: after, subject: "work", trailers: [] }],
			paths: ["src/a.ts"],
			truncated: false,
		});
	let gates: () => Promise<GateDispatchResult> = () =>
		Promise.reject(notImplemented("exthost.dispatch.gates"));

	const timers = createTimers({ storage, clock, modules: ["core"] });
	let internalRef: RepoCoreInternal | null = null;
	const events = createFakeEvents(storage.sql, clock, () => {
		if (internalRef === null) throw new Error("core not created");
		return internalRef;
	});
	const land = createFakeLand();
	let facadeRef: RepoCoreFacade | null = null;

	const gitCalls: { method: string; args: unknown[] }[] = [];
	const gitJobs: GitJobsFake = {
		calls: gitCalls,
		genesis: () => Promise.reject(notImplemented("genesis")),
		refWrite: async (rid, intents: readonly KernelWriteIntent[]) => {
			gitCalls.push({ method: "refWrite", args: [rid, intents] });
			const facade = facadeRef as RepoCoreFacade;
			const results = [];
			for (const intent of intents) {
				const row = await facade.registerKernelWrite(intent);
				const current = upstream.get(canonical, intent.ref) ?? ZERO_SHA;
				if (current !== intent.expectOld) {
					results.push({ ref: intent.ref, ok: false, reason: "stale ref" });
					continue;
				}
				upstream.set(canonical, intent.ref, intent.newSha);
				await facade.markKernelWrite(row.id, "pushed");
				results.push({ ref: intent.ref, ok: true });
			}
			return results;
		},
		archive: (rid, laneId, o) => {
			gitCalls.push({ method: "archive", args: [rid, laneId, o] });
			return Promise.resolve(
				o.atticRef
					? {
						kind: "ref" as const,
						ref: o.atticRef,
						head: sha(77),
						vetoed: false,
					}
					: { kind: "summary" as const, vetoed: false },
			);
		},
		sync: (rid, laneId) => {
			gitCalls.push({ method: "sync", args: [rid, laneId] });
			return Promise.resolve({ ok: true, head: sha(55) });
		},
		restack: (rid, laneId, onto) => {
			gitCalls.push({ method: "restack", args: [rid, laneId, onto] });
			return Promise.resolve({ ok: true, head: sha(56) });
		},
		repair: () => Promise.reject(notImplemented("repair")),
	};

	const treeFacade = {
		node: (id: string) => {
			if (tree.failing) return Promise.reject(new Error("forge down"));
			return Promise.resolve(
				id === nodeId
					? {
						id,
						parentId: null,
						kind: "repo",
						slug: "shop",
						path: "acme/shop",
						depth: 1,
						visibility: "private",
						archived: false,
						createdAt: 0,
					}
					: null,
			);
		},
		effectiveRole: (principals: string[]) => {
			if (tree.failing) return Promise.reject(new Error("forge down"));
			return Promise.resolve(
				Math.max(
					0,
					...principals.map((p) => tree.roles.get(p) ?? 0),
				) as EffectiveRole,
			);
		},
		protectedRefs: () => {
			if (tree.failing) return Promise.reject(new Error("forge down"));
			return Promise.resolve([...tree.protected]);
		},
	} as unknown as TreeFacade;

	const ports: Partial<CorePorts> = {
		artifacts: createRecordingArtifacts(upstream, clock, artifactsCalls),
		forgeTree: () => treeFacade,
		canonicalOrigin: () => Promise.resolve("https://git.example.test"),
		gitJobs,
		dispatch: { gates: () => gates() },
		probe: () => ({
			laneDiff: (source, after) => {
				probeCalls.push({ source, after });
				return laneDiff(source, after);
			},
		}),
		lsRefs: lsRefsOf(upstream),
		laneMode: options.laneMode ?? "branch",
		pushLeases: options.pushLeases ?? false,
		waitUntil: (promise) => void waits.push(promise),
		log: (message, data) => void logs.push({ message, data }),
		sleep: (ms) => {
			clock.advance(ms);
			return Promise.resolve();
		},
	};

	const module = createRepoCoreModule({
		...(options.createRepoBackend
			? { createRepoBackend: options.createRepoBackend as never }
			: {}),
		ports: () => ports,
	});
	runMigrations(
		storage,
		migrationSources([COMMON_MIGRATIONS.base], [module]),
		clock,
	);
	const modules = {} as Record<string, unknown>;
	const deps = {
		sql: storage.sql,
		storage: storage as unknown as DurableObjectStorage,
		ctx: {
			waitUntil: (p: Promise<unknown>) => void waits.push(p),
			storage,
			exports: {},
		} as unknown as DurableObjectState,
		env: {} as Env,
		modules,
		timers: bindTimers(timers, "core"),
		clock,
		ids: { ulid },
	} as unknown as ModuleDeps<Env, RepoInternals>;
	const instance = module.create(deps);
	Object.assign(modules, {
		core: instance.internal,
		events,
		land,
		probe: {},
		runs: {},
	});
	internalRef = instance.internal;
	facadeRef = instance.facade;
	await timers.init();

	if (!options.noInit) {
		const trunk = options.trunk ?? TRUNK;
		upstream.set(canonical, "refs/heads/main", trunk);
		await instance.facade.init({
			repoId,
			nodeId,
			path: "acme/shop",
			defaultBranch: "main",
			refs: { "refs/heads/main": trunk },
		});
	}

	return {
		storage,
		clock,
		facade: instance.facade,
		internal: instance.internal,
		events,
		land,
		upstream,
		artifactsCalls,
		probeCalls,
		tree,
		gitJobs,
		timers,
		logs,
		repoId,
		nodeId,
		canonical,
		setLaneDiff: (diff) => {
			laneDiff = diff;
		},
		setGates: (next) => {
			gates = next;
		},
		runTimers: () => timers.runDue({ core: instance.onTimer }),
		settle: async () => {
			while (waits.length > 0) {
				await Promise.allSettled(waits.splice(0));
			}
		},
		ulid,
	};
};

/** Principal ids of a fresh harness. */
export const principals = (h: Pick<Harness, "ulid">) => ({
	user: `u_${h.ulid()}`,
	agent: `a_${h.ulid()}`,
});

export { ROLE };

/**
 * A `RepoBackend` standing in for WP5b's seeder: `planOpening` plans an
 * `import` attempt at the trunk tip; `startAttempt` only records the call
 * (the seed never finishes unless a test moves the lane itself).
 */
export const fakeRepoBackend = (record: { started: string[] } = {
	started: [],
}) =>
(deps: unknown): RepoBackend => {
	const { core } = deps as {
		core: { internal: RepoCoreInternal };
	};
	const stub = createRepoBackend(deps as never);
	return {
		...stub,
		planOpening: (laneId: string, now: number) => {
			const repoUlid = core.internal.metaSync("repo_id") as string;
			const base = core.internal.refSync("refs/heads/main")?.sha as string;
			return {
				mode: "repo",
				seed: "import",
				seedPhase: "cap",
				seedDeadline: now + 13_000,
				repoName: laneArtifactsName(repoUlid, laneId.slice(3)),
				capNonce: `${laneId.slice(3)}000000`.slice(0, 32),
				base,
			};
		},
		startAttempt: (laneId: string) => void record.started.push(laneId),
		onSeedTimer: () => {},
	};
};
