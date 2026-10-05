// Project detection at one commit (ADR repo config): the configured `projects`
// of the repository's package `tartan` (top-level, read by the caller from the
// trunk config in force at the commit's trunk base, never parsed here) when
// there are any, else every workspace detector that finds a workspace at the
// repo root (pnpm or npm, deno, Cargo, go.work), first root and first name
// winning. Each project carries its manifest path (a change to it is global for
// K6). Global files are the config's `global` list plus each present detector's
// defaults (lockfiles and workspace manifests) plus every root `*.cue` file
// (Tartan config and any other root CUE package: policy paths, K13); a config
// entry `!<glob>` removes a default.
//
// With `cuenv` on (`TARTAN_PROJECTS=scan`, WP25) the cuenv detector runs
// first: when the tree is a cuenv module with at least one `#Project`, those
// projects are the graph (`./cuenv/`), and the workspace detectors only add
// edges between them (edge mode). Without `cuenv` the graph is exactly the
// chain above.
//
// `manifestsTreeSha` is a SHA-256 over every fact detection consulted
// (each file read with its blob hash or absence, each directory listed with
// its entry names, and the config's key), so two commits with the same key
// have the same graph.

import type { Project, ProjectSource } from "@tartan/contract";
import {
	basename,
	globBase,
	globMatcher,
	isLiteralGlob,
	joinPath,
	normaliseGlob,
} from "./glob.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";
import type { RawTreeEntry, TreeView } from "./objects.ts";
import {
	isObject,
	type JsonObject,
	parseJsonc,
	stringItems,
} from "./parse/jsonc.ts";
import { parseGoMod, parseGoWork } from "./parse/gomod.ts";
import { parseToml, type TomlTable, type TomlValue } from "./parse/toml.ts";
import { parseYaml, type YamlValue } from "./parse/yaml.ts";
import { liftEdges, type MemberDraft } from "./cuenv/compose.ts";
import { type CuenvDetection, detectCuenv } from "./cuenv/detect.ts";
import type { GraphExtras, ProjectExtras } from "./cuenv/types.ts";

/** Deepest directory level a `**` workspace pattern is expanded to. */
export const MEMBER_GLOB_MAX_DEPTH = 6;
/** Projects per graph (bounds reads and the RepoDO cache). */
export const MAX_PROJECTS = 500;

export type GlobalFile = {
	readonly glob: string;
	readonly source: "config" | "detector-default";
};

export type DetectedGraph = {
	readonly projects: readonly Project[];
	readonly globalFiles: readonly GlobalFile[];
	readonly manifestsTreeSha: string;
	/** Graph-level fields of a `cuenv` detection (absent without the option). */
	readonly extras?: GraphExtras;
};

export type DetectOptions = {
	/** The cuenv detector first, workspaces in edge mode (`TARTAN_PROJECTS=scan`). */
	readonly cuenv?: boolean;
};

/** Detector defaults, keyed by the root marker that enables them. */
const DEFAULT_GLOBALS: readonly (readonly [string, readonly string[]])[] = [
	["pnpm-workspace.yaml", [
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"package.json",
	]],
	["package.json", ["package-lock.json", "package.json"]],
	["deno.json", ["deno.json", "deno.lock"]],
	["deno.jsonc", ["deno.jsonc", "deno.lock"]],
	["Cargo.toml", ["Cargo.lock", "Cargo.toml"]],
	["go.work", ["go.work", "go.work.sum"]],
];
/** Root `*.cue` files: the policy paths of K13 (ADR repo config). */
export const ALWAYS_GLOBAL = "*.cue";

/**
 * The configured projects and global files of package `tartan` at the
 * commit's trunk base (`ProjectConfigAnswer` of the kernel): repository
 * controlled, so every field is checked again here.
 */
export type ProjectConfig = {
	/** Part of `manifestsTreeSha` (`none`, `off`, an input key, `provisional:…`). */
	readonly key: string;
	readonly projects: Readonly<Record<string, unknown>> | null;
	readonly global: readonly string[];
};

export const NO_PROJECT_CONFIG: ProjectConfig = {
	key: "none",
	projects: null,
	global: [],
};
/** A cuenv graph's own globals besides the root `*.cue` files (WP25). */
const CUENV_GLOBALS = ["cue.mod/**"];

type Draft = {
	name: string;
	root: string;
	deps: string[];
	owners: string[];
	sensitive: boolean;
	testCmd?: string;
	source: ProjectSource;
	manifestPath?: string;
	/** The optional cuenv project fields (cuenv drafts only). */
	extra?: ProjectExtras;
};

