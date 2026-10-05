// In-memory repositories for the planner tests: real git objects
// (@tartan/testkit's object store) read through WP8's detection, tree diff
// and affected closure (@tartan/monorepo), so the goldens run the planner on
// the graphs RepoProbe would produce.
//
// Tartan config (ADR repo config) is the repository's root package `tartan`.
// A snapshot's `tartan.cue` here is `package tartan` followed by a JSON
// object (valid CUE: a struct embedded at file level) that stands for the
// exported config; the world reads it as the trunk config of that commit
// (`caps.repo.policy`, the configured projects of the project graph). The
// kernel's evaluation and history are tested in src/kernel/repoconfig.

import {
	affectedBy,
	createTreeView,
	detectProjects,
	diffTrees,
	type GitObjects,
	type RawTreeEntry,
	touchedPaths,
} from "@tartan/monorepo";
import { diffStat, diffTexts } from "@tartan/diff";
import {
	createObjectStore,
	type FileMap,
	MODE,
	parseTree,
	writeTree,
} from "@tartan/testkit";
import type {
	Affected,
	ProjectGraph,
	RepoPolicyAnswer,
	TreeEntryType,
} from "@tartan/contract";

/** The root file the fixtures put Tartan config in. */
export const TARTAN_FILE = "tartan.cue";

export type TartanConfig = {
	readonly pipeline?: unknown;
	readonly owners?: unknown;
	readonly projects?: Readonly<Record<string, unknown>>;
	readonly global?: readonly string[];
};

/** A `tartan.cue` whose body is the exported config, as JSON (valid CUE). */
export const tartanCue = (config: TartanConfig): string => {
	const extensions: Record<string, unknown> = {};
	if (config.pipeline !== undefined) {
		extensions["tartan.ci"] = { settings: { pipeline: config.pipeline } };
	}
	if (config.owners !== undefined) {
		extensions["tartan.review"] = { settings: { owners: config.owners } };
	}
	const value = {
		...(config.projects === undefined ? {} : { projects: config.projects }),
		...(config.global === undefined ? {} : { global: config.global }),
		...(Object.keys(extensions).length === 0 ? {} : { extensions }),
	};
	return `package tartan\n\n${JSON.stringify(value, null, "\t")}\n`;
};

/** The exported config a fixture's `tartan.cue` stands for, or null without one. */
export const configOf = (
	files: FileMap,
): Record<string, unknown> | null => {
	const spec = files[TARTAN_FILE];
	if (spec === undefined) return null;
	const text = typeof spec === "string" ? spec : new TextDecoder().decode(
		spec instanceof Uint8Array
			? spec
			: typeof spec.content === "string"
			? new TextEncoder().encode(spec.content)
			: spec.content,
	);
	return JSON.parse(text.replace(/^package tartan\s*/, "")) as Record<
		string,
		unknown
	>;
};

const record = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? v as Record<string, unknown>
		: {};

const typeOf = (mode: string): TreeEntryType =>
	mode === MODE.tree
		? "tree"
		: mode === MODE.exec
		? "exec"
		: mode === MODE.symlink
		? "symlink"
		: mode === MODE.gitlink
		? "gitlink"
		: "blob";

export const createMemRepo = () => {
	const store = createObjectStore();
	const objects: GitObjects = {
		readTree: (hash) => {
			const o = store.get(hash);
			if (o?.type !== "tree") return Promise.resolve(null);
			return Promise.resolve(
				parseTree(o.data).map((e): RawTreeEntry => ({
					name: e.name,
					mode: e.mode,
					hash: e.oid,
					type: typeOf(e.mode),
				})),
			);
		},
		readBlob: (hash) => {
			const o = store.get(hash);
			return Promise.resolve(o?.type === "blob" ? o.data : null);
		},
	};
	const tree = (files: FileMap): string => writeTree(store, files);

	/**
	 * WP8's project graph of a snapshot (as `caps.repo.projectGraph` returns
	 * it), with the configured projects of its `tartan.cue`.
	 */
	const graph = async (files: FileMap): Promise<ProjectGraph> => {
		const root = tree(files);
		const config = configOf(files);
		const g = await detectProjects(
			createTreeView(objects, root),
			config === null ? { key: "none", projects: null, global: [] } : {
				key: `fixture:${JSON.stringify(config).length}`,
				projects: config.projects === undefined
					? null
					: record(config.projects),
				global: Array.isArray(config.global)
					? config.global.filter((g): g is string => typeof g === "string")
					: [],
			},
		);
		return {
			sha: root,
			manifestsTreeSha: g.manifestsTreeSha,
			projects: g.projects,
			globalFiles: g.globalFiles,
		};
	};

	/** Paths changed between two snapshots (renames as old and new path). */
	const changed = async (before: FileMap, after: FileMap): Promise<string[]> =>
		touchedPaths(
			(await diffTrees(
				{ objects, tree: tree(before) },
				{ objects, tree: tree(after) },
			)).changes,
		);

	/** WP8's affected set (graph at `graphFiles`, paths from before → after). */
	const wp8Affected = async (
		graphFiles: FileMap,
		before: FileMap,
		after: FileMap,
	): Promise<Affected> =>
		affectedBy(await graph(graphFiles), await changed(before, after));

	/** `caps.repo.treeHash` over a snapshot. */
	const treeHasher = (files: FileMap) => {
		const view = createTreeView(objects, tree(files));
		return async (path: string): Promise<string | null> =>
			(await view.entry(path))?.hash ?? null;
	};

	/** `caps.repo.readTree` over a snapshot: the entries of the tree at `path`. */
	const treeLister = (files: FileMap) => {
		const root = tree(files);
		const view = createTreeView(objects, root);
		return async (path: string) => {
			const hash = path === "" ? root : (await view.entry(path))?.hash;
			const entries = hash === undefined ? null : await objects.readTree(hash);
			return (entries ?? []).map((e) => ({
				path: path === "" ? e.name : `${path}/${e.name}`,
				hash: e.hash,
				type: e.type,
			}));
		};
	};

	return {
		store,
		objects,
		tree,
		graph,
		changed,
		wp8Affected,
		treeHasher,
		treeLister,
	};
};
export type MemRepo = ReturnType<typeof createMemRepo>;

