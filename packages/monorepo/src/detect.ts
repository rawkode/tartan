// Project detection at one commit: a project is any non-root directory holding
// a `.cue` file in `package tartan` (`./tartan/`); there is no central list and
// no fallback, so a tree without such a directory has no projects. Each project
// carries its manifest path (a change to it is global for K6). Global files are
// the config's `global` list plus the defaults of what the tree holds (lockfiles
// and workspace manifests) plus every root `*.cue` file (Tartan config and any
// other root CUE package: policy paths, K13); a config entry `!<glob>` removes a
// default.
//
// `manifestsTreeSha` is a SHA-256 over every fact detection consulted (each
// file with its blob hash, each presence check, and the config's key), so two
// commits with the same key have the same graph.

import type { Project } from "@tartan/contract";
import { normaliseGlob } from "./glob.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";
import type { RawTreeEntry, TreeView } from "./objects.ts";
import { detectTartan } from "./tartan/detect.ts";
import type { GraphExtras } from "./tartan/types.ts";

/** Projects per graph (bounds reads and the RepoDO cache). */
export const MAX_PROJECTS = 500;

export type GlobalFile = {
	readonly glob: string;
	readonly source: "config" | "detector-default";
};

export type DetectedGraph = GraphExtras & {
	readonly projects: readonly Project[];
	readonly globalFiles: readonly GlobalFile[];
	readonly manifestsTreeSha: string;
};

/** Defaults, keyed by the root marker that enables them. */
const DEFAULT_GLOBALS: readonly (readonly [string, readonly string[]])[] = [
	["pnpm-workspace.yaml", [
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"package.json",
	]],
	["package.json", ["package-lock.json", "package.json"]],
	["bun.lock", ["bun.lock"]],
	["deno.json", ["deno.json", "deno.lock"]],
	["deno.jsonc", ["deno.jsonc", "deno.lock"]],
	["Cargo.toml", ["Cargo.lock", "Cargo.toml"]],
	["go.work", ["go.work", "go.work.sum"]],
];
/** Root `*.cue` files: the policy paths of K13 (ADR repo config). */
export const ALWAYS_GLOBAL = "*.cue";
/** The root CUE module, when the tree has one. */
const MODULE_GLOB = "cue.mod/**";

/**
 * The global files of package `tartan` at the commit's trunk base
 * (`ProjectConfigAnswer` of the kernel): repository controlled, so every field
 * is checked again here. A `projects` key there is ignored: projects are only
 * ever discovered from the tree.
 */
export type ProjectConfig = {
	/** Part of `manifestsTreeSha` (`none`, `off`, an input key, `provisional:…`). */
	readonly key: string;
	readonly global: readonly string[];
};

export const NO_PROJECT_CONFIG: ProjectConfig = { key: "none", global: [] };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Detects the project graph of the tree behind `view`, with the global files
 * `projectConfig` names (from the trunk config at the commit's trunk base;
 * default: none).
 */
export const detectProjects = async (
	view: TreeView,
	projectConfig: ProjectConfig = NO_PROJECT_CONFIG,
): Promise<DetectedGraph> => {
	const facts = new Map<string, string>();
	const fact = (k: string, v: string) => facts.set(k, v);
	const has = async (name: string) => {
		const found = ((await view.dir("")) ?? []).some((e: RawTreeEntry) =>
			e.name === name && e.type !== "tree"
		);
		fact(`has:${name}`, found ? "1" : "0");
		return found;
	};
	fact("config", projectConfig.key);
	const configGlobal = strings(projectConfig.global);
	const found = await detectTartan({
		dir: (path) => view.dir(path),
		text: (path) => view.text(path),
		fact,
	});
	const drafts = found.projects.slice(0, MAX_PROJECTS);
	const names = new Set(drafts.map((d) => d.name));
	const withDeps = drafts.map((d) => ({
		...d,
		deps: d.deps.filter((n) => names.has(n) && n !== d.name),
	}));
	const projects: Project[] = withDeps
		.map((d) => ({
			name: d.name,
			root: d.root,
			deps: d.deps,
			dependents: withDeps.filter((o) => o.deps.includes(d.name)).map((o) =>
				o.name
			).sort(),
			owners: [],
			sensitive: false,
			source: "tartan" as const,
			manifestPath: d.manifestPath,
			key: d.root,
			slug: d.slug,
			...(d.declaredName !== undefined ? { declaredName: d.declaredName } : {}),
			nameSource: d.nameSource,
			fidelity: "scan" as const,
			extensions: d.extensions,
			...(d.issues.length > 0 ? { issues: d.issues } : {}),
		}))
		.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

	const removed = new Set(
		configGlobal.filter((g) => g.startsWith("!")).map((g) =>
			normaliseGlob(g.slice(1))
		),
	);
	const globals = new Map<string, GlobalFile["source"]>();
	for (const glob of configGlobal.filter((g) => !g.startsWith("!"))) {
		globals.set(normaliseGlob(glob), "config");
	}
	const addDefault = (glob: string) => {
		if (!removed.has(glob) && !globals.has(glob)) {
			globals.set(glob, "detector-default");
		}
	};
	for (const [marker, defaults] of DEFAULT_GLOBALS) {
		if (await has(marker)) defaults.forEach(addDefault);
	}
	if (!globals.has(ALWAYS_GLOBAL)) {
		globals.set(ALWAYS_GLOBAL, "detector-default");
	}
	const hasModule = ((await view.dir("")) ?? []).some((e: RawTreeEntry) =>
		e.name === "cue.mod" && e.type === "tree"
	);
	fact("has:cue.mod", hasModule ? "1" : "0");
	if (hasModule) addDefault(MODULE_GLOB);
	// A truncated walk may have missed projects: every path is global.
	if (found.truncated) globals.set("**", "detector-default");
	const globalFiles = [...globals.entries()]
		.map(([glob, source]) => ({ glob, source }))
		.sort((a, b) => a.glob < b.glob ? -1 : 1);
	return {
		projects,
		globalFiles,
		manifestsTreeSha: await sha256Hex(
			canonicalJson([...facts.entries()].sort(([a], [b]) => a < b ? -1 : 1)),
		),
		detector: "tartan",
		fidelity: "scan",
		skipped: found.skipped,
		warnings: found.warnings,
		...(found.truncated ? { truncated: true } : {}),
		packages: found.packages,
	};
};
