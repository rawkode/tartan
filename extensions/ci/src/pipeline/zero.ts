// Zero-config CI: with no pipeline in the repository's package `tartan` at the
// change's base (no `extensions: "tartan.ci": settings: pipeline`), one `test`
// job per affected project using the detected command, plus an install job for
// Node workspaces. Nothing detected → no jobs ("no CI configured").
//
// K13: the test scripts are policy. For a Node project the command is the
// literal `scripts.test` of its `package.json` **at the base on trunk**,
// run with the workspace's `node_modules/.bin` on PATH (what `npm test`
// does), never `npm test`, which would run the lane's own copy. Cargo, Go and
// Deno commands come from the detector, not from a script file.

import type { Project } from "@tartan/contract";
import type { Pipeline, PipelineJob } from "./schema.ts";
import { PIPELINE_TIMEOUT_DEFAULT_MS } from "./schema.ts";

/** One project's zero-config test command, resolved at the base. */
export type ZeroProject = {
	readonly name: string;
	readonly root: string;
	readonly run: string;
	/** The working directory ("" = repo root). */
	readonly cwd: string;
	readonly node: boolean;
	/** The file the command was read from (a policy file, K13). */
	readonly scriptFile?: string;
};

export type ZeroConfig = {
	readonly projects: readonly ZeroProject[];
	/** Install command when a Node workspace is present. */
	readonly install?: string;
	/** A single-package repo's own `scripts.test` (no workspace detected). */
	readonly root?: ZeroProject;
};

const NODE_SOURCES = new Set(["pnpm-workspace", "npm-workspaces"]);

/** POSIX single-quoting. */
export const shellQuote = (s: string): string =>
	`'${s.replaceAll("'", "'\\''")}'`;

/** The base's `scripts.test` run as npm would, from `cwd` (repo-relative). */
export const nodeScriptCommand = (script: string, cwd: string): string => {
	const depth = cwd === "" ? 0 : cwd.split("/").length;
	const up = depth === 0 ? "" : `/${"../".repeat(depth).replace(/\/$/, "")}`;
	const bins = depth === 0
		? `$PWD/node_modules/.bin`
		: `$PWD/node_modules/.bin:$PWD${up}/node_modules/.bin`;
	return `PATH="${bins}:$PATH" sh -c ${shellQuote(script)}`;
};

/** `scripts.test` of a package.json text, or null. */
export const testScriptOf = (packageJson: string | null): string | null => {
	if (packageJson === null) return null;
	try {
		const pkg = JSON.parse(packageJson) as unknown;
		if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
			return null;
		}
		const scripts = (pkg as { scripts?: unknown }).scripts;
		if (scripts === null || typeof scripts !== "object") return null;
		const test = (scripts as { test?: unknown }).test;
		return typeof test === "string" && test.trim() !== "" ? test : null;
	} catch {
		return null;
	}
};

/**
 * The zero-config set from the base graph. `packageJsonAt(path)` reads a
 * file **at the base** (null when absent); it is called for Node projects'
 * manifests and, with no projects, for the root `package.json`.
 */
export const zeroConfigOf = async (
	projects: readonly Project[],
	packageJsonAt: (path: string) => Promise<string | null>,
	rootFiles: {
		readonly pnpmLock: boolean;
		/** The repo has projects (when `projects` is a filtered subset). */
		readonly workspace?: boolean;
	},
): Promise<ZeroConfig> => {
	const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
	// Manifests are read concurrently (one RPC each), then assembled in order.
	const scripts = await Promise.all(sorted.map(async (p) => {
		if (p.testCmd === undefined || !NODE_SOURCES.has(p.source)) return null;
		const file = p.manifestPath ??
			(p.root === "" ? "package.json" : `${p.root}/package.json`);
		return { file, script: testScriptOf(await packageJsonAt(file)) };
	}));
	const out: ZeroProject[] = [];
	let install: string | undefined;
	sorted.forEach((p, i) => {
		if (p.testCmd === undefined) return;
		if (NODE_SOURCES.has(p.source)) {
			const found = scripts[i];
			if (found === null || found.script === null) return;
			install ??= p.source === "pnpm-workspace"
				? "pnpm install --frozen-lockfile"
				: "npm ci";
			out.push({
				name: p.name,
				root: p.root,
				run: nodeScriptCommand(found.script, p.root),
				cwd: p.root,
				node: true,
				scriptFile: found.file,
			});
		} else {
			out.push({
				name: p.name,
				root: p.root,
				run: p.testCmd,
				cwd: p.source === "cargo" ? "" : p.root,
				node: false,
			});
		}
	});
	if (!(rootFiles.workspace ?? projects.length > 0)) {
		const script = testScriptOf(await packageJsonAt("package.json"));
		if (script !== null) {
			return {
				projects: [],
				install: rootFiles.pnpmLock
					? "pnpm install --frozen-lockfile"
					: "npm install",
				root: {
					name: "",
					root: "",
					run: nodeScriptCommand(script, ""),
					cwd: "",
					node: true,
					scriptFile: "package.json",
				},
			};
		}
	}
	return { projects: out, ...(install ? { install } : {}) };
};

/**
 * The zero-config set as a pipeline, so one planner handles both: an
 * `install` job (when Node projects exist) and one `test` job pinned to each
 * project, planned only when that project is affected.
 */
export const zeroPipeline = (zero: ZeroConfig): Pipeline => {
	const jobs: PipelineJob[] = [];
	if (zero.install) {
		jobs.push({
			id: "install",
			run: zero.install,
			needs: [],
			optional: false,
			env: {},
		});
	}
	if (zero.root) {
		jobs.push({
			id: "test",
			run: zero.root.run,
			needs: zero.install ? ["install"] : [],
			optional: false,
			env: {},
		});
	}
	zero.projects.forEach((p, i) => {
		jobs.push({
			id: `test-${i + 1}`,
			name: "test",
			project: p.name,
			run: p.run,
			needs: p.node && zero.install ? ["install"] : [],
			...(p.cwd !== "" ? { cwd: p.cwd } : {}),
			optional: false,
			env: {},
		});
	});
	const all = jobs.map((j) => j.id);
	return {
		timeoutMs: PIPELINE_TIMEOUT_DEFAULT_MS,
		jobs,
		on: { change: all, land: all, push: { branches: [], jobs: [] } },
		lanes: { ci: "on-submit" },
	};
};