const pkg = (
	name: string,
	deps: Record<string, string> = {},
	test: string | null = "vitest run",
) =>
	JSON.stringify({
		name,
		dependencies: deps,
		...(test ? { scripts: { test } } : {}),
	});

/** The demo monorepo: pnpm, three projects. */
export const PNPM_REPO: FileMap = {
	"package.json": JSON.stringify({ name: "router", private: true }),
	"pnpm-workspace.yaml":
		"packages:\n  - packages/*\n  - services/*\n  - apps/*\n",
	"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
	"packages/shared/package.json": pkg("shared"),
	"packages/shared/src/index.ts": "export const x = 1;\n",
	"services/api/package.json": pkg("api", { shared: "workspace:*" }),
	"services/api/src/middleware/limit.ts": "export const limit = 100;\n",
	"services/api/test/limit.test.ts": "test('limit', () => {});\n",
	"apps/web/package.json": pkg("web", { shared: "workspace:^" }),
	"apps/web/src/main.ts": "import 'shared';\n",
};

export const CARGO_REPO: FileMap = {
	"Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
	"Cargo.lock": "# lock\n",
	"crates/core/Cargo.toml": '[package]\nname = "core"\n',
	"crates/core/src/lib.rs": "pub fn a() {}\n",
	"crates/cli/Cargo.toml":
		'[package]\nname = "cli"\n\n[dependencies]\ncore = { path = "../core" }\n',
	"crates/cli/src/main.rs": "fn main() {}\n",
};

export const GO_REPO: FileMap = {
	"go.work": "go 1.22\n\nuse (\n\t./svc/auth\n\t./svc/billing\n)\n",
	"svc/auth/go.mod": "module example.com/auth\n\ngo 1.22\n",
	"svc/auth/main.go": "package main\n",
	"svc/billing/go.mod": "module example.com/billing\n\ngo 1.22\n",
	"svc/billing/main.go": "package main\n",
};

export const DENO_REPO: FileMap = {
	"deno.json": JSON.stringify({ workspace: ["./libs/a", "./libs/b"] }),
	"libs/a/deno.json": JSON.stringify({ name: "@x/a", exports: "./mod.ts" }),
	"libs/a/mod.ts": "export const a = 1;\n",
	"libs/b/deno.json": JSON.stringify({
		name: "@x/b",
		exports: "./mod.ts",
		imports: { "@x/a": "jsr:@x/a@^1" },
	}),
	"libs/b/mod.ts": "export const b = 2;\n",
};

/** The demo pipeline (`tartan.ci`'s repo policy). */
export const DEMO_PIPELINE = {
	timeout: "15m",
	jobs: {
		install: { run: "pnpm install --frozen-lockfile" },
		lint: {
			needs: ["install"],
			each: "affected",
			cwd: "{{project.root}}",
			run: "pnpm lint",
			optional: true,
		},
		test: {
			needs: ["install"],
			each: "affected",
			cwd: "{{project.root}}",
			run: "pnpm test",
		},
	},
	on: {
		change: ["install", "lint", "test"],
		land: ["install", "test"],
		push: { branches: ["release/*"], jobs: ["install", "test"] },
	},
	lanes: { ci: "on-submit" },
};

/** The demo's configured projects and global files (kernel fields of package tartan). */
export const DEMO_PROJECTS = {
	shared: { root: "packages/shared" },
	api: {
		root: "services/api",
		deps: ["shared"],
		sensitive: true,
		owners: ["@platform"],
	},
	web: { root: "apps/web", deps: ["shared"] },
};
export const DEMO_GLOBAL = [
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
];