/** A tree view that records what detection read, for `manifestsTreeSha`. */
const recording = (view: TreeView) => {
	const facts = new Map<string, string>();
	const text = async (path: string) => {
		const entry = await view.entry(path);
		facts.set(`file:${path}`, entry ? `${entry.type}:${entry.hash}` : "absent");
		return entry ? await view.text(path) : null;
	};
	const has = async (dirPath: string, name: string) => {
		const found = ((await view.dir(dirPath)) ?? []).some((e: RawTreeEntry) =>
			e.name === name && e.type !== "tree"
		);
		facts.set(`has:${at(dirPath, name)}`, found ? "1" : "0");
		return found;
	};
	const subdirs = async (base: string, depth: number) => {
		const dirs = await view.subdirs(base, depth);
		facts.set(`subdirs:${base}:${depth}`, dirs.join("\n"));
		return dirs;
	};
	const key = () =>
		sha256Hex(
			canonicalJson([...facts.entries()].sort(([a], [b]) => a < b ? -1 : 1)),
		);
	const fact = (k: string, v: string) => facts.set(k, v);
	return { text, has, key, subdirs, fact };
};
type Recorder = ReturnType<typeof recording>;

const at = (root: string, name: string): string =>
	root === "" ? name : `${root}/${name}`;

/** Expands workspace member patterns to directories holding `manifest`. */
const expandMembers = async (
	rec: Recorder,
	patterns: readonly string[],
	manifests: readonly string[],
): Promise<string[]> => {
	const negative = patterns.filter((p) => p.startsWith("!")).map((p) =>
		globMatcher(p.slice(1))
	);
	const found: string[] = [];
	for (const raw of patterns.filter((p) => !p.startsWith("!"))) {
		const pattern = normaliseGlob(raw);
		const candidates = isLiteralGlob(pattern)
			? [joinPath(pattern) ?? ""]
			: await (async () => {
				const base = globBase(pattern);
				const depth = pattern.includes("**")
					? MEMBER_GLOB_MAX_DEPTH
					: pattern.split("/").length -
						(base === "" ? 0 : base.split("/").length);
				const match = globMatcher(pattern);
				return (await rec.subdirs(base, depth)).filter(match);
			})();
		for (const dir of candidates) {
			if (found.includes(dir) || negative.some((m) => m(dir))) continue;
			for (const manifest of manifests) {
				if (await rec.has(dir, manifest)) {
					found.push(dir);
					break;
				}
			}
		}
	}
	return found.sort();
};

const readJson = async (
	rec: Recorder,
	path: string,
): Promise<JsonObject | null> => {
	const text = await rec.text(path);
	const value = text === null ? undefined : parseJsonc(text);
	return isObject(value) ? value : null;
};

const readToml = async (
	rec: Recorder,
	path: string,
): Promise<TomlTable | null> => {
	const text = await rec.text(path);
	if (text === null) return null;
	try {
		return parseToml(text);
	} catch {
		return null;
	}
};

const asTable = (v: TomlValue | undefined): TomlTable | null =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
const tomlStrings = (v: TomlValue | undefined): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

const NPM_DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const LOCAL_SPEC = /^(workspace|link|file):/;

const detectNode = async (rec: Recorder): Promise<Draft[]> => {
	const pnpmText = await rec.text("pnpm-workspace.yaml");
	let patterns: string[] = [];
	let source: ProjectSource;
	if (pnpmText !== null) {
		source = "pnpm-workspace";
		try {
			const doc = parseYaml(pnpmText) as { packages?: YamlValue } | null;
			patterns = Array.isArray(doc?.packages)
				? doc.packages.filter((p): p is string => typeof p === "string")
				: [];
		} catch {
			patterns = [];
		}
	} else {
		source = "npm-workspaces";
		const root = await readJson(rec, "package.json");
		const ws = root?.workspaces;
		patterns = Array.isArray(ws)
			? stringItems(ws)
			: isObject(ws)
			? stringItems(ws.packages)
			: [];
	}
	if (patterns.length === 0) return [];
	const dirs = (await expandMembers(rec, patterns, ["package.json"])).filter((
		d,
	) => d !== "");
	const members = await Promise.all(dirs.map(async (root) => ({
		root,
		pkg: (await readJson(rec, at(root, "package.json"))) ?? {},
	})));
	const names = new Set(
		members.map((m) =>
			typeof m.pkg.name === "string" ? m.pkg.name : basename(m.root)
		),
	);
	const tool = source === "pnpm-workspace" ? "pnpm" : "npm";
	return members.map(({ root, pkg }) => {
		const name = typeof pkg.name === "string" ? pkg.name : basename(root);
		const deps = new Set<string>();
		for (const field of NPM_DEP_FIELDS) {
			const table = pkg[field];
			if (!isObject(table)) continue;
			for (const [dep, spec] of Object.entries(table)) {
				const local = typeof spec === "string" && LOCAL_SPEC.test(spec);
				if (dep !== name && names.has(dep) && (tool === "npm" || local)) {
					deps.add(dep);
				}
			}
		}
		const scripts = pkg.scripts;
		return {
			name,
			root,
			deps: [...deps],
			owners: [],
			sensitive: false,
			source,
			manifestPath: at(root, "package.json"),
			...(isObject(scripts) && typeof scripts.test === "string"
				? { testCmd: `${tool} test` }
				: {}),
		};
	});
};

