// Workers-runtime tests (DOs, Workflows, entrypoints) under
// @cloudflare/vitest-pool-workers 0.22.0 with INLINE miniflare options.
//
// Rules (AGENTS.md rule 6):
// - Never point the pool at wrangler.jsonc; every binding added there is added
//   here in the same integrator commit.
// - Never add `durable_object_io_tasks_prevent_eviction` or a compatibility
//   date after 2026-08-22 here: the pool's workerd rejects both. The flag lives
//   in the deployed config only; live S7 covers that divergence.
//
// Tests are `*.workers.test.ts` (Deno unit tests are `*.test.ts`, see
// scripts/test.ts). Run all with `deno task test:workers`, or one project with
// `deno task test:workers --project <name>`.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { buildSync } from "esbuild";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromRoot = (path: string): string =>
	fileURLToPath(new URL(path, import.meta.url));

// Equal to COMPAT_DATE in packages/contract/src/product.ts.
const COMPAT_DATE = "2026-08-15";
const COMPAT_FLAGS = ["nodejs_compat", "global_fetch_strictly_public"];

// Bindings miniflare cannot run locally come from an auxiliary worker
// (test/fakes/bindings.worker.ts, owned by WP1 after M0; this path and its
// entrypoint names are the stable seam) as RPC entrypoints behind
// service bindings, so every binding name of wrangler.jsonc exists in tests:
// - ARTIFACTS: remote-only in miniflare → FakeArtifacts (@tartan/testkit's
//   in-memory namespace with real git objects; `import()` really pulls, and a
//   test-only `seed` RPC fills a credential-free mirror).
// - AI: remote-only → FakeAi.
// - ASSETS: the SPA build output (web/dist) may not exist → FakeAssets, a marker
//   SPA shell.
// - containers: TartanSandbox runs as a plain SQLite DO (no container).
const FAKES_WORKER = "tartan-test-fakes";
const fake = (entrypoint: string) => ({ name: FAKES_WORKER, entrypoint });

// The fakes worker imports @tartan/testkit, so it is bundled first
// (miniflare runs auxiliary workers without a build step).
const fakesScript = buildSync({
	entryPoints: [fromRoot("./test/fakes/bindings.worker.ts")],
	bundle: true,
	write: false,
	format: "esm",
	platform: "neutral",
	target: "es2023",
	external: ["cloudflare:*", "node:*"],
	tsconfig: fromRoot("./tsconfig.json"),
	logLevel: "silent",
}).outputFiles[0].text;

// Mirrors wrangler.jsonc with the fakes above.
const miniflare = {
	compatibilityDate: COMPAT_DATE,
	compatibilityFlags: COMPAT_FLAGS,
	serviceBindings: {
		ASSETS: fake("FakeAssets"),
		ARTIFACTS: fake("FakeArtifacts"),
		AI: fake("FakeAi"),
		// Test-only (not in wrangler.jsonc, never read by product code): the
		// fakes worker's default fetch, i.e. the fake repos' smart-HTTP remotes
		// and the public import mirror. End-to-end tests route the Worker's
		// outbound git fetches here (src/kernel/exthost/api/test/worker.ts).
		FAKES_HTTP: { name: FAKES_WORKER },
	},
	workers: [
		{
			name: FAKES_WORKER,
			modules: true,
			script: fakesScript,
			compatibilityDate: COMPAT_DATE,
			compatibilityFlags: COMPAT_FLAGS,
		},
	],
	durableObjects: {
		FORGE: { className: "ForgeDO", useSQLite: true },
		REPO: { className: "RepoDO", useSQLite: true },
		INBOX: { className: "InboxDO", useSQLite: true },
		EXT: { className: "ExtensionDO", useSQLite: true },
		SANDBOX: { className: "TartanSandbox", useSQLite: true },
		BUS: { className: "BusDO", useSQLite: true },
	},
	workflows: {
		RUNS: { name: "tartan-run", className: "RunWorkflow" },
		LAND: { name: "tartan-land", className: "LandWorkflow" },
		INGEST: { name: "tartan-ingest", className: "IngestWorkflow" },
		SWARM: { name: "tartan-swarm", className: "SwarmWorkflow" },
	},
	workerLoaders: { LOADER: {} },
	r2Buckets: { BLOBS: "tartan-blobs" },
	kvNamespaces: { OAUTH_KV: "tartan-oauth-kv" },
	bindings: {
		TARTAN_STAGE: "test",
		TARTAN_FEATURES: "echo,oauth",
		TARTAN_DEV_TOOLS: "0",
		TARTAN_MAX_PUSH_MB: "95",
		TARTAN_JUDGE_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		OIDC_ISSUER: "",
		OIDC_CLIENT_ID: "",
		// Rendered only by `render-config.ts --repo-config on` (absent = off in
		// a deploy); the workerd tests run repository config on, with the pool's
		// container-less TartanSandbox answering `unavailable` (WP23).
		TARTAN_REPO_CONFIG: "on",
		// Rendered only by `render-config.ts --projects scan` (absent = off in
		// a deploy); the workerd tests detect cuenv projects (WP25).
		TARTAN_PROJECTS: "scan",
	},
};

// Workspace packages resolve from source, as in deno.json "imports" and
// tsconfig.json "paths".
const TARTAN_PACKAGES = [
	"contract",
	"testkit",
	"gitproto",
	"ext-api",
	"monorepo",
	"diff",
	"pipeline",
];