/** The demo's `tartan.cue`: the pipeline, the projects and the global files. */
export const DEMO_TARTAN = tartanCue({
	pipeline: DEMO_PIPELINE,
	projects: DEMO_PROJECTS,
	global: DEMO_GLOBAL,
});

/**
 * A repo world for extension flow tests: snapshots by "commit" sha (the
 * root tree id stands in for the commit), and `caps.repo.*` handlers over
 * them backed by WP8's detection, tree diff and line diff.
 */
export const createWorld = () => {
	const repo = createMemRepo();
	const snaps = new Map<string, FileMap>();
	const enc = new TextEncoder();
	const commit = (files: FileMap): string => {
		const sha = repo.tree(files);
		snaps.set(sha, files);
		return sha;
	};
	const filesAt = (sha: string): FileMap => {
		const f = snaps.get(sha);
		if (f === undefined) throw new Error(`world: unknown commit ${sha}`);
		return f;
	};
	const textOf = (spec: FileMap[string] | undefined): string | null =>
		spec === undefined
			? null
			: typeof spec === "string"
			? spec
			: spec instanceof Uint8Array
			? new TextDecoder().decode(spec)
			: typeof spec.content === "string"
			? spec.content
			: new TextDecoder().decode(spec.content);
	const changes = async (base: string, head: string) =>
		(await diffTrees(
			{ objects: repo.objects, tree: base },
			{ objects: repo.objects, tree: head },
		)).changes;
	const handlers = {
		"repo.readFile": (_r: unknown, sha: string, path: string, max?: number) => {
			const text = textOf(filesAt(sha)[path]);
			if (text === null) return null;
			const bytes = enc.encode(text);
			return max === undefined ? bytes : bytes.slice(0, max);
		},
		"repo.projectGraph": async (_r: unknown, sha: string) => ({
			...(await repo.graph(filesAt(sha))),
			sha,
		}),
		"repo.diffPaths": async (_s: unknown, base: string, head: string) => ({
			paths: (await changes(base, head)).map((c) => ({
				path: c.path,
				change: c.change,
				...(c.oldPath ? { oldPath: c.oldPath } : {}),
			})),
			truncated: false,
		}),
		"repo.diff": async (
			a: { sha: string },
			b: { sha: string },
		) =>
			(await changes(a.sha, b.sha)).map((c) => {
				const before = textOf(filesAt(a.sha)[c.oldPath ?? c.path]) ?? "";
				const after = textOf(filesAt(b.sha)[c.path]) ?? "";
				const stat = diffStat(
					diffTexts(
						c.change === "added" ? "" : before,
						c.change === "deleted" ? "" : after,
					),
				);
				return {
					path: c.path,
					...(c.oldPath ? { oldPath: c.oldPath } : {}),
					change: c.change,
					binary: false,
					additions: stat.additions,
					deletions: stat.deletions,
					hunks: [],
				};
			}),
		"repo.treeHash": (_r: unknown, sha: string, path: string) =>
			repo.treeHasher(filesAt(sha))(path),
		"repo.readTree": (_r: unknown, sha: string, path: string) =>
			repo.treeLister(filesAt(sha))(path),
	};
	/**
	 * Repo-policy answers a test forces at a commit (`pending`, or a not-exact
	 * last good), instead of reading its `tartan.cue`.
	 */
	const policyOverrides = new Map<string, RepoPolicyAnswer>();

	/**
	 * `caps.repo.policy` for one extension (the kernel returns only its own
	 * `repoPolicy` keys): the commit's `tartan.cue` read as its trunk config.
	 */
	/** Answers forced for one extension's reads only (by commit). */
	const policyOverridesFor = new Map<string, Map<string, RepoPolicyAnswer>>();
	const policyHandler = (extId: string, keys: readonly string[]) =>
	(
		_r: unknown,
		at: string,
	): RepoPolicyAnswer => {
		const forced = policyOverridesFor.get(extId)?.get(at) ??
			policyOverrides.get(at);
		if (forced !== undefined) return forced;
		const config = configOf(filesAt(at));
		if (config === null) return { state: "none" };
		const settings = record(record(record(config.extensions)[extId]).settings);
		return {
			state: "ok",
			configSha: at,
			inputKey: "f".repeat(64),
			exact: true,
			values: Object.fromEntries(
				keys.filter((k) => Object.hasOwn(settings, k)).map((k) => [
					k,
					settings[k],
				]),
			),
		};
	};
	return {
		repo,
		commit,
		filesAt,
		handlers,
		policyHandler,
		policyOverrides,
		policyOverridesFor,
	};
};
export type World = ReturnType<typeof createWorld>;

export const withFiles = (base: FileMap, changes: FileMap): FileMap => ({
	...base,
	...changes,
});

export const without = (base: FileMap, ...paths: string[]): FileMap =>
	Object.fromEntries(
		Object.entries(base).filter(([p]) => !paths.includes(p)),
	);
