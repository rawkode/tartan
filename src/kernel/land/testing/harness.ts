// Test-only (Deno): one RepoDO with the REAL `core` (WP5a), the REAL event
// log (WP6's `createEventLog`) and the REAL `land` module (WP10) on the
// `node:sqlite` storage fake, against `@tartan/testkit`'s FakeArtifacts
// served on 127.0.0.1 (real git objects, per-ref compare-and-swap, push
// events), with stock git as the sandbox (`GitExec` on a temp mirror), the
// real kernel git jobs and the real LandWorkflow driver under a fake step
// runner. Never imported by runtime code.

import {
	type AppendInput,
	createUlid,
	type EffectiveRole,
	type LaneMode,
	type NoticeInput,
	notImplemented,
	repoArtifactsName,
	ROLE,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type ArtifactsIndexRow,
	type CapMac,
	type GateDispatchResult,
	type GitExecOptions,
	type GitExecResult,
	type IndexArtifactsInput,
	KERNEL_LANE_ACTOR,
	type LaneOpActor,
	type ModuleDeps,
	type RepoCoreFacade,
	type RepoInternals,
	type TreeFacade,
} from "@tartan/contract/kernel.ts";
import { lsRefs } from "@tartan/gitproto";
import { createFakeArtifacts, type FakeArtifacts } from "@tartan/testkit";
import {
	COMMON_MIGRATIONS,
	migrationSources,
	runMigrations,
} from "../../../do/migrations.ts";
import { bindTimers, createTimers, type Timers } from "../../../do/timers.ts";
import type { Env } from "../../../env.ts";
import { createEventLog, REPO_EVENTS_MIGRATIONS } from "../../events/log.ts";
import { capMacOf } from "../../http/capmac.ts";
import {
	createRepoBackendWith,
	type RepoBackendPorts,
} from "../../repo/lanes/repo-backend/index.ts";
import {
	createTestCapRoute,
	type TestCapRoute,
} from "../../repo/lanes/repo-backend/testing/capserver.ts";
import { createRepoCoreModule } from "../../repo/module.ts";
import { createRepoConfigModule } from "../../repoconfig/module.ts";
import { artifactsReads } from "../../repoconfig/reader.ts";
import {
	createFakeStorage,
	type FakeStorage,
} from "../../repo/testing/sqlite.ts";
import { driveLand, type DriveResult, type LandServices } from "../driver.ts";
import { createLandGit, type GitRunner } from "../git.ts";
import { createKernelGitJobsWith } from "../gitjobs.ts";
import { createRepoLandModule } from "../module.ts";
import type { LandFacade } from "../types.ts";
import { createLaneRepoAccess } from "../lanerepos.ts";
import { createCanonicalAccess } from "../upstream.ts";
import type { PrincipalInfo } from "../ctx.ts";
import { createFakeStep, type FakeStep } from "./step.ts";

export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

const decoder = new TextDecoder();

/** True when a `git` binary is on PATH. */
export const hasGit: boolean = (() => {
	try {
		return new Deno.Command("git", {
			args: ["--version"],
			stdout: "null",
			stderr: "null",
		}).outputSync().success;
	} catch {
		return false;
	}
})();

/** A hermetic environment for stock git. */
const gitEnv = (home: string): Record<string, string> => ({
	PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
	HOME: home,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: "C",
});

/**
 * Stock git as `GitExec`: argv only, `options.env` merged into a hermetic
 * environment, `stdin` piped, `uid` recorded (one OS user here).
 */
