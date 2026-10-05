// The `LaneBackend` and `RepoBackend` seams between WP5a and WP5b: both
// backends exist behind the facade, the `core` module creates WP5b's backend
// from `RepoBackendDeps`, delegates the WP5b facade methods to it, routes the
// `seed:` timer prefix to its watchdog and accepts an injected factory, and the
// `core` module's migration range is split 100–179 (WP5a) / 180–199 (WP5b).
// Pure Deno tests.

import {
	deepStrictEqual,
	equal,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import { fromRpcError } from "@tartan/contract";
import {
	type LaneBackend,
	MIGRATION_RANGES,
	migrationIssues,
	type ModuleDeps,
	type RepoBackend,
	type RepoBackendDeps,
	type RepoInternals,
	seedTimerKey,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../../env.ts";
import {
	CORE_OWN_MIGRATION_RANGE,
	coreOwnMigrations,
	coreTimerHandler,
	createRepoCoreModule,
	REPO_BACKEND_FACADE_METHODS,
	repoCoreModule,
} from "../module.ts";
import { createLaneBackends } from "./facade.ts";
import {
	createRepoBackend,
	REPO_BACKEND_MIGRATION_RANGE,
	repoBackendMigrations,
} from "./repo-backend/index.ts";

const isNotImplemented = (error: unknown): boolean =>
	fromRpcError(error).code === "not_implemented";

const LANE = "ln_01k6c0ffee0000000000000000";

/** Module deps whose platform members are never touched by the stubs. */
const fakeModuleDeps = (): ModuleDeps<Env, RepoInternals> =>
	({
		env: { ARTIFACTS: {}, FORGE: {} },
		modules: {},
		timers: {},
		clock: { now: () => 0 },
		ids: { ulid: () => "0" },
	}) as unknown as ModuleDeps<Env, RepoInternals>;

Deno.test("createLaneBackends keys both backends by lanes.mode", () => {
	const repo = createRepoBackend({} as RepoBackendDeps<Env>);
	const branch = { name: "branch" } as unknown as LaneBackend;
	const backends = createLaneBackends({ branch, repo });
	deepStrictEqual(Object.keys(backends).sort(), ["branch", "repo"]);
	equal(backends.repo, repo.backend);
	equal(backends.branch, branch);
	equal(backends.repo.name, "repo");
	equal(
		"open" in backends.repo,
		false,
		"opening is RepoBackend's, not a LaneBackend method",
	);
});

Deno.test("the core range splits into WP5a 100–179 and WP5b 180–199", () => {
	const [min, max] = MIGRATION_RANGES.repo.core;
	deepStrictEqual([
		CORE_OWN_MIGRATION_RANGE[0],
		REPO_BACKEND_MIGRATION_RANGE[1],
	], [
		min,
		max,
	]);
	equal(CORE_OWN_MIGRATION_RANGE[1] + 1, REPO_BACKEND_MIGRATION_RANGE[0]);
	deepStrictEqual(
		migrationIssues("core (WP5a)", CORE_OWN_MIGRATION_RANGE, coreOwnMigrations),
		[],
	);
	deepStrictEqual(
		migrationIssues(
			"core (repo backend)",
			REPO_BACKEND_MIGRATION_RANGE,
			repoBackendMigrations,
		),
		[],
	);
	deepStrictEqual(repoCoreModule.migrations, [
		...coreOwnMigrations,
		...repoBackendMigrations,
	]);
	ok(repoCoreModule.range === MIGRATION_RANGES.repo.core);
});

Deno.test("the repo backend (WP5b) validates its RPC entry points and never throws from startAttempt", async () => {
	const repo = createRepoBackend({} as RepoBackendDeps<Env>);
	equal(repo.backend.name, "repo");
	const isInvalid = (error: unknown): boolean =>
		fromRpcError(error).code === "invalid";
	await rejects(async () => await repo.capUse("x", "y", "info"), isInvalid);
	await rejects(async () => await repo.capContext(LANE, "nope"), isInvalid);
	await rejects(
		async () =>
			await repo.capReport(LANE, "0".repeat(32), {
				op: "pack",
				outcome: "bogus" as never,
			}),
		isInvalid,
	);
	await rejects(
		async () => await repo.archive("x", { vetoed: false }),
		isInvalid,
	);
	await rejects(async () => await repo.purge("x"), isInvalid);
	throws(() => repo.planOpening("x", 0), isInvalid);
	const logged = console.error;
	console.error = () => {};
	try {
		equal(repo.startAttempt(LANE), undefined);
	} finally {
		console.error = logged;
	}
});

Deno.test("the core module builds the repo backend from RepoBackendDeps and delegates WP5b's facade methods", async () => {
	const calls: string[] = [];
	let received: RepoBackendDeps<Env> | null = null;
	const fake = new Proxy({} as RepoBackend, {
		get: (_target, name) =>
			name === "backend"
				? createRepoBackend({} as RepoBackendDeps<Env>).backend
				: (...args: unknown[]) => {
					const given = args.filter((arg) => arg !== undefined);
					calls.push(`${String(name)}(${given.join(",")})`);
					return Promise.resolve(`fake:${String(name)}`);
				},
	});
	const module = createRepoCoreModule({
		createRepoBackend: (deps) => {
			received = deps;
			return fake;
		},
	});
	const instance = module.create(fakeModuleDeps());
	ok(received !== null, "the factory received its deps");
	const deps = received as RepoBackendDeps<Env>;
	for (
		const key of [
			"core",
			"artifacts",
			"forgeTree",
			"gitJobs",
			"capMac",
			"canonicalOrigin",
			"env",
			"modules",
			"timers",
			"clock",
		]
	) {
		ok(key in deps, key);
	}
	equal(deps.core.internal, instance.internal);
	const facade = instance.facade as unknown as Record<
		string,
		(...args: unknown[]) => Promise<unknown>
	>;
	for (const method of REPO_BACKEND_FACADE_METHODS) {
		equal(await facade[method](LANE), `fake:${method}`, method);
	}
	deepStrictEqual(
		calls,
		REPO_BACKEND_FACADE_METHODS.map((method) => `${method}(${LANE})`),
	);
	// WP5a's own methods are WP5a's (K16 first): never delegated. The lane
	// settings are `meta` reads and writes the core serves on either backend.
	for (
		const method of [
			"openLane",
			"closeLane",
			"archiveLane",
			"purgeLane",
			"laneSettings",
			"setLaneSettings",
		]
	) {
		await rejects(
			async () => await facade[method](),
			(error: unknown) => !isNotImplemented(error),
			method,
		);
	}
	equal(calls.length, REPO_BACKEND_FACADE_METHODS.length);
});

Deno.test("seed:<laneId> timers reach the repo backend's watchdog; other core keys stay WP5a's", async () => {
	const seen: string[] = [];
	const handler = coreTimerHandler(
		{ onSeedTimer: (key) => void seen.push(`seed ${key}`) },
		(key) => void seen.push(`own ${key}`),
	);
	await handler(seedTimerKey(LANE));
	await handler("lease");
	await handler("observe:x");
	deepStrictEqual(seen, [`seed seed:${LANE}`, "own lease", "own observe:x"]);
	// The default module routes `seed:` to WP5b's watchdog, which never
	// throws (it logs and leaves the lane to the cron's re-drive).
	const instance = repoCoreModule.create(fakeModuleDeps());
	const logged = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => void lines.push(args.join(" "));
	try {
		equal(await instance.onTimer?.(seedTimerKey(LANE)), undefined);
	} finally {
		console.error = logged;
	}
	ok(lines.some((line) => line.includes("seed watchdog failed")));
});