const detectDeno = async (rec: Recorder): Promise<Draft[]> => {
	let rootConfig = await readJson(rec, "deno.json");
	if (rootConfig === null) rootConfig = await readJson(rec, "deno.jsonc");
	const ws = rootConfig?.workspace;
	const patterns = Array.isArray(ws)
		? stringItems(ws)
		: isObject(ws)
		? stringItems(ws.members)
		: [];
	if (patterns.length === 0) return [];
	const dirs = (await expandMembers(rec, patterns, ["deno.json", "deno.jsonc"]))
		.filter((d) => d !== "");
	const members = await Promise.all(dirs.map(async (root) => {
		const jsonPath = (await rec.has(root, "deno.json"))
			? at(root, "deno.json")
			: at(root, "deno.jsonc");
		return { root, jsonPath, config: (await readJson(rec, jsonPath)) ?? {} };
	}));
	const named = members.map((m) => ({
		...m,
		name: typeof m.config.name === "string" ? m.config.name : basename(m.root),
	}));
	return named.map(({ root, jsonPath, config, name }) => {
		const imports = isObject(config.imports) ? config.imports : {};
		const deps = named.filter((other) => {
			if (other.name === name) return false;
			return Object.entries(imports).some(([key, value]) => {
				if (key === other.name) return true;
				if (typeof value !== "string") return false;
				if (
					value.startsWith(`jsr:${other.name}`) ||
					value.startsWith(`npm:${other.name}`)
				) return true;
				const target = /^\.\.?\//.test(value) ? joinPath(root, value) : null;
				return target !== null &&
					(target === other.root || target.startsWith(`${other.root}/`));
			});
		}).map((other) => other.name);
		return {
			name,
			root,
			deps,
			owners: [],
			sensitive: false,
			source: "deno-workspace" as const,
			manifestPath: jsonPath,
			testCmd: "deno test",
		};
	});
};

const CARGO_DEP_TABLES = [
	"dependencies",
	"dev-dependencies",
	"build-dependencies",
];

const cargoDepTables = (manifest: TomlTable): TomlTable[] => {
	const tables = CARGO_DEP_TABLES.map((t) => asTable(manifest[t])).filter(
		(t): t is TomlTable => t !== null,
	);
	const target = asTable(manifest.target);
	for (const cfg of Object.values(target ?? {})) {
		const table = asTable(cfg);
		if (table) {
			tables.push(
				...CARGO_DEP_TABLES.map((t) => asTable(table[t])).filter(
					(t): t is TomlTable => t !== null,
				),
			);
		}
	}
	return tables;
};

const detectCargo = async (rec: Recorder): Promise<Draft[]> => {
	const root = await readToml(rec, "Cargo.toml");
	const workspace = asTable(root?.workspace);
	if (!root || !workspace) return [];
	const exclude = tomlStrings(workspace.exclude).map((p) => globMatcher(p));
	const dirs =
		(await expandMembers(rec, tomlStrings(workspace.members), ["Cargo.toml"]))
			.filter((d) => !exclude.some((m) => m(d)));
	if (asTable(root.package) && !dirs.includes("")) dirs.unshift("");
	const members = (await Promise.all(dirs.map(async (dir) => ({
		root: dir,
		manifest: dir === "" ? root : await readToml(rec, at(dir, "Cargo.toml")),
	})))).flatMap((m) => {
		const name = asTable(m.manifest?.package)?.name;
		return m.manifest && typeof name === "string"
			? [{ root: m.root, manifest: m.manifest, name }]
			: [];
	});
	const wsDeps = asTable(workspace.dependencies) ?? {};
	const byRoot = new Map(members.map((m) => [m.root, m.name]));
	return members.map(({ root: dir, manifest, name }) => {
		const deps = new Set<string>();
		for (const table of cargoDepTables(manifest)) {
			for (const [key, spec] of Object.entries(table)) {
				const detail = asTable(spec);
				if (!detail) continue;
				let path: string | null = null;
				if (typeof detail.path === "string") path = joinPath(dir, detail.path);
				else if (detail.workspace === true) {
					const shared = asTable(wsDeps[key]);
					if (shared && typeof shared.path === "string") {
						path = joinPath(shared.path);
					}
				}
				const target = path === null ? undefined : byRoot.get(path);
				if (target && target !== name) deps.add(target);
			}
		}
		return {
			name,
			root: dir,
			deps: [...deps],
			owners: [],
			sensitive: false,
			source: "cargo" as const,
			manifestPath: at(dir, "Cargo.toml"),
			testCmd: `cargo test -p ${name}`,
		};
	});
};