export const createLocalGitExec = (home: string, record?: {
	execs: {
		argv: readonly string[];
		uid: string;
		env: Record<string, string>;
	}[];
}): GitRunner =>
async (
	argv: readonly string[],
	options: GitExecOptions = {},
): Promise<GitExecResult> => {
	if (argv[0] !== "git") throw new Error(`not a git argv: ${argv[0]}`);
	const env = { ...gitEnv(home), ...(options.env ?? {}) };
	record?.execs.push({
		argv: [...argv],
		uid: options.uid ?? "tartan-git",
		env: { ...(options.env ?? {}) },
	});
	const started = Date.now();
	const child = new Deno.Command("git", {
		args: argv.slice(1),
		cwd: options.cwd ?? home,
		env,
		clearEnv: true,
		stdin: options.stdin !== undefined ? "piped" : "null",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (options.stdin !== undefined) {
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(options.stdin));
		await writer.close();
	}
	const out = await child.output();
	return {
		exitCode: out.code,
		stdout: decoder.decode(out.stdout),
		stderr: decoder.decode(out.stderr),
		durationMs: Date.now() - started,
	};
};

/** Runs stock git in a work tree (test setup); throws on failure. */
export const gitIn = async (
	home: string,
	cwd: string,
	args: readonly string[],
	options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<string> => {
	const result = await createLocalGitExec(home)(["git", ...args], {
		cwd,
		...(options.env ? { env: options.env } : {}),
		...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	}
	return result.stdout.trim();
};

export type GatesFn = (input: unknown) => Promise<GateDispatchResult>;

export type LandHarness = {
	readonly storage: FakeStorage;
	readonly clock: {
		now(): number;
		advance(ms: number): void;
		set(at: number): void;
	};
	readonly fake: FakeArtifacts;
	readonly origin: string;
	readonly repoId: string;
	readonly nodeId: string;
	readonly canonical: string;
	readonly core: RepoCoreFacade;
	readonly coreInternal: RepoInternals["core"];
	readonly land: LandFacade;
	readonly landInternal: RepoInternals["land"];
	/** Repository config (WP23), when the harness composes it (`repoConfig`). */
	readonly repoconfig:
		| {
			readonly facade: import("@tartan/contract/kernel.ts").RepoConfigFacade;
			readonly internal: RepoInternals["repoconfig"];
		}
		| null;
	readonly events: ReturnType<typeof createEventLog>;
	readonly timers: Timers;
	readonly home: string;
	readonly execs: {
		argv: readonly string[];
		uid: string;
		env: Record<string, string>;
	}[];
	readonly instances: { id: string; params: unknown }[];
	readonly sentEvents: { id: string; type: string; payload: unknown }[];
	readonly instanceStates: Map<string, string>;
	readonly principals: Map<string, PrincipalInfo>;
	readonly logs: { message: string; data: Record<string, unknown> }[];
	reviewProvider: string | null | undefined;
	/** ForgeDO's repo-config hold (`registry.landContext`), e.g. `gate-missing`. */
	forgeHold: string | null;
	/** Dev tools for the dev-only seeding (default off). */
	devTools: boolean;
	/** Its generation (`configHoldId`). */
	forgeHoldId: number | undefined;
	gates: GatesFn | null;
	/** Fails (exit 128, no side effect) the next git exec matching it, once. */
	failExec: ((argv: readonly string[]) => boolean) | null;
	/** `LAND.create` fails this many more times. */
	failCreates: number;
	/** The land ports' `laneRange` (phase 2 of a push) fails while set. */
	failLaneRange: boolean;
	/** The sandbox's mirror directory (delete it to model a restart). */
	readonly mirrorRoot: string;
	readonly services: LandServices;
	/** The stand-in for WP4's capability route that `import()` pulls through. */
	readonly capRoute: TestCapRoute;
	readonly capMac: CapMac;
	/** WP3's `artifacts_index`, faked (with the forge's lane-repo ceiling). */
	readonly index: Map<string, ArtifactsIndexRow>;
	/** Kernel notices delivered to principals' inboxes. */
	readonly notices: { principal: string; notice: NoticeInput }[];
	/** The fake ForgeDO tree (tests may replace its methods). */
	readonly tree: TreeFacade;
	readonly gitJobs: ReturnType<typeof createKernelGitJobsWith>;
	runTimers(): ReturnType<Timers["runDue"]>;
	settle(): Promise<void>;
	ulid(): string;
	/** Feeds every fake push event into `observePush` (the trigger, K1/K2). */
	observeAll(): Promise<number>;
	/** Runs LandWorkflow for a batch under a fresh fake step runner. */
	drive(batchId: string, step?: FakeStep): Promise<DriveResult>;
	close(): Promise<void>;
};

export type LandHarnessOptions = {
	/** `create` the Artifacts repo and run genesis (default true). */
	readonly genesis?: boolean;
	/**
	 * Composes the REAL `repoconfig` module with `TARTAN_REPO_CONFIG` on
	 * (WP23): the K13.2/K13.3 land checks and the K13.1 hold. Its evaluator
	 * is unavailable and its registry is empty, so a policy landing stays
	 * pending until a test releases it.
	 */
	readonly repoConfig?: boolean;
	/** The forge default `LANE_MODE` (default `branch`). */
	readonly laneMode?: LaneMode;
	/** Ports of WP5b's `repo` lane backend to replace. */
	readonly repoBackendPorts?: Partial<RepoBackendPorts>;
	/** The forge-wide ceiling of retained lane repos (default 1,000). */
	readonly laneRepoCeiling?: number;
	/** FakeArtifacts' `import()` fails with `MEMORY_LIMIT` above this. */
	readonly importMaxBytes?: number;
	/** The canonical repo's default branch (default `main`). */
	readonly defaultBranch?: string;
	/** Create, init and genesis the canonical repo (default true). */
	readonly init?: boolean;
	/** The lane modes an Owner may set per repo (WP5a's `laneModes`). */
	readonly ownerLaneModes?: readonly LaneMode[];
};

export const createLandHarness = async (
	options: LandHarnessOptions = {},
): Promise<LandHarness> => {
	const home = await Deno.makeTempDir({ prefix: "tartan-land-" });
	const storage = createFakeStorage();
	let now = T0;
	const clock = {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		set: (at: number) => {
			now = at;
		},
	};
	const ulid = createUlid({ now: () => clock.now() });

	// FakeArtifacts on loopback, so stock git can fetch and push.
	let fake: FakeArtifacts | null = null;
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
		(req) => (fake as FakeArtifacts).fetch(req),
	);
	const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
	// `import()` pulls non-fake URLs through the capability route stand-in.
	let capRouteRef: TestCapRoute | null = null;
	fake = createFakeArtifacts({
		origin,
		now: () => clock.now(),
		fetch: (req) => (capRouteRef as TestCapRoute)(req),
		...(options.importMaxBytes !== undefined
			? { importMaxBytes: options.importMaxBytes }
			: {}),
	});
	const artifacts = fake;
	const capKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode("tartan-test-lane-cap-key-0123456789"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const capMac = capMacOf(() => Promise.resolve(capKey));

	const repoId = ulid();
	const nodeId = repoId;
	const canonical = repoArtifactsName(repoId);
	const logs: { message: string; data: Record<string, unknown> }[] = [];
	const waits: Promise<unknown>[] = [];
	const execs: LandHarness["execs"] = [];
	const instances: { id: string; params: unknown }[] = [];
	const sentEvents: { id: string; type: string; payload: unknown }[] = [];
	const instanceStates = new Map<string, string>();
	const principals = new Map<string, PrincipalInfo>();
	const log = (message: string, data: Record<string, unknown>) =>
		void logs.push({ message, data });

	const faults: {
		exec: ((argv: readonly string[]) => boolean) | null;
		creates: number;
	} = { exec: null, creates: 0 };
	const localExec = createLocalGitExec(home, { execs });
	const exec: GitRunner = (argv, options) => {
		if (faults.exec !== null && faults.exec(argv)) {
			faults.exec = null;
			return Promise.resolve({
				exitCode: 128,
				stdout: "",
				stderr: "fatal: injected failure",
				durationMs: 0,
			});
		}
		return localExec(argv, options);
	};
	const mirrorRoot = `${home}/srv`;
	await Deno.mkdir(mirrorRoot, { recursive: true });

	// Facades are created below; the git jobs and ports reach them lazily.
	let coreFacade: RepoCoreFacade | null = null;
	let landFacade: LandFacade | null = null;
	const harnessRef: {
		gates: GatesFn | null;
		reviewProvider: string | null | undefined;
		forgeHold: string | null;
		devTools: boolean;
		forgeHoldId: number | undefined;
		failLaneRange: boolean;
	} = {
		gates: null,
		reviewProvider: undefined,
		forgeHold: null,
		devTools: false,
		forgeHoldId: undefined,
		failLaneRange: false,
	};
	const dispatch = {
		gates: (_point: unknown, input: unknown) =>
			harnessRef.gates === null
				? Promise.reject(notImplemented("exthost.dispatch.gates"))
				: harnessRef.gates(input),
	};
	const probe = () => ({
		addedLines: () => Promise.resolve({ lines: [], truncated: false }),
		diffPaths: () => Promise.resolve({ paths: [], truncated: false }),
		affected: () => Promise.resolve({ projects: [], global: false }),
	});
	const gitJobs = createKernelGitJobsWith({
		artifacts,
		core: () => coreFacade as RepoCoreFacade,
		land: () => landFacade as LandFacade,
		exec: () => exec,
		gates: dispatch as never,
		probe: probe as never,
		mirrorRoot,
		now: () => clock.now(),
		sleep: (ms) => {
			clock.advance(ms);
			return Promise.resolve();
		},
		log,
	});

	const roles = new Map<string, EffectiveRole>();
	const index = new Map<string, ArtifactsIndexRow>();
	const ceiling = options.laneRepoCeiling ?? 1_000;
	const STATE_ORDER = { pending: 0, live: 1, deleted: 2 } as const;
	const retained = () =>
		[...index.values()].filter((r) =>
			r.kind === "lane" && r.state !== "deleted"
		).length;
	const notices: { principal: string; notice: NoticeInput }[] = [];
	const treeFacade = {
		indexArtifacts: (input: IndexArtifactsInput) => {
			const name = input.name.toLowerCase();
			const now = clock.now();
			const existing = index.get(name);
			if (existing !== undefined) {
				if (STATE_ORDER[input.state] > STATE_ORDER[existing.state]) {
					index.set(name, { ...existing, state: input.state, updated_at: now });
				}
				return Promise.resolve({ ok: true });
			}
			if (
				input.kind === "lane" && input.state === "pending" &&
				retained() >= ceiling
			) {
				return Promise.resolve({ ok: false, reason: "lane-repo-ceiling" });
			}
			index.set(name, {
				name,
				kind: input.kind,
				repo_id: input.repoId,
				lane_id: input.laneId ?? null,
				state: input.state,
				created_at: now,
				updated_at: now,
			});
			return Promise.resolve({ ok: true });
		},
		lookupArtifacts: (name: string) =>
			Promise.resolve(index.get(name.toLowerCase()) ?? null),
		listArtifactsIndex: (
			state: ArtifactsIndexRow["state"],
			olderThan: number,
		) =>
			Promise.resolve(
				[...index.values()].filter((r) =>
					r.state === state && r.updated_at < olderThan
				),
			),
		countLaneRepos: () =>
			Promise.resolve({ retained: retained(), max: ceiling }),
		grants: () => Promise.resolve([]),
		node: (id: string) =>
			Promise.resolve(
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
			),
		effectiveRole: (ps: string[]) =>
			Promise.resolve(
				Math.max(0, ...ps.map((p) => roles.get(p) ?? 0)) as EffectiveRole,
			),
		protectedRefs: () => Promise.resolve([]),
	} as unknown as TreeFacade;

	const timers = createTimers({
		storage,
		clock,
		modules: options.repoConfig === true
			? ["core", "land", "repoconfig"]
			: ["core", "land"],
	});
	const coreModule = createRepoCoreModule({
		ports: () => ({
			artifacts,
			forgeTree: () => treeFacade,
			canonicalOrigin: () => Promise.resolve("https://git.example.test"),
			gitJobs,
			capMac,
			dispatch,
			probe: () => ({
				laneDiff: (_source, after) =>
					Promise.resolve({
						rangeBase: ZERO_SHA,
						rangeTruncated: true,
						diffKey: `diffs/${repoId}/${after}.json`,
						commits: [],
						paths: [],
						truncated: false,
					}),
			}),
			lsRefs: (remote, o) => lsRefs(remote, o),
			laneMode: options.laneMode ?? "branch",
			pushLeases: false,
			waitUntil: (p) => void waits.push(p),
			log,
			sleep: (ms) => {
				clock.advance(ms);
				return Promise.resolve();
			},
		}),
		...(options.ownerLaneModes !== undefined
			? { laneModes: options.ownerLaneModes }
			: {}),
		createRepoBackend: (deps) =>
			createRepoBackendWith(deps, {
				lsRefs: (remote, o) => lsRefs(remote, o),
				notify: (principal, notice) => {
					notices.push({ principal, notice });
					return Promise.resolve();
				},
				log,
				sleep: (ms) => {
					clock.advance(ms);
					return Promise.resolve();
				},
				laneMode: options.laneMode ?? "branch",
				chain: ["import", "branch"],
				...(options.repoBackendPorts ?? {}),
			}),
	});
	const landModule = createRepoLandModule({
		ports: () => ({
			createInstance: (id, params) => {
				if (faults.creates > 0) {
					faults.creates--;
					return Promise.reject(new Error("workflows: internal error"));
				}
				if (instances.some((i) => i.id === id)) {
					return Promise.resolve("exists");
				}
				instances.push({ id, params });
				instanceStates.set(id, "running");
				return Promise.resolve("created");
			},
			instanceStatus: (id) =>
				Promise.resolve(
					(instanceStates.get(id) ?? "missing") as Awaited<
						ReturnType<import("../ctx.ts").LandPorts["instanceStatus"]>
					>,
				),
			sendEvent: (id, type, payload) => {
				sentEvents.push({ id, type, payload });
				return Promise.resolve();
			},
			remoteRef: (ref) =>
				createCanonicalAccess({ artifacts, repoId }).refValue(ref),
			principal: (id) => Promise.resolve(principals.get(id) ?? null),
			canonicalHost: () => Promise.resolve("git.example.test"),
			reviewProvider: () => Promise.resolve(harnessRef.reviewProvider),
			landContext: () =>
				Promise.resolve({
					configHold: harnessRef.forgeHold,
					...(harnessRef.forgeHoldId === undefined
						? {}
						: { configHoldId: harnessRef.forgeHoldId }),
				}),
			gitJobs: () => gitJobs,
			artifacts: () => artifacts,
			devTools: () => harnessRef.devTools,
			closeLane: (laneId, reason) =>
				(coreFacade as RepoCoreFacade).closeLane(
					laneId,
					reason,
					KERNEL_LANE_ACTOR,
				),
			roleOf: (principal) => Promise.resolve(roles.get(principal) ?? 0),
			laneRange: async (laneId) => {
				if (harnessRef.failLaneRange) {
					throw new Error("Artifacts answered 500 (fault injected)");
				}
				await (coreFacade as RepoCoreFacade).laneRange(laneId);
			},
			waitUntil: (p) => void waits.push(p),
			log,
		}),
	});
	const configModule = options.repoConfig === true
		? createRepoConfigModule({
			enabled: true,
			ports: () => ({
				reads: async (name) => ({
					...artifactsReads(await artifacts.get(name)),
					close: () => {},
				}),
				schema: () =>
					Promise.resolve({
						repoId,
						epoch: 0,
						schemaKey: "0".repeat(64),
						files: {},
						entries: [],
						exportCommand: "",
					}),
				check: () =>
					Promise.resolve({
						denials: [],
						plan: [],
						epoch: 0,
						schemaKey: "0".repeat(64),
					}),
				apply: () =>
					Promise.reject(new Error("no registry in the land harness")),
				forgeState: () => Promise.resolve(null),
				submit: () =>
					Promise.resolve({
						accepted: false,
						reason: "unavailable",
						message: "no evaluator in the land harness",
					}),
				notify: () => Promise.resolve(),
				owners: () => Promise.resolve([]),
				log,
			}),
		})
		: null;
	runMigrations(
		storage,
		migrationSources([COMMON_MIGRATIONS.base], [
			coreModule,
			{ name: "events", range: [200, 249], migrations: REPO_EVENTS_MIGRATIONS },
			landModule,
			...(configModule === null ? [] : [configModule]),
		]),
		clock,
	);
	const modules = {} as Record<string, unknown>;
	const events = createEventLog({
		sql: storage.sql,
		transact: (fn) => storage.transactionSync(fn),
		clock,
		ids: { ulid },
		repoId: () => repoId,
		applyLaneEvent: (event) =>
			(modules.core as RepoInternals["core"]).applyLaneEventSync(event),
		onAppend: (event) =>
			(modules.repoconfig as RepoInternals["repoconfig"] | undefined)
				?.observeSync(event),
	});

	const depsFor = (module: string) =>
		({
			sql: storage.sql,
			storage: storage as unknown as DurableObjectStorage,
			ctx: {
				waitUntil: (p: Promise<unknown>) => void waits.push(p),
				storage,
				exports: {},
			} as unknown as DurableObjectState,
			env: {} as Env,
			modules,
			timers: bindTimers(timers, module),
			clock,
			ids: { ulid },
		}) as unknown as ModuleDeps<Env, RepoInternals>;
	const core = coreModule.create(depsFor("core"));
	const land = landModule.create(depsFor("land"));
	const config = configModule?.create(depsFor("repoconfig")) ?? null;
	Object.assign(modules, {
		core: core.internal,
		events,
		land: land.internal,
		probe: {},
		runs: {},
		...(config === null ? {} : { repoconfig: config.internal }),
	});
	coreFacade = core.facade;
	landFacade = land.facade;
	await timers.init();

	// The canonical repo, initialized, with its genesis commit.
	if (options.init !== false) {
		await artifacts.create(canonical);
		await core.facade.init({
			repoId,
			nodeId,
			path: "acme/shop",
			defaultBranch: options.defaultBranch ?? "main",
		});
	}
	if (options.init !== false && options.genesis !== false) {
		await gitJobs.genesis(repoId, {
			defaultBranch: options.defaultBranch ?? "main",
			message: "Initial commit",
			author: { name: "Tartan", email: "tartan@git.example.test" },
		});
	}

	const capRoute = createTestCapRoute({
		capMac,
		fake: artifacts,
		core: () => core.facade,
		now: () => clock.now(),
	});
	capRouteRef = capRoute;

	const services: LandServices = {
		land: land.facade,
		core: core.facade,
		canonical: createCanonicalAccess({ artifacts, repoId }),
		laneRepos: createLaneRepoAccess({ artifacts, repoId }),
		git: () => createLandGit({ exec, repoId, mirrorRoot }),
		probe: probe as never,
		get gates() {
			return dispatch as never;
		},
		log,
	};

	let seenPushEvents = 0;
	const observeAll = async (): Promise<number> => {
		const pending = artifacts.pushEvents.slice(seenPushEvents);
		seenPushEvents = artifacts.pushEvents.length;
		for (const e of pending) {
			await core.facade.observePush({
				eventId: e.id,
				repoName: e.source.repoName.toLowerCase(),
				ref: e.payload.ref,
				before: e.payload.before,
				after: e.payload.after,
				at: clock.now(),
			});
		}
		return pending.length;
	};

	const harness: LandHarness = {
		storage,
		clock,
		fake: artifacts,
		origin,
		repoId,
		nodeId,
		canonical,
		core: core.facade,
		coreInternal: core.internal,
		land: land.facade,
		landInternal: land.internal,
		repoconfig: config === null
			? null
			: { facade: config.facade, internal: config.internal },
		events,
		timers,
		home,
		execs,
		instances,
		sentEvents,
		instanceStates,
		principals,
		logs,
		get reviewProvider() {
			return harnessRef.reviewProvider;
		},
		get devTools() {
			return harnessRef.devTools;
		},
		set devTools(v) {
			harnessRef.devTools = v;
		},
		get forgeHold() {
			return harnessRef.forgeHold;
		},
		set forgeHold(v) {
			harnessRef.forgeHold = v;
		},
		get forgeHoldId() {
			return harnessRef.forgeHoldId;
		},
		set forgeHoldId(v) {
			harnessRef.forgeHoldId = v;
		},
		set reviewProvider(v) {
			harnessRef.reviewProvider = v;
		},
		get gates() {
			return harnessRef.gates;
		},
		set gates(v) {
			harnessRef.gates = v;
		},
		get failExec() {
			return faults.exec;
		},
		set failExec(v) {
			faults.exec = v;
		},
		get failCreates() {
			return faults.creates;
		},
		set failCreates(v) {
			faults.creates = v;
		},
		get failLaneRange() {
			return harnessRef.failLaneRange;
		},
		set failLaneRange(v) {
			harnessRef.failLaneRange = v;
		},
		mirrorRoot,
		services,
		capRoute,
		capMac,
		index,
		notices,
		tree: treeFacade,
		gitJobs,
		runTimers: () =>
			timers.runDue({
				core: core.onTimer,
				land: land.onTimer,
				...(config === null ? {} : { repoconfig: config.onTimer }),
			}),
		settle: async () => {
			while (waits.length > 0) await Promise.allSettled(waits.splice(0));
		},
		ulid,
		observeAll,
		drive: (batchId, step) =>
			driveLand(step ?? createFakeStep({ clock }), services, {
				repoId,
				batchId,
				instanceId: `land-${repoId}-${batchId.slice(3)}`,
				waitMode: "event",
			}),
		close: async () => {
			await server.shutdown();
			await Deno.remove(home, { recursive: true }).catch(() => {});
		},
	};
	Object.assign(harness, { roles });
	return harness;
};

/** The harness's role table (who holds which role on the repo). */
export const rolesOf = (h: LandHarness): Map<string, EffectiveRole> =>
	(h as unknown as { roles: Map<string, EffectiveRole> }).roles;

export { ROLE };

/** `Deno.test` with a fresh harness (skipped without a local git). */
export const landTest = (
	name: string,
	fn: (h: LandHarness) => Promise<void>,
	options: LandHarnessOptions = {},
): void =>
	Deno.test({
		name,
		ignore: !hasGit,
		sanitizeOps: false,
		sanitizeResources: false,
		fn: async () => {
			const h = await createLandHarness(options);
			try {
				await fn(h);
			} finally {
				await h.close();
			}
		},
	});

/** Event types of the repo log, in order. */
export const eventTypes = (h: LandHarness): string[] =>
	h.events.read({ since: 0, limit: 100_000 }).map((e) => e.type);

/** The log's events of one type. */
export const eventsOf = (h: LandHarness, type: string) =>
	h.events.read({ since: 0, limit: 100_000 }).filter((e) => e.type === type);

/**
 * Feeds every trigger event to K1/K2 and runs the observe timer past its
 * grace windows: a kernel write that was not registered raises
 * `ref.tampered` here.
 */
export const settleObservations = async (h: LandHarness): Promise<void> => {
	await h.observeAll();
	for (let i = 0; i < 3; i++) {
		h.clock.advance(10 * 60 * 1000);
		await h.runTimers();
		await h.settle();
	}
};

/** An agent actor for lane operations. */
export const agentActor = (id: string): LaneOpActor => ({ kind: "agent", id });

/** Appends an installation-sourced interface event (a provider's event). */
export const providerEvent = (
	h: LandHarness,
	input: {
		type: string;
		data: unknown;
		installation: string;
		shadow?: boolean;
		actor?: AppendInput["actor"];
	},
): string =>
	h.events.appendSync({
		type: input.type,
		source: {
			kind: "installation",
			id: input.installation,
			ext: "tartan.test@1.0.0",
		},
		actor: input.actor ?? { kind: "system", id: "sys_kernel" },
		node: h.nodeId,
		repo: h.repoId,
		depth: 0,
		shadow: input.shadow ?? false,
		data: input.data,
		idemKey: `test:${h.ulid()}`,
	}).id;