const alias = TARTAN_PACKAGES.flatMap((name) => [
	{
		find: new RegExp(`^@tartan/${name}$`),
		replacement: fromRoot(`./packages/${name}/src/index.ts`),
	},
	{
		find: new RegExp(`^@tartan/${name}/(.*)$`),
		replacement: fromRoot(`./packages/${name}/src/$1`),
	},
]);

// One project per owning area (AGENTS.md, test file conventions). Every project
// shares the same worker and bindings; projects only partition test files, so
// a file matched by two projects is excluded from the broader one.
const PROJECTS: Record<string, readonly string[]> = {
	core: [
		"src/*.workers.test.ts",
		"src/do/**/*.workers.test.ts",
		"packages/**/*.workers.test.ts",
	],
	identity: [
		"src/kernel/identity/**/*.workers.test.ts",
		"src/kernel/http/**/*.workers.test.ts",
	],
	tree: [
		"src/kernel/tree/**/*.workers.test.ts",
		"src/kernel/browse/**/*.workers.test.ts",
	],
	gateway: ["src/kernel/gateway/**/*.workers.test.ts"],
	repo: [
		"src/kernel/repo/**/*.workers.test.ts",
		"src/kernel/ingest/**/*.workers.test.ts",
		// Repository config (WP23; ADR repo config): the RepoDO module.
		"src/kernel/repoconfig/**/*.workers.test.ts",
	],
	// WP5b's `repo` lane backend (excluded from `repo` below).
	"repo-backend": ["src/kernel/repo/lanes/repo-backend/**/*.workers.test.ts"],
	events: [
		"src/kernel/events/**/*.workers.test.ts",
		"src/kernel/inbox/**/*.workers.test.ts",
	],
	exthost: [
		"src/kernel/exthost/**/*.workers.test.ts",
		"src/kernel/caps/**/*.workers.test.ts",
	],
	probe: ["src/kernel/probe/**/*.workers.test.ts"],
	runs: ["src/kernel/runs/**/*.workers.test.ts"],
	land: ["src/kernel/land/**/*.workers.test.ts"],
	mcp: ["src/kernel/mcp/**/*.workers.test.ts"],
	swarm: ["src/kernel/swarm/**/*.workers.test.ts"],
	// The global log (WP26). No `k2` binding exists here: the pool's
	// miniflare has no K2 plugin, so tests inject FakeK2 (AGENTS.md rule 6).
	bus: ["src/kernel/bus/**/*.workers.test.ts"],
	// The projects API end to end over the real tartan.work and
	// tartan.changes (WP25) runs alone with them, like the extension tests.
	extensions: [
		"extensions/**/*.workers.test.ts",
		"src/kernel/projects/**/*.workers.test.ts",
	],
	// The slot conformance test: every first-party slot
	// through the real Worker entry with the SPA's own ctx builders.
	conformance: ["src/kernel/exthost/api/slot-conformance.workers.test.ts"],
	// The WASM runtime's workerd test (a Rust component through a Dynamic
	// Worker facet) is `exthost`'s `host/facet/dynamic.workers.test.ts`.
};

const EXCLUDES: Record<string, readonly string[]> = {
	repo: ["src/kernel/repo/lanes/repo-backend/**"],
	exthost: ["src/kernel/exthost/api/slot-conformance.workers.test.ts"],
};

/**
 * Groups run in order: the workerd projects without an entry here (0), the
 * SPA (1), then `events`, `extensions`, `conformance` and `swarm`, each
 * alone. `events` runs alone: its timing-sensitive cases
 * (WP6's append micro-bench, ≥ 1,000 RPC appends/s; three appends coalesced
 * into one live frame) failed beside the other workerd projects once WP10's
 * `land` project joined them (740-870 appends/s). A workerd project placed
 * in the SPA's group instead made the run hang at the group change.
 * `extensions` runs alone: WP13's DO join bench (< 50 ms per join over
 * 1,000 lanes) measured 61 ms beside the other workerd projects, 23 ms alone.
 * `conformance` runs alone: it drives two packs end to end through the
 * real Worker, and that load beside the other workerd projects can push
 * their budget-bound extension calls (weave's drain) past their budgets.
 * `swarm` runs alone last: beside the other workerd projects its file
 * finished every test and then never reported back, so the run hung at the
 * next group change (4 runs in 6 with the other workerd projects, on `main`
 * too; 0 in 13 alone or with the SPA only).
 */
const GROUP_ORDER: Readonly<Record<string, number>> = {
	events: 2,
	extensions: 3,
	conformance: 4,
	swarm: 5,
};

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: fromRoot("./src/index.ts"),
			miniflare,
		}),
	],
	resolve: { alias },
	test: {
		passWithNoTests: true,
		projects: [
			...Object.entries(PROJECTS).map(([name, include]) => ({
				extends: true as const,
				test: {
					name,
					include: [...include],
					exclude: [...(EXCLUDES[name] ?? []), "**/node_modules/**"],
					sequence: { groupOrder: GROUP_ORDER[name] ?? 0 },
				},
			})),
			// The SPA (WP18): standalone Node project, no workerd (`--project web`).
			// It runs after the default workerd group, so its 400-odd tests do
			// not compete for CPU with the timing-sensitive workerd cases (WP6's
			// append micro-bench runs in a later group, alone).
			{
				extends: "./web/vitest.config.ts",
				root: fromRoot("./web"),
				test: { name: "web", sequence: { groupOrder: 1 } },
			},
		],
	},
});