const detectGoWork = async (rec: Recorder): Promise<Draft[]> => {
	const text = await rec.text("go.work");
	if (text === null) return [];
	const dirs = [
		...new Set(
			parseGoWork(text).use.flatMap((u) => {
				const d = joinPath(u);
				return d === null ? [] : [d];
			}),
		),
	].sort();
	const members = (await Promise.all(dirs.map(async (dir) => {
		const mod = await rec.text(at(dir, "go.mod"));
		return mod === null ? null : { root: dir, mod: parseGoMod(mod) };
	}))).filter((m) => m !== null);
	const byModule = new Map(
		members.flatMap((m) => m.mod.module ? [[m.mod.module, m] as const] : []),
	);
	const nameOf = (m: (typeof members)[number]) =>
		m.mod.module ?? basename(m.root);
	return members.map((m) => {
		const deps = new Set<string>();
		for (const req of m.mod.require) {
			const target = byModule.get(req);
			if (target && target !== m) deps.add(nameOf(target));
		}
		for (const { path } of m.mod.replaceLocal) {
			const dir = joinPath(m.root, path);
			const target = members.find((o) => o.root === dir);
			if (target && target !== m) deps.add(nameOf(target));
		}
		return {
			name: nameOf(m),
			root: m.root,
			deps: [...deps],
			owners: [],
			sensitive: false,
			source: "go.work" as const,
			manifestPath: at(m.root, "go.mod"),
			testCmd: "go test ./...",
		};
	});
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type PipelineConfig = {
	readonly projects: Draft[] | null;
	readonly global: readonly string[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The configured projects (ADR repo config): `{<name>: {root, deps?, sensitive?, owners?, test?}}`. */
const configured = (config: ProjectConfig): PipelineConfig => {
	const raw = config.projects;
	const projects = raw === null ? [] : Object.entries(raw).flatMap(
		([name, spec]): Draft[] => {
			if (!isRecord(spec)) return [];
			const root = typeof spec.root === "string" ? joinPath(spec.root) : null;
			if (root === null) return [];
			return [{
				name,
				root,
				deps: strings(spec.deps),
				owners: strings(spec.owners),
				sensitive: spec.sensitive === true,
				source: "tartan-config",
				...(typeof spec.test === "string" ? { testCmd: spec.test } : {}),
			}];
		},
	);
	return {
		projects: projects.length > 0 ? projects : null,
		global: strings(config.global),
	};
};

const MANIFEST_CANDIDATES = [
	"package.json",
	"Cargo.toml",
	"go.mod",
	"deno.json",
	"deno.jsonc",
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Detects the project graph of the tree behind `view`, with the configured
 * projects and global files `projectConfig` names (from the trunk config at
 * the commit's trunk base; default: none).
 */
export const detectProjects = async (
	view: TreeView,
	projectConfig: ProjectConfig = NO_PROJECT_CONFIG,
	options: DetectOptions = {},
): Promise<DetectedGraph> => {
	const rec = recording(view);
	rec.fact("config", projectConfig.key);
	const config = configured(projectConfig);
	let drafts: Draft[];
	let cuenv: CuenvDetection | null = null;
	let liftWarnings: GraphExtras["warnings"] = [];
	if (config.projects) {
		drafts = await Promise.all(config.projects.map(async (p) => {
			for (const candidate of MANIFEST_CANDIDATES) {
				if (await rec.has(p.root, candidate)) {
					return { ...p, manifestPath: at(p.root, candidate) };
				}
			}
			return p;
		}));
	} else {
		// The cuenv walk runs beside the workspace detectors: both read through
		// the same memoised view, so neither waits for listings the other has.
		const scanning = options.cuenv
			? detectCuenv({
				dir: (path) => view.dir(path),
				text: (path) => view.text(path),
				fact: rec.fact,
			})
			: Promise.resolve(null);
		scanning.catch(() => {}); // awaited below; the detectors may throw first
		drafts = [];
		const members: MemberDraft[] = [];
		for (
			const detector of [detectNode, detectDeno, detectCargo, detectGoWork]
		) {
			for (const draft of await detector(rec)) {
				members.push(draft);
				const clash = drafts.some((d) =>
					d.root === draft.root || d.name === draft.name
				);
				if (!clash) drafts.push(draft);
			}
		}
		const found = await scanning;
		if (found !== null && found.projects.length > 0) {
			cuenv = found;
			const lifted = liftEdges(found.projects, members);
			liftWarnings = lifted.warnings;
			drafts = found.projects.map((p) => ({
				name: p.name,
				root: p.root,
				deps: [...(lifted.deps.get(p.name) ?? [])],
				owners: [],
				sensitive: false,
				source: "cuenv",
				manifestPath: p.manifestPath,
				extra: {
					key: p.root,
					slug: p.slug,
					...(p.cuenvName !== undefined ? { cuenvName: p.cuenvName } : {}),
					nameSource: p.nameSource,
					layers: p.layers,
					fidelity: "scan",
					...(p.issues.length > 0 ? { issues: p.issues } : {}),
				},
			}));
		}
	}
	drafts = drafts.slice(0, MAX_PROJECTS);
	const names = new Set(drafts.map((d) => d.name));
	const projects: Project[] = drafts
		.map((d) => ({
			...d,
			deps: [...new Set(d.deps.filter((n) => names.has(n) && n !== d.name))]
				.sort(),
		}))
		.map((d, _i, all) => ({
			name: d.name,
			root: d.root,
			deps: d.deps,
			dependents: all.filter((o) => o.deps.includes(d.name)).map((o) => o.name)
				.sort(),
			owners: d.owners,
			sensitive: d.sensitive,
			...(d.testCmd !== undefined ? { testCmd: d.testCmd } : {}),
			source: d.source,
			...(d.manifestPath !== undefined ? { manifestPath: d.manifestPath } : {}),
			...d.extra,
		}))
		.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

	const removed = new Set(
		config.global.filter((g) => g.startsWith("!")).map((g) =>
			normaliseGlob(g.slice(1))
		),
	);
	const globals = new Map<string, GlobalFile["source"]>();
	for (const glob of config.global.filter((g) => !g.startsWith("!"))) {
		globals.set(normaliseGlob(glob), "config");
	}
	for (const [marker, defaults] of DEFAULT_GLOBALS) {
		if (!(await rec.has("", marker))) continue;
		for (const glob of defaults) {
			if (!removed.has(glob) && !globals.has(glob)) {
				globals.set(glob, "detector-default");
			}
		}
	}
	if (!globals.has(ALWAYS_GLOBAL)) {
		globals.set(ALWAYS_GLOBAL, "detector-default");
	}
	if (cuenv !== null) {
		const bun = await rec.has("", "bun.lock") ? ["bun.lock"] : [];
		for (const glob of [...CUENV_GLOBALS, ...bun]) {
			if (!removed.has(glob) && !globals.has(glob)) {
				globals.set(glob, "detector-default");
			}
		}
		// A truncated walk may have missed projects: every path is global.
		if (cuenv.truncated) globals.set("**", "detector-default");
	}
	const globalFiles = [...globals.entries()]
		.map(([glob, source]) => ({ glob, source }))
		.sort((a, b) => a.glob < b.glob ? -1 : 1);
	const extras = options.cuenv
		? graphExtras(cuenv, config.projects !== null, liftWarnings ?? [])
		: undefined;
	return {
		projects,
		globalFiles,
		manifestsTreeSha: await rec.key(),
		...(extras ? { extras } : {}),
	};
};

/** The graph-level fields a `cuenv` detection reports (every detector named). */
const graphExtras = (
	cuenv: CuenvDetection | null,
	configured: boolean,
	liftWarnings: NonNullable<GraphExtras["warnings"]>,
): GraphExtras => {
	if (cuenv === null) {
		return {
			detector: configured ? "config" : "workspaces",
			fidelity: "exact",
		};
	}
	const warnings = [...cuenv.warnings, ...liftWarnings];
	return {
		detector: "cuenv",
		fidelity: "scan",
		layers: cuenv.layers,
		skipped: cuenv.skipped,
		warnings,
		...(cuenv.truncated ? { truncated: true } : {}),
		packages: cuenv.packages,
		...(cuenv.rootProject ? { rootProject: cuenv.rootProject } : {}),
	};
};
